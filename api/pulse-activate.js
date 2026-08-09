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

    if (!supabaseUrl || !supabaseSecretKey) {
      console.error(
        "Missing Supabase environment variables."
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

    // Validate license-key format.
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

    // Basic sanity check on machine fingerprint.
    if (
      machineFingerprint.length < 16 ||
      machineFingerprint.length > 512
    ) {
      return res.status(400).json({
        ok: false,
        error: "Invalid machine fingerprint",
      });
    }

    // Never store the raw machine fingerprint.
    const machineHash =
      crypto
        .createHash("sha256")
        .update(
          machineFingerprint,
          "utf8"
        )
        .digest("hex");

    // Find the license.
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

    /*
      If this license is already bound
      to a machine, only that same machine
      may continue using it.
    */
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

      return res.status(200).json({
        ok: true,
        activated: true,
        already_activated: true,
        license_id: license.id,
        seat_number: license.seat_number,
        status: license.status,
      });
    }

    /*
      First activation.

      The PATCH only succeeds while
      machine_id is NULL. This prevents
      two machines from claiming the same
      seat at the same time.
    */
    const activatedLicense =
      await bindLicenseToMachine(
        supabaseUrl,
        supabaseSecretKey,
        license.id,
        machineHash,
        machineName
      );

    // Add activation to audit/history table.
    await recordActivation(
      supabaseUrl,
      supabaseSecretKey,
      license.pulse_order_id,
      machineHash,
      machineName
    );

    return res.status(200).json({
      ok: true,
      activated: true,
      already_activated: false,
      license_id: activatedLicense.id,
      seat_number: activatedLicense.seat_number,
      status: activatedLicense.status,
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
    console.warn(
      "Activation has no pulse_order_id."
    );

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