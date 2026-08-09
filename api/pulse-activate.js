import crypto from "crypto";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      ok: false,
      error: "Method not allowed",
    });
  }

  try {
    const supabaseUrl =
      process.env.SUPABASE_URL;

    const supabaseSecretKey =
      process.env.SUPABASE_SECRET_KEY;

    const privateKeyPem =
      process.env.PULSE_PRIVATE_KEY_PEM;

    if (
      !supabaseUrl ||
      !supabaseSecretKey ||
      !privateKeyPem
    ) {
      console.error(
        "Missing activation server environment variables."
      );

      return res.status(500).json({
        ok: false,
        error: "Server configuration error",
      });
    }

    const {
      license_key,
      machine_fingerprint,
      machine_name = "",
    } = req.body || {};

    const licenseKey =
      String(license_key || "")
        .trim()
        .toUpperCase();

    const machineFingerprint =
      String(machine_fingerprint || "")
        .trim();

    const machineName =
      String(machine_name || "")
        .trim()
        .slice(0, 120);

    if (
      !/^PULSE-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(
        licenseKey
      )
    ) {
      return res.status(400).json({
        ok: false,
        error: "Invalid license key format",
      });
    }

    if (
      machineFingerprint.length < 16 ||
      machineFingerprint.length > 512
    ) {
      return res.status(400).json({
        ok: false,
        error: "Invalid machine fingerprint",
      });
    }

    const machineHash =
      crypto
        .createHash("sha256")
        .update(
          machineFingerprint,
          "utf8"
        )
        .digest("hex");

    const license =
      await getLicense(
        supabaseUrl,
        supabaseSecretKey,
        licenseKey
      );

    if (!license) {
      return res.status(404).json({
        ok: false,
        error: "License not found",
      });
    }

    if (license.status !== "active") {
      return res.status(403).json({
        ok: false,
        error: "License is not active",
      });
    }

    let activatedLicense;
    let alreadyActivated = false;

    if (license.machine_id) {
      if (license.machine_id !== machineHash) {
        return res.status(409).json({
          ok: false,
          error:
            "This license is already activated on another computer",
        });
      }

      await touchExistingActivation(
        supabaseUrl,
        supabaseSecretKey,
        license,
        machineName
      );

      activatedLicense = license;
      alreadyActivated = true;

    } else {
      activatedLicense =
        await bindLicenseToMachine(
          supabaseUrl,
          supabaseSecretKey,
          license.id,
          machineHash,
          machineName
        );

      await recordActivation(
        supabaseUrl,
        supabaseSecretKey,
        license.pulse_order_id,
        machineHash,
        machineName
      );
    }

    const order =
      await getOrder(
        supabaseUrl,
        supabaseSecretKey,
        activatedLicense.pulse_order_id
      );

    if (!order) {
      throw new Error(
        "License order record was not found"
      );
    }

    const licenseDocument =
      createSignedLicenseDocument({
        privateKeyPem,
        order,
        license: activatedLicense,
        machineHash,
      });

    return res.status(200).json({
      ok: true,
      activated: true,
      already_activated:
        alreadyActivated,

      license_id:
        activatedLicense.id,

      seat_number:
        activatedLicense.seat_number,

      status:
        activatedLicense.status,

      license_document:
        licenseDocument,
    });

  } catch (error) {
    console.error(
      "Pulse activation error:",
      error
    );

    return res.status(500).json({
      ok: false,
      error: "Activation failed",
    });
  }
}


function supabaseHeaders(
  secretKey,
  extra = {}
) {
  return {
    apikey: secretKey,
    "Content-Type": "application/json",
    ...extra,
  };
}


async function getLicense(
  supabaseUrl,
  secretKey,
  licenseKey
) {
  const url =
    `${supabaseUrl}/rest/v1/pulse_licenses` +
    `?license_key=eq.${encodeURIComponent(licenseKey)}` +
    `&select=id,pulse_order_id,paddle_transaction_id,seat_number,status,machine_id,machine_name,activated_at,last_verified_at`;

  const response =
    await fetch(url, {
      method: "GET",
      headers:
        supabaseHeaders(secretKey),
    });

  if (!response.ok) {
    const text =
      await response.text();

    console.error(
      "Supabase license lookup failed:",
      response.status,
      text
    );

    throw new Error(
      "License lookup failed"
    );
  }

  const rows =
    await response.json();

  if (
    !Array.isArray(rows) ||
    rows.length === 0
  ) {
    return null;
  }

  return rows[0];
}


async function getOrder(
  supabaseUrl,
  secretKey,
  orderId
) {
  const url =
    `${supabaseUrl}/rest/v1/pulse_orders` +
    `?id=eq.${encodeURIComponent(orderId)}` +
    `&select=id,paddle_transaction_id,paddle_customer_id,customer_email,company_name,seats_purchased,status,purchased_at`;

  const response =
    await fetch(url, {
      method: "GET",
      headers:
        supabaseHeaders(secretKey),
    });

  if (!response.ok) {
    const text =
      await response.text();

    console.error(
      "Supabase order lookup failed:",
      response.status,
      text
    );

    throw new Error(
      "Order lookup failed"
    );
  }

  const rows =
    await response.json();

  if (
    !Array.isArray(rows) ||
    rows.length === 0
  ) {
    return null;
  }

  return rows[0];
}


async function bindLicenseToMachine(
  supabaseUrl,
  secretKey,
  licenseId,
  machineHash,
  machineName
) {
  const url =
    `${supabaseUrl}/rest/v1/pulse_licenses` +
    `?id=eq.${encodeURIComponent(licenseId)}` +
    `&machine_id=is.null`;

  const now =
    new Date().toISOString();

  const response =
    await fetch(url, {
      method: "PATCH",

      headers:
        supabaseHeaders(
          secretKey,
          {
            Prefer:
              "return=representation",
          }
        ),

      body:
        JSON.stringify({
          machine_id:
            machineHash,

          machine_name:
            machineName || null,

          activated_at:
            now,

          last_verified_at:
            now,

          updated_at:
            now,
        }),
    });

  if (!response.ok) {
    const text =
      await response.text();

    console.error(
      "Supabase activation bind failed:",
      response.status,
      text
    );

    throw new Error(
      "Could not bind license"
    );
  }

  const rows =
    await response.json();

  if (
    !Array.isArray(rows) ||
    rows.length !== 1
  ) {
    throw new Error(
      "License was activated concurrently"
    );
  }

  return rows[0];
}


async function touchExistingActivation(
  supabaseUrl,
  secretKey,
  license,
  machineName
) {
  const url =
    `${supabaseUrl}/rest/v1/pulse_licenses` +
    `?id=eq.${encodeURIComponent(license.id)}`;

  const now =
    new Date().toISOString();

  const response =
    await fetch(url, {
      method: "PATCH",

      headers:
        supabaseHeaders(secretKey),

      body:
        JSON.stringify({
          machine_name:
            machineName ||
            license.machine_name ||
            null,

          last_verified_at:
            now,

          updated_at:
            now,
        }),
    });

  if (!response.ok) {
    const text =
      await response.text();

    console.error(
      "Supabase verification update failed:",
      response.status,
      text
    );

    throw new Error(
      "Could not update verification time"
    );
  }
}


async function recordActivation(
  supabaseUrl,
  secretKey,
  orderId,
  machineHash,
  machineName
) {
  if (!orderId) {
    return;
  }

  const url =
    `${supabaseUrl}/rest/v1/pulse_activations`;

  const response =
    await fetch(url, {
      method: "POST",

      headers:
        supabaseHeaders(
          secretKey,
          {
            Prefer:
              "resolution=ignore-duplicates,return=minimal",
          }
        ),

      body:
        JSON.stringify({
          order_id:
            orderId,

          machine_fingerprint_hash:
            machineHash,

          machine_name:
            machineName || null,
        }),
    });

  if (
    !response.ok &&
    response.status !== 409
  ) {
    const text =
      await response.text();

    console.error(
      "Supabase activation audit insert failed:",
      response.status,
      text
    );

    throw new Error(
      "Could not record activation"
    );
  }
}


function canonicalPayload(data) {
  const ordered = {};

  for (
    const key of
    Object.keys(data).sort()
  ) {
    ordered[key] =
      data[key];
  }

  return JSON.stringify(ordered);
}


function createSignedLicenseDocument({
  privateKeyPem,
  order,
  license,
  machineHash,
}) {
  const customer =
    order.company_name ||
    order.customer_email ||
    order.paddle_customer_id ||
    "Colotti Pulse Customer";

  const issued =
    new Date()
      .toISOString()
      .slice(0, 10);

  const payload = {
    product:
      "Colotti Pulse Base",

    customer,

    license_id:
      license.id,

    license_type:
      "perpetual",

    seats:
      1,

    issued,

    machine_id:
      machineHash,
  };

  const canonical =
    canonicalPayload(payload);

  const privateKey =
    crypto.createPrivateKey(
      privateKeyPem
    );

  const signature =
    crypto.sign(
      null,
      Buffer.from(
        canonical,
        "utf8"
      ),
      privateKey
    );

  return {
    payload,

    signature:
      signature.toString("base64"),
  };
}