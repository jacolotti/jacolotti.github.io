import crypto from "crypto";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const webhookSecret =
      process.env.PADDLE_WEBHOOK_SECRET;

    const pulsePriceId =
      process.env.PADDLE_PULSE_PRICE_ID;

    const supabaseUrl =
      process.env.SUPABASE_URL;

    const supabaseSecretKey =
      process.env.SUPABASE_SECRET_KEY;

    if (
      !webhookSecret ||
      !pulsePriceId ||
      !supabaseUrl ||
      !supabaseSecretKey
    ) {
      console.error(
        "Missing required server environment variables."
      );

      return res.status(500).json({
        error: "Server configuration error",
      });
    }

    const signatureHeader =
      req.headers["paddle-signature"];

    if (
      !signatureHeader ||
      typeof signatureHeader !== "string"
    ) {
      return res.status(400).json({
        error: "Missing Paddle-Signature header",
      });
    }

    const rawBodyBuffer =
      await readRawBody(req);

    const rawBody =
      rawBodyBuffer.toString("utf8");

    if (
      !verifyPaddleSignature(
        rawBody,
        signatureHeader,
        webhookSecret
      )
    ) {
      console.warn(
        "Rejected Paddle webhook: invalid signature."
      );

      return res.status(401).json({
        error: "Invalid webhook signature",
      });
    }

    let event;

    try {
      event = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({
        error: "Invalid JSON payload",
      });
    }

    // Only fulfill completed transactions.
    if (
      event.event_type !==
      "transaction.completed"
    ) {
      return res.status(200).json({
        received: true,
        ignored: true,
        event_type:
          event.event_type || null,
      });
    }

    const transaction =
      event.data || {};

    const items =
      Array.isArray(transaction.items)
        ? transaction.items
        : [];

    // Find Colotti Pulse items.
    const pulseItems =
      items.filter((item) => {
        const priceId =
          item?.price?.id ||
          item?.price_id ||
          null;

        return priceId === pulsePriceId;
      });

    if (pulseItems.length === 0) {
      console.log(
        "Completed transaction does not contain Colotti Pulse."
      );

      return res.status(200).json({
        received: true,
        ignored: true,
        reason:
          "No Colotti Pulse price in transaction",
        transaction_id:
          transaction.id || null,
      });
    }

    // Add up purchased seats.
    const seats =
      pulseItems.reduce(
        (total, item) => {
          const quantity =
            Number(
              item?.quantity || 0
            );

          return (
            total +
            (
              Number.isFinite(quantity)
                ? quantity
                : 0
            )
          );
        },
        0
      );

    if (
      !Number.isInteger(seats) ||
      seats < 1 ||
      seats > 25
    ) {
      console.error(
        "Invalid Pulse seat quantity:",
        seats
      );

      return res.status(400).json({
        error:
          "Invalid Pulse seat quantity",
      });
    }

    if (!transaction.id) {
      return res.status(400).json({
        error:
          "Missing Paddle transaction ID",
      });
    }

    const amountTotal =
      transaction?.details?.totals?.total
        ? Number(
            transaction.details.totals.total
          )
        : null;

    const orderRecord = {
      paddle_transaction_id:
        transaction.id,

      paddle_event_id:
        event.event_id || null,

      paddle_customer_id:
        transaction.customer_id || null,

      customer_email: null,
      company_name: null,

      paddle_price_id:
        pulsePriceId,

      seats_purchased:
        seats,

      currency_code:
        transaction.currency_code ||
        null,

      amount_total:
        Number.isFinite(amountTotal)
          ? amountTotal
          : null,

      status: "active",

      purchased_at:
        transaction.updated_at ||
        event.occurred_at ||
        new Date().toISOString(),
    };

    const databaseResult =
      await savePulseOrder(
        supabaseUrl,
        supabaseSecretKey,
        orderRecord
      );

    console.log(
      "COLOTTI_PULSE_PAID_ORDER",
      JSON.stringify({
        ...orderRecord,
        database:
          databaseResult.status,
      })
    );

    return res.status(200).json({
      received: true,
      verified: true,
      pulse_order: true,
      transaction_id:
        transaction.id,
      seats,
      database:
        databaseResult.status,
    });

  } catch (error) {
    console.error(
      "Paddle webhook error:",
      error
    );

    return res.status(500).json({
      error:
        "Webhook processing failed",
    });
  }
}


async function savePulseOrder(
  supabaseUrl,
  supabaseSecretKey,
  orderRecord
) {
  const url =
    `${supabaseUrl}/rest/v1/pulse_orders`;

  const response =
    await fetch(url, {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        apikey:
          supabaseSecretKey,

        Prefer:
          "return=representation",
      },

      body:
        JSON.stringify(
          orderRecord
        ),
    });

  /*
    paddle_transaction_id has a UNIQUE
    constraint.

    If Paddle retries the same webhook,
    Supabase will reject the duplicate.
    We treat that as already processed
    instead of creating extra seats.
  */
  if (response.status === 409) {
    console.log(
      "Duplicate Paddle transaction ignored:",
      orderRecord.paddle_transaction_id
    );

    return {
      status:
        "already_processed",
    };
  }

  const responseText =
    await response.text();

  if (!response.ok) {
    console.error(
      "Supabase order insert failed:",
      response.status,
      responseText
    );

    throw new Error(
      "Failed to save Pulse order"
    );
  }

  let data = null;

  if (responseText) {
    try {
      data =
        JSON.parse(
          responseText
        );
    } catch {
      data = null;
    }
  }

  return {
    status: "created",
    data,
  };
}


function verifyPaddleSignature(
  rawBody,
  signatureHeader,
  secret
) {
  const parts =
    signatureHeader.split(";");

  let timestamp = null;
  const signatures = [];

  for (const part of parts) {
    const separator =
      part.indexOf("=");

    if (separator === -1) {
      continue;
    }

    const key =
      part
        .slice(0, separator)
        .trim();

    const value =
      part
        .slice(separator + 1)
        .trim();

    if (key === "ts") {
      timestamp = value;
    }

    if (key === "h1") {
      signatures.push(value);
    }
  }

  if (
    !timestamp ||
    signatures.length === 0
  ) {
    return false;
  }

  const timestampNumber =
    Number(timestamp);

  if (
    !Number.isFinite(
      timestampNumber
    )
  ) {
    return false;
  }

  const nowSeconds =
    Math.floor(
      Date.now() / 1000
    );

  const ageSeconds =
    Math.abs(
      nowSeconds -
      timestampNumber
    );

  if (ageSeconds > 5) {
    console.warn(
      "Rejected Paddle webhook: timestamp outside tolerance."
    );

    return false;
  }

  const signedPayload =
    `${timestamp}:${rawBody}`;

  const expectedSignature =
    crypto
      .createHmac(
        "sha256",
        secret
      )
      .update(
        signedPayload,
        "utf8"
      )
      .digest("hex");

  return signatures.some(
    (receivedSignature) =>
      timingSafeHexEqual(
        expectedSignature,
        receivedSignature
      )
  );
}


function timingSafeHexEqual(
  expectedHex,
  receivedHex
) {
  try {
    const expected =
      Buffer.from(
        expectedHex,
        "hex"
      );

    const received =
      Buffer.from(
        receivedHex,
        "hex"
      );

    if (
      expected.length !==
      received.length
    ) {
      return false;
    }

    return crypto.timingSafeEqual(
      expected,
      received
    );

  } catch {
    return false;
  }
}


function readRawBody(req) {
  return new Promise(
    (resolve, reject) => {
      const chunks = [];

      req.on(
        "data",
        (chunk) => {
          chunks.push(
            Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk)
          );
        }
      );

      req.on(
        "end",
        () => {
          resolve(
            Buffer.concat(
              chunks
            )
          );
        }
      );

      req.on(
        "error",
        reject
      );
    }
  );
}