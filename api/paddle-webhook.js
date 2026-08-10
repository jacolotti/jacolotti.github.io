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

    const paddleApiKey =
      process.env.PADDLE_API_KEY;

    const supabaseUrl =
      process.env.SUPABASE_URL;

    const supabaseSecretKey =
      process.env.SUPABASE_SECRET_KEY;

    if (
      !webhookSecret ||
      !pulsePriceId ||
      !paddleApiKey ||
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

    const pulseItems =
      items.filter((item) => {
        const priceId =
          item?.price?.id ||
          item?.price_id ||
          null;

        return priceId === pulsePriceId;
      });

    if (pulseItems.length === 0) {
      return res.status(200).json({
        received: true,
        ignored: true,
        reason:
          "No Colotti Pulse price in transaction",
        transaction_id:
          transaction.id || null,
      });
    }

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

    /*
      Retrieve the Paddle customer so we can
      permanently store their email with the order.
    */
    let paddleCustomer = null;

    if (transaction.customer_id) {
      try {
        paddleCustomer =
          await getPaddleCustomer(
            paddleApiKey,
            transaction.customer_id
          );
      } catch (error) {
        /*
          Do not throw away a paid order just because
          customer lookup temporarily failed.

          We log the problem and continue fulfillment.
        */
        console.error(
          "Paddle customer lookup error:",
          error
        );
      }
    }

    const orderRecord = {
      paddle_transaction_id:
        transaction.id,

      paddle_event_id:
        event.event_id || null,

      paddle_customer_id:
        transaction.customer_id || null,

      customer_email:
        paddleCustomer?.email || null,

      /*
        Paddle customer objects may not always
        contain a company name. Keep this nullable
        until we add business lookup or checkout
        custom data later.
      */
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

    let licenseKeys = [];

    if (
      databaseResult.status ===
      "created"
    ) {
      licenseKeys =
        await createPulseLicenses(
          supabaseUrl,
          supabaseSecretKey,
          databaseResult.order,
          seats
        );
    }

    console.log(
      "COLOTTI_PULSE_PAID_ORDER",
      JSON.stringify({
        transaction_id:
          transaction.id,

        customer_email:
          orderRecord.customer_email,

        seats,

        database:
          databaseResult.status,

        licenses_created:
          licenseKeys.length,
      })
    );

    return res.status(200).json({
      received: true,
      verified: true,
      pulse_order: true,

      transaction_id:
        transaction.id,

      customer_email_found:
        Boolean(
          orderRecord.customer_email
        ),

      seats,

      database:
        databaseResult.status,

      licenses_created:
        licenseKeys.length,
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


async function getPaddleCustomer(
  paddleApiKey,
  customerId
) {
  const url =
    `https://sandbox-api.paddle.com/customers/${encodeURIComponent(customerId)}`;

  const response =
    await fetch(url, {
      method: "GET",

      headers: {
        Authorization:
          `Bearer ${paddleApiKey}`,

        "Paddle-Version":
          "1",

        "Content-Type":
          "application/json",
      },
    });

  const responseText =
    await response.text();

  if (!response.ok) {
    console.error(
      "Paddle customer lookup failed:",
      response.status,
      responseText
    );

    throw new Error(
      "Failed to retrieve Paddle customer"
    );
  }

  let parsed;

  try {
    parsed =
      JSON.parse(
        responseText
      );
  } catch {
    throw new Error(
      "Invalid Paddle customer response"
    );
  }

  return parsed?.data || null;
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
    paddle_transaction_id is UNIQUE.

    Paddle may retry webhook delivery.
    A retry must not create another order
    or additional license seats.
  */
  if (response.status === 409) {
    console.log(
      "Duplicate Paddle transaction ignored:",
      orderRecord.paddle_transaction_id
    );

    return {
      status:
        "already_processed",

      order: null,
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

  let data = [];

  if (responseText) {
    try {
      data =
        JSON.parse(
          responseText
        );
    } catch {
      data = [];
    }
  }

  const order =
    Array.isArray(data) &&
    data.length > 0
      ? data[0]
      : null;

  if (!order?.id) {
    throw new Error(
      "Supabase did not return created Pulse order"
    );
  }

  return {
    status: "created",
    order,
  };
}


async function createPulseLicenses(
  supabaseUrl,
  supabaseSecretKey,
  order,
  seats
) {
  const rows = [];

  for (
    let seatNumber = 1;
    seatNumber <= seats;
    seatNumber += 1
  ) {
    rows.push({
      license_key:
        generateLicenseKey(),

      pulse_order_id:
        order.id,

      paddle_transaction_id:
        order.paddle_transaction_id,

      seat_number:
        seatNumber,

      status:
        "active",
    });
  }

  const url =
    `${supabaseUrl}/rest/v1/pulse_licenses`;

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
        JSON.stringify(rows),
    });

  const responseText =
    await response.text();

  if (!response.ok) {
    console.error(
      "Supabase license insert failed:",
      response.status,
      responseText
    );

    throw new Error(
      "Failed to create Pulse licenses"
    );
  }

  let data = [];

  if (responseText) {
    try {
      data =
        JSON.parse(
          responseText
        );
    } catch {
      data = [];
    }
  }

  if (
    !Array.isArray(data) ||
    data.length !== seats
  ) {
    throw new Error(
      "Unexpected number of Pulse licenses created"
    );
  }

  return data.map(
    (row) => row.license_key
  );
}


function generateLicenseKey() {
  const hex =
    crypto
      .randomBytes(8)
      .toString("hex")
      .toUpperCase();

  return (
    "PULSE-" +
    hex.slice(0, 4) + "-" +
    hex.slice(4, 8) + "-" +
    hex.slice(8, 12) + "-" +
    hex.slice(12, 16)
  );
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