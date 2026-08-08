import crypto from "crypto";

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const webhookSecret = process.env.PADDLE_WEBHOOK_SECRET;
    const pulsePriceId = process.env.PADDLE_PULSE_PRICE_ID;

    if (!webhookSecret || !pulsePriceId) {
      console.error("Missing Paddle webhook environment variables.");
      return res.status(500).json({
        error: "Server configuration error",
      });
    }

    const signatureHeader = req.headers["paddle-signature"];

    if (!signatureHeader || typeof signatureHeader !== "string") {
      return res.status(400).json({
        error: "Missing Paddle-Signature header",
      });
    }

    const rawBodyBuffer = await readRawBody(req);
    const rawBody = rawBodyBuffer.toString("utf8");

    if (!verifyPaddleSignature(rawBody, signatureHeader, webhookSecret)) {
      console.warn("Rejected Paddle webhook: invalid signature.");

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

    // Only process completed transactions.
    if (event.event_type !== "transaction.completed") {
      return res.status(200).json({
        received: true,
        ignored: true,
        event_type: event.event_type || null,
      });
    }

    const transaction = event.data || {};
    const items = Array.isArray(transaction.items)
      ? transaction.items
      : [];

    // Find Colotti Pulse in the transaction.
    const pulseItems = items.filter((item) => {
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
        reason: "No Colotti Pulse price in transaction",
        transaction_id: transaction.id || null,
      });
    }

    // Add up the purchased seat quantity.
    const seats = pulseItems.reduce((total, item) => {
      const quantity = Number(item?.quantity || 0);

      return total + (
        Number.isFinite(quantity)
          ? quantity
          : 0
      );
    }, 0);

    if (!Number.isInteger(seats) || seats < 1 || seats > 25) {
      console.error(
        "Invalid Pulse seat quantity:",
        seats
      );

      return res.status(400).json({
        error: "Invalid Pulse seat quantity",
      });
    }

    const fulfillmentRecord = {
      event_id: event.event_id || null,
      notification_id: event.notification_id || null,
      transaction_id: transaction.id || null,
      customer_id: transaction.customer_id || null,
      status: transaction.status || null,
      currency_code: transaction.currency_code || null,
      seats,
      pulse_price_id: pulsePriceId,
      invoice_number: transaction.invoice_number || null,
      completed_at:
        transaction.updated_at ||
        event.occurred_at ||
        null,
    };

    console.log(
      "COLOTTI_PULSE_PAID_ORDER",
      JSON.stringify(fulfillmentRecord)
    );

    return res.status(200).json({
      received: true,
      verified: true,
      pulse_order: true,
      transaction_id: fulfillmentRecord.transaction_id,
      seats: fulfillmentRecord.seats,
    });

  } catch (error) {
    console.error(
      "Paddle webhook error:",
      error
    );

    return res.status(500).json({
      error: "Webhook processing failed",
    });
  }
}

function verifyPaddleSignature(
  rawBody,
  signatureHeader,
  secret
) {
  const parts = signatureHeader.split(";");

  let timestamp = null;
  const signatures = [];

  for (const part of parts) {
    const separator = part.indexOf("=");

    if (separator === -1) {
      continue;
    }

    const key = part
      .slice(0, separator)
      .trim();

    const value = part
      .slice(separator + 1)
      .trim();

    if (key === "ts") {
      timestamp = value;
    }

    if (key === "h1") {
      signatures.push(value);
    }
  }

  if (!timestamp || signatures.length === 0) {
    return false;
  }

  const timestampNumber = Number(timestamp);

  if (!Number.isFinite(timestampNumber)) {
    return false;
  }

  const nowSeconds =
    Math.floor(Date.now() / 1000);

  const ageSeconds =
    Math.abs(nowSeconds - timestampNumber);

  // Reject old/replayed webhook requests.
  if (ageSeconds > 5) {
    console.warn(
      "Rejected Paddle webhook: timestamp outside tolerance."
    );

    return false;
  }

  const signedPayload =
    `${timestamp}:${rawBody}`;

  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(signedPayload, "utf8")
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
      Buffer.from(expectedHex, "hex");

    const received =
      Buffer.from(receivedHex, "hex");

    if (expected.length !== received.length) {
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
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => {
      chunks.push(
        Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk)
      );
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", reject);
  });
}