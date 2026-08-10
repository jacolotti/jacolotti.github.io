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

    const brevoApiKey =
      process.env.BREVO_API_KEY;

    const brevoSenderEmail =
      process.env.BREVO_SENDER_EMAIL;

    const brevoSenderName =
      process.env.BREVO_SENDER_NAME;

    if (
      !webhookSecret ||
      !pulsePriceId ||
      !paddleApiKey ||
      !supabaseUrl ||
      !supabaseSecretKey ||
      !brevoApiKey ||
      !brevoSenderEmail ||
      !brevoSenderName
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
            Number(item?.quantity || 0);

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

    const paddleCustomer =
      transaction.customer_id
        ? await getPaddleCustomer(
            paddleApiKey,
            transaction.customer_id
          )
        : null;

    if (!paddleCustomer?.email) {
      throw new Error(
        "Paddle customer email was not available"
      );
    }

    const customerEmail =
      paddleCustomer.email
        .trim()
        .toLowerCase();

    const customerName =
      paddleCustomer.name
        ? String(
            paddleCustomer.name
          ).trim()
        : "";

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

      customer_email:
        customerEmail,

      company_name:
        null,

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

      status:
        "active",

      purchased_at:
        transaction.updated_at ||
        event.occurred_at ||
        new Date().toISOString(),
    };

    const databaseResult =
      await saveOrGetPulseOrder(
        supabaseUrl,
        supabaseSecretKey,
        orderRecord
      );

    let order =
      databaseResult.order;

    if (!order?.id) {
      throw new Error(
        "Pulse order could not be resolved"
      );
    }

    if (
      !order.customer_email &&
      customerEmail
    ) {
      order =
        await updateOrderCustomerEmail(
          supabaseUrl,
          supabaseSecretKey,
          order.id,
          customerEmail
        );
    }

    let licenseRows;

    if (
      databaseResult.status ===
      "created"
    ) {
      licenseRows =
        await createPulseLicenses(
          supabaseUrl,
          supabaseSecretKey,
          order,
          seats
        );
    } else {
      licenseRows =
        await getPulseLicenses(
          supabaseUrl,
          supabaseSecretKey,
          transaction.id
        );
    }

    if (
      !Array.isArray(licenseRows) ||
      licenseRows.length !== seats
    ) {
      throw new Error(
        "Unexpected Pulse license count"
      );
    }

    licenseRows.sort(
      (a, b) =>
        Number(a.seat_number) -
        Number(b.seat_number)
    );

    let emailStatus =
      "already_sent";

    if (!order.license_email_sent_at) {
      const emailResult =
        await sendLicenseEmail({
          brevoApiKey,
          senderEmail:
            brevoSenderEmail,
          senderName:
            brevoSenderName,
          customerEmail,
          customerName,
          transactionId:
            transaction.id,
          licenseRows,
        });

      await markLicenseEmailSent(
        supabaseUrl,
        supabaseSecretKey,
        order.id,
        emailResult.messageId
      );

      emailStatus =
        "sent";
    }

    console.log(
      "COLOTTI_PULSE_PAID_ORDER",
      JSON.stringify({
        transaction_id:
          transaction.id,

        customer_email:
          customerEmail,

        seats,

        database:
          databaseResult.status,

        licenses_ready:
          licenseRows.length,

        email_status:
          emailStatus,
      })
    );

    return res.status(200).json({
      received:
        true,

      verified:
        true,

      pulse_order:
        true,

      transaction_id:
        transaction.id,

      customer_email_found:
        true,

      seats,

      database:
        databaseResult.status,

      licenses_ready:
        licenseRows.length,

      email_status:
        emailStatus,
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

        Accept:
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
      JSON.parse(responseText);
  } catch {
    throw new Error(
      "Invalid Paddle customer response"
    );
  }

  return parsed?.data || null;
}


async function saveOrGetPulseOrder(
  supabaseUrl,
  supabaseSecretKey,
  orderRecord
) {
  const url =
    `${supabaseUrl}/rest/v1/pulse_orders`;

  const response =
    await fetch(url, {
      method: "POST",

      headers:
        supabaseHeaders(
          supabaseSecretKey,
          {
            Prefer:
              "return=representation",
          }
        ),

      body:
        JSON.stringify(orderRecord),
    });

  if (response.status === 409) {
    const existingOrder =
      await getPulseOrderByTransaction(
        supabaseUrl,
        supabaseSecretKey,
        orderRecord.paddle_transaction_id
      );

    if (!existingOrder) {
      throw new Error(
        "Existing Pulse order could not be found"
      );
    }

    return {
      status:
        "already_processed",
      order:
        existingOrder,
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
        JSON.parse(responseText);
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
    status:
      "created",
    order,
  };
}


async function getPulseOrderByTransaction(
  supabaseUrl,
  supabaseSecretKey,
  transactionId
) {
  const url =
    `${supabaseUrl}/rest/v1/pulse_orders` +
    `?paddle_transaction_id=eq.${encodeURIComponent(transactionId)}` +
    `&select=*`;

  const response =
    await fetch(url, {
      method: "GET",
      headers:
        supabaseHeaders(
          supabaseSecretKey
        ),
    });

  const responseText =
    await response.text();

  if (!response.ok) {
    throw new Error(
      "Failed to retrieve existing Pulse order"
    );
  }

  let rows = [];

  if (responseText) {
    try {
      rows =
        JSON.parse(responseText);
    } catch {
      rows = [];
    }
  }

  return (
    Array.isArray(rows) &&
    rows.length > 0
      ? rows[0]
      : null
  );
}


async function updateOrderCustomerEmail(
  supabaseUrl,
  supabaseSecretKey,
  orderId,
  customerEmail
) {
  const url =
    `${supabaseUrl}/rest/v1/pulse_orders` +
    `?id=eq.${encodeURIComponent(orderId)}`;

  const response =
    await fetch(url, {
      method: "PATCH",

      headers:
        supabaseHeaders(
          supabaseSecretKey,
          {
            Prefer:
              "return=representation",
          }
        ),

      body:
        JSON.stringify({
          customer_email:
            customerEmail,

          updated_at:
            new Date().toISOString(),
        }),
    });

  const responseText =
    await response.text();

  if (!response.ok) {
    throw new Error(
      "Failed to update Pulse customer email"
    );
  }

  let rows = [];

  if (responseText) {
    try {
      rows =
        JSON.parse(responseText);
    } catch {
      rows = [];
    }
  }

  return rows[0];
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

      headers:
        supabaseHeaders(
          supabaseSecretKey,
          {
            Prefer:
              "return=representation",
          }
        ),

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
        JSON.parse(responseText);
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

  return data;
}


async function getPulseLicenses(
  supabaseUrl,
  supabaseSecretKey,
  transactionId
) {
  const url =
    `${supabaseUrl}/rest/v1/pulse_licenses` +
    `?paddle_transaction_id=eq.${encodeURIComponent(transactionId)}` +
    `&select=id,license_key,pulse_order_id,paddle_transaction_id,seat_number,status`;

  const response =
    await fetch(url, {
      method: "GET",
      headers:
        supabaseHeaders(
          supabaseSecretKey
        ),
    });

  const responseText =
    await response.text();

  if (!response.ok) {
    throw new Error(
      "Failed to retrieve Pulse licenses"
    );
  }

  let rows = [];

  if (responseText) {
    try {
      rows =
        JSON.parse(responseText);
    } catch {
      rows = [];
    }
  }

  return Array.isArray(rows)
    ? rows
    : [];
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


async function sendLicenseEmail({
  brevoApiKey,
  senderEmail,
  senderName,
  customerEmail,
  customerName,
  transactionId,
  licenseRows,
}) {
  const licenseListHtml =
    licenseRows
      .map(
        (license) => `
          <div style="
            margin:12px 0;
            padding:14px 16px;
            border:1px solid #d9e3ee;
            border-radius:8px;
            background:#f7f9fc;
          ">
            <div style="
              font-size:12px;
              color:#5d6b79;
              margin-bottom:5px;
            ">
              Seat ${escapeHtml(
                String(
                  license.seat_number
                )
              )}
            </div>

            <div style="
              font-family:Consolas,Monaco,monospace;
              font-size:18px;
              font-weight:700;
              color:#16202a;
            ">
              ${escapeHtml(
                license.license_key
              )}
            </div>
          </div>
        `
      )
      .join("");

  const greeting =
    customerName
      ? `Hello ${escapeHtml(customerName)},`
      : "Hello,";

  const htmlContent = `
<!DOCTYPE html>
<html>
<body style="
  margin:0;
  padding:0;
  background:#f5f7fb;
  font-family:Arial,Helvetica,sans-serif;
  color:#16202a;
">

<div style="
  max-width:680px;
  margin:0 auto;
  padding:28px 18px;
">

<div style="
  background:#ffffff;
  border:1px solid #d9e3ee;
  border-radius:12px;
  padding:28px;
">

<h2>Colotti Pulse</h2>

<p>${greeting}</p>

<p>
Thank you for purchasing Colotti Pulse.
Your license ${
    licenseRows.length === 1
      ? "is"
      : "keys are"
  } ready.
</p>

<h3>Your License ${
    licenseRows.length === 1
      ? "Key"
      : "Keys"
  }</h3>

${licenseListHtml}

<h3>Activation</h3>

<ol>
  <li>Install and open Colotti Pulse.</li>
  <li>Enter one license key in the activation window.</li>
  <li>Click <strong>Activate Online</strong>.</li>
  <li>
    After initial activation, Pulse can operate
    offline on that licensed computer.
  </li>
</ol>

${
  licenseRows.length > 1
    ? `
<p>
<strong>Multiple seats:</strong>
Use a different license key on each computer.
</p>
`
    : ""
}

<p>
Product page:<br>
<a href="https://automationcalculators.net/colotti-pulse.html">
automationcalculators.net/colotti-pulse.html
</a>
</p>

<p>
Keep this email for your records.
</p>

<p>
Colotti Automation LLC<br>
Colotti Pulse
</p>

<hr>

<small>
Paddle transaction:
${escapeHtml(transactionId)}
</small>

</div>
</div>

</body>
</html>
  `.trim();

  const response =
    await fetch(
      "https://api.brevo.com/v3/smtp/email",
      {
        method:
          "POST",

        headers: {
          Accept:
            "application/json",

          "Content-Type":
            "application/json",

          "api-key":
            brevoApiKey,
        },

        body:
          JSON.stringify({
            sender: {
              name:
                senderName,

              email:
                senderEmail,
            },

            to: [
              {
                email:
                  customerEmail,

                ...(customerName
                  ? {
                      name:
                        customerName,
                    }
                  : {}),
              },
            ],

            replyTo: {
              email:
                senderEmail,

              name:
                senderName,
            },

            subject:
              licenseRows.length === 1
                ? "Your Colotti Pulse License"
                : "Your Colotti Pulse Licenses",

            htmlContent,

            tags: [
              "colotti-pulse-license",
            ],
          }),
      }
    );

  const responseText =
    await response.text();

  if (!response.ok) {
    console.error(
      "Brevo license email failed:",
      response.status,
      responseText
    );

    throw new Error(
      "Failed to send Pulse license email"
    );
  }

  const parsed =
    responseText
      ? JSON.parse(responseText)
      : {};

  if (!parsed.messageId) {
    throw new Error(
      "Brevo did not return a messageId"
    );
  }

  return {
    messageId:
      parsed.messageId,
  };
}


async function markLicenseEmailSent(
  supabaseUrl,
  supabaseSecretKey,
  orderId,
  messageId
) {
  const url =
    `${supabaseUrl}/rest/v1/pulse_orders` +
    `?id=eq.${encodeURIComponent(orderId)}`;

  const response =
    await fetch(url, {
      method:
        "PATCH",

      headers:
        supabaseHeaders(
          supabaseSecretKey
        ),

      body:
        JSON.stringify({
          license_email_sent_at:
            new Date().toISOString(),

          license_email_message_id:
            messageId || null,

          updated_at:
            new Date().toISOString(),
        }),
    });

  if (!response.ok) {
    throw new Error(
      "Failed to record Pulse license email"
    );
  }
}


function supabaseHeaders(
  secretKey,
  extra = {}
) {
  return {
    apikey:
      secretKey,

    "Content-Type":
      "application/json",

    ...extra,
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


function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
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
            Buffer.concat(chunks)
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