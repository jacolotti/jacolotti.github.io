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
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    const pulsePriceId = process.env.STRIPE_PULSE_PRICE_ID;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
    const brevoApiKey = process.env.BREVO_API_KEY;
    const brevoSenderEmail = process.env.BREVO_SENDER_EMAIL;
    const brevoSenderName = process.env.BREVO_SENDER_NAME;

    if (
      !webhookSecret ||
      !stripeSecretKey ||
      !pulsePriceId ||
      !supabaseUrl ||
      !supabaseSecretKey ||
      !brevoApiKey ||
      !brevoSenderEmail ||
      !brevoSenderName
    ) {
      console.error("Missing required Stripe/Pulse environment variables.");
      return res.status(500).json({ error: "Server configuration error" });
    }

    const signatureHeader = req.headers["stripe-signature"];
    if (!signatureHeader || typeof signatureHeader !== "string") {
      return res.status(400).json({ error: "Missing Stripe-Signature header" });
    }

    const rawBodyBuffer = await readRawBody(req);
    const rawBody = rawBodyBuffer.toString("utf8");

    if (!verifyStripeSignature(rawBody, signatureHeader, webhookSecret)) {
      return res.status(401).json({ error: "Invalid webhook signature" });
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ error: "Invalid JSON payload" });
    }

    if (event.type !== "checkout.session.completed") {
      return res.status(200).json({
        received: true,
        ignored: true,
        event_type: event.type || null,
      });
    }

    const session = event.data?.object || {};

    if (!session.id) {
      return res.status(400).json({ error: "Missing Stripe Checkout Session ID" });
    }

    if (session.payment_status !== "paid") {
      return res.status(200).json({
        received: true,
        ignored: true,
        reason: "Checkout Session is not paid",
        checkout_session_id: session.id,
      });
    }

    if (session.mode !== "payment") {
      return res.status(200).json({
        received: true,
        ignored: true,
        reason: "Checkout Session is not a one-time payment",
        checkout_session_id: session.id,
      });
    }

    if (session.managed_payments?.enabled !== true) {
      return res.status(200).json({
        received: true,
        ignored: true,
        reason: "Managed Payments is not enabled",
        checkout_session_id: session.id,
      });
    }

    const lineItems = await getStripeLineItems(stripeSecretKey, session.id);
    const pulseItems = lineItems.filter((item) => item?.price?.id === pulsePriceId);

    if (pulseItems.length === 0) {
      return res.status(200).json({
        received: true,
        ignored: true,
        reason: "No Colotti Pulse price in Checkout Session",
        checkout_session_id: session.id,
      });
    }

    const seats = pulseItems.reduce((total, item) => {
      const quantity = Number(item?.quantity || 0);
      return total + (Number.isFinite(quantity) ? quantity : 0);
    }, 0);

    if (!Number.isInteger(seats) || seats < 1 || seats > 25) {
      return res.status(400).json({ error: "Invalid Pulse seat quantity" });
    }

    const customerEmail = String(
      session.customer_details?.email || session.customer_email || ""
    )
      .trim()
      .toLowerCase();

    if (!customerEmail) {
      throw new Error("Stripe customer email was not available");
    }

    const customerName = String(session.customer_details?.name || "").trim();

    const orderRecord = {
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id:
        typeof session.payment_intent === "string" ? session.payment_intent : null,
      stripe_customer_id:
        typeof session.customer === "string" ? session.customer : null,
      stripe_price_id: pulsePriceId,
      customer_email: customerEmail,
      company_name: null,
      seats_purchased: seats,
      currency_code: session.currency || null,
      amount_total: Number.isFinite(Number(session.amount_total))
        ? Number(session.amount_total)
        : null,
      status: "active",
      purchased_at: session.created
        ? new Date(Number(session.created) * 1000).toISOString()
        : new Date().toISOString(),
    };

    const databaseResult = await saveOrGetPulseOrder(
      supabaseUrl,
      supabaseSecretKey,
      orderRecord
    );

    let order = databaseResult.order;
    if (!order?.id) {
      throw new Error("Pulse order could not be resolved");
    }

    if (!order.customer_email && customerEmail) {
      order = await updateOrderCustomerEmail(
        supabaseUrl,
        supabaseSecretKey,
        order.id,
        customerEmail
      );
    }

    let licenseRows;
    if (databaseResult.status === "created") {
      licenseRows = await createPulseLicenses(
        supabaseUrl,
        supabaseSecretKey,
        order,
        seats
      );
    } else {
      licenseRows = await getPulseLicensesByOrder(
        supabaseUrl,
        supabaseSecretKey,
        order.id
      );
    }

    if (!Array.isArray(licenseRows) || licenseRows.length !== seats) {
      throw new Error("Unexpected Pulse license count");
    }

    licenseRows.sort((a, b) => Number(a.seat_number) - Number(b.seat_number));

    let emailStatus = "already_sent";

    if (!order.license_email_sent_at) {
      const emailResult = await sendLicenseEmail({
        brevoApiKey,
        senderEmail: brevoSenderEmail,
        senderName: brevoSenderName,
        customerEmail,
        customerName,
        transactionId: session.id,
        licenseRows,
      });

      await markLicenseEmailSent(
        supabaseUrl,
        supabaseSecretKey,
        order.id,
        emailResult.messageId
      );

      emailStatus = "sent";
    }

    console.log(
      "COLOTTI_PULSE_STRIPE_PAID_ORDER",
      JSON.stringify({
        checkout_session_id: session.id,
        customer_email: customerEmail,
        seats,
        database: databaseResult.status,
        licenses_ready: licenseRows.length,
        email_status: emailStatus,
      })
    );

    return res.status(200).json({
      received: true,
      verified: true,
      pulse_order: true,
      checkout_session_id: session.id,
      customer_email_found: true,
      seats,
      database: databaseResult.status,
      licenses_ready: licenseRows.length,
      email_status: emailStatus,
    });
  } catch (error) {
    console.error("Stripe webhook error:", error);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
}

function verifyStripeSignature(rawBody, signatureHeader, secret) {
  const values = {};

  for (const part of signatureHeader.split(",")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (!values[key]) values[key] = [];
    values[key].push(value);
  }

  const timestamp = values.t?.[0];
  const signatures = values.v1 || [];

  if (!timestamp || signatures.length === 0) return false;

  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampNumber) > 300) return false;

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(signedPayload, "utf8")
    .digest("hex");

  return signatures.some((signature) => safeEqualHex(signature, expected));
}

function safeEqualHex(a, b) {
  if (!/^[a-f0-9]+$/i.test(a) || !/^[a-f0-9]+$/i.test(b)) return false;

  const aBuffer = Buffer.from(a, "hex");
  const bBuffer = Buffer.from(b, "hex");

  if (aBuffer.length !== bBuffer.length) return false;
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

async function getStripeLineItems(stripeSecretKey, sessionId) {
  const url =
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items` +
    `?limit=100&expand[]=data.price.product`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      "Stripe-Version": "2026-02-25.preview",
      Accept: "application/json",
    },
  });

  const responseText = await response.text();

  if (!response.ok) {
    console.error("Stripe line item lookup failed:", response.status, responseText);
    throw new Error("Failed to retrieve Stripe line items");
  }

  const parsed = responseText ? JSON.parse(responseText) : {};
  return Array.isArray(parsed.data) ? parsed.data : [];
}

async function saveOrGetPulseOrder(supabaseUrl, supabaseSecretKey, orderRecord) {
  const url = `${supabaseUrl}/rest/v1/pulse_orders`;

  const response = await fetch(url, {
    method: "POST",
    headers: supabaseHeaders(supabaseSecretKey, {
      Prefer: "return=representation",
    }),
    body: JSON.stringify(orderRecord),
  });

  if (response.status === 409) {
    const existingOrder = await getPulseOrderByStripeSession(
      supabaseUrl,
      supabaseSecretKey,
      orderRecord.stripe_checkout_session_id
    );

    if (!existingOrder) {
      throw new Error("Existing Stripe Pulse order could not be found");
    }

    return {
      status: "already_processed",
      order: existingOrder,
    };
  }

  const responseText = await response.text();

  if (!response.ok) {
    console.error("Supabase Stripe order insert failed:", response.status, responseText);
    throw new Error("Failed to save Stripe Pulse order");
  }

  const data = responseText ? JSON.parse(responseText) : [];
  const order = Array.isArray(data) && data.length > 0 ? data[0] : null;

  if (!order?.id) {
    throw new Error("Supabase did not return created Stripe Pulse order");
  }

  return { status: "created", order };
}

async function getPulseOrderByStripeSession(
  supabaseUrl,
  supabaseSecretKey,
  sessionId
) {
  const url =
    `${supabaseUrl}/rest/v1/pulse_orders` +
    `?stripe_checkout_session_id=eq.${encodeURIComponent(sessionId)}` +
    `&select=*`;

  const response = await fetch(url, {
    method: "GET",
    headers: supabaseHeaders(supabaseSecretKey),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error("Failed to retrieve existing Stripe Pulse order");
  }

  const rows = responseText ? JSON.parse(responseText) : [];
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function updateOrderCustomerEmail(
  supabaseUrl,
  supabaseSecretKey,
  orderId,
  customerEmail
) {
  const url =
    `${supabaseUrl}/rest/v1/pulse_orders?id=eq.${encodeURIComponent(orderId)}`;

  const response = await fetch(url, {
    method: "PATCH",
    headers: supabaseHeaders(supabaseSecretKey, {
      Prefer: "return=representation",
    }),
    body: JSON.stringify({
      customer_email: customerEmail,
      updated_at: new Date().toISOString(),
    }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error("Failed to update Stripe Pulse customer email");
  }

  const rows = responseText ? JSON.parse(responseText) : [];
  return rows[0];
}

async function createPulseLicenses(
  supabaseUrl,
  supabaseSecretKey,
  order,
  seats
) {
  const rows = [];

  for (let seatNumber = 1; seatNumber <= seats; seatNumber += 1) {
    rows.push({
      license_key: generateLicenseKey(),
      pulse_order_id: order.id,
      seat_number: seatNumber,
      status: "active",
    });
  }

  const url = `${supabaseUrl}/rest/v1/pulse_licenses`;

  const response = await fetch(url, {
    method: "POST",
    headers: supabaseHeaders(supabaseSecretKey, {
      Prefer: "return=representation",
    }),
    body: JSON.stringify(rows),
  });

  const responseText = await response.text();

  if (!response.ok) {
    console.error("Supabase Stripe license insert failed:", response.status, responseText);
    throw new Error("Failed to create Stripe Pulse licenses");
  }

  const data = responseText ? JSON.parse(responseText) : [];

  if (!Array.isArray(data) || data.length !== seats) {
    throw new Error("Unexpected number of Stripe Pulse licenses created");
  }

  return data;
}

async function getPulseLicensesByOrder(
  supabaseUrl,
  supabaseSecretKey,
  orderId
) {
  const url =
    `${supabaseUrl}/rest/v1/pulse_licenses` +
    `?pulse_order_id=eq.${encodeURIComponent(orderId)}` +
    `&select=id,license_key,pulse_order_id,seat_number,status`;

  const response = await fetch(url, {
    method: "GET",
    headers: supabaseHeaders(supabaseSecretKey),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error("Failed to retrieve Stripe Pulse licenses");
  }

  const rows = responseText ? JSON.parse(responseText) : [];
  return Array.isArray(rows) ? rows : [];
}

function generateLicenseKey() {
  const hex = crypto.randomBytes(8).toString("hex").toUpperCase();

  return (
    "PULSE-" +
    hex.slice(0, 4) + "-" +
    hex.slice(4, 8) + "-" +
    hex.slice(8, 12) + "-" +
    hex.slice(12, 16)
  );
}

async function sendLicenseEmail({
  brevoApiKey,
  senderEmail,
  senderName,
  customerEmail,
  customerName,
  transactionId,
  licenseRows,
}) {
  const licenseListHtml = licenseRows
    .map(
      (license) => `
        <div style="margin:12px 0;padding:14px 16px;border:1px solid #d9e3ee;border-radius:8px;background:#f7f9fc;">
          <div style="font-size:12px;color:#5d6b79;margin-bottom:5px;">
            Seat ${escapeHtml(String(license.seat_number))}
          </div>
          <div style="font-family:Consolas,Monaco,monospace;font-size:18px;font-weight:700;color:#16202a;">
            ${escapeHtml(license.license_key)}
          </div>
        </div>
      `
    )
    .join("");

  const greeting = customerName
    ? `Hello ${escapeHtml(customerName)},`
    : "Hello,";

  const htmlContent = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f5f7fb;font-family:Arial,Helvetica,sans-serif;color:#16202a;">
<div style="max-width:680px;margin:0 auto;padding:28px 18px;">
<div style="background:#ffffff;border:1px solid #d9e3ee;border-radius:12px;padding:28px;">
<h2>Colotti Pulse</h2>
<p>${greeting}</p>
<p>Thank you for purchasing Colotti Pulse. Your license ${
    licenseRows.length === 1 ? "is" : "keys are"
  } ready.</p>
<h3>Your License ${licenseRows.length === 1 ? "Key" : "Keys"}</h3>
${licenseListHtml}
<h3>Activation</h3>
<ol>
  <li>Install and open Colotti Pulse.</li>
  <li>Enter one license key in the activation window.</li>
  <li>Click <strong>Activate Online</strong>.</li>
  <li>After initial activation, Pulse can operate offline on that licensed computer.</li>
</ol>
${
  licenseRows.length > 1
    ? "<p><strong>Multiple seats:</strong> Use a different license key on each computer.</p>"
    : ""
}
<p>Product page:<br><a href="https://automationcalculators.net/colotti-pulse.html">automationcalculators.net/colotti-pulse.html</a></p>
<p>Keep this email for your records.</p>
<p>Colotti Automation LLC<br>Colotti Pulse</p>
<hr>
<small>Stripe Checkout Session: ${escapeHtml(transactionId)}</small>
</div>
</div>
</body>
</html>
  `.trim();

  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "api-key": brevoApiKey,
    },
    body: JSON.stringify({
      sender: { name: senderName, email: senderEmail },
      to: [
        {
          email: customerEmail,
          ...(customerName ? { name: customerName } : {}),
        },
      ],
      replyTo: { email: senderEmail, name: senderName },
      subject:
        licenseRows.length === 1
          ? "Your Colotti Pulse License"
          : "Your Colotti Pulse Licenses",
      htmlContent,
      tags: ["colotti-pulse-license"],
    }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    console.error("Brevo Stripe license email failed:", response.status, responseText);
    throw new Error("Failed to send Stripe Pulse license email");
  }

  const parsed = responseText ? JSON.parse(responseText) : {};

  if (!parsed.messageId) {
    throw new Error("Brevo did not return a messageId");
  }

  return { messageId: parsed.messageId };
}

async function markLicenseEmailSent(
  supabaseUrl,
  supabaseSecretKey,
  orderId,
  messageId
) {
  const url =
    `${supabaseUrl}/rest/v1/pulse_orders?id=eq.${encodeURIComponent(orderId)}`;

  const response = await fetch(url, {
    method: "PATCH",
    headers: supabaseHeaders(supabaseSecretKey),
    body: JSON.stringify({
      license_email_sent_at: new Date().toISOString(),
      license_email_message_id: messageId || null,
      updated_at: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error("Supabase Stripe email status update failed:", response.status, text);
    throw new Error("Failed to mark Stripe Pulse license email sent");
  }
}

function supabaseHeaders(secretKey, extra = {}) {
  return {
    apikey: secretKey,
    Authorization: `Bearer ${secretKey}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function readRawBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}
