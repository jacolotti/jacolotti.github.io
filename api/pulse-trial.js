import crypto from "crypto";


const TRIAL_DAYS = 7;


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
        "Missing trial server environment variables."
      );

      return res.status(500).json({
        ok: false,
        error: "Server configuration error",
      });
    }


    const {
      machine_fingerprint,
      machine_name = "",
    } = req.body || {};


    const machineFingerprint =
      String(machine_fingerprint || "")
        .trim();

    const machineName =
      String(machine_name || "")
        .trim()
        .slice(0, 120);


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


    const existingTrial =
      await getExistingTrial(
        supabaseUrl,
        supabaseSecretKey,
        machineHash
      );


    if (existingTrial) {
      const now =
        new Date();

      const expiresAt =
        new Date(
          existingTrial.expires_at
        );

      if (
        Number.isNaN(
          expiresAt.getTime()
        )
      ) {
        throw new Error(
          "Stored trial expiration is invalid"
        );
      }


      if (now >= expiresAt) {
        return res.status(403).json({
          ok: false,
          error:
            "The free trial for this computer has already expired.",
        });
      }


      const licenseDocument =
        createSignedTrialDocument({
          privateKeyPem,
          trial: existingTrial,
          machineHash,
        });


      return res.status(200).json({
        ok: true,
        trial: true,
        already_started: true,

        trial_id:
          existingTrial.id,

        started_at:
          existingTrial.started_at,

        expires_at:
          existingTrial.expires_at,

        license_document:
          licenseDocument,
      });
    }


    const trial =
      await createTrial(
        supabaseUrl,
        supabaseSecretKey,
        machineHash,
        machineName
      );


    const licenseDocument =
      createSignedTrialDocument({
        privateKeyPem,
        trial,
        machineHash,
      });


    return res.status(200).json({
      ok: true,
      trial: true,
      already_started: false,

      trial_id:
        trial.id,

      started_at:
        trial.started_at,

      expires_at:
        trial.expires_at,

      license_document:
        licenseDocument,
    });

  } catch (error) {
    console.error(
      "Pulse trial error:",
      error
    );

    return res.status(500).json({
      ok: false,
      error: "Trial activation failed",
    });
  }
}


function supabaseHeaders(
  secretKey,
  extra = {}
) {
  return {
    apikey: secretKey,
    Authorization:
      `Bearer ${secretKey}`,
    "Content-Type":
      "application/json",
    ...extra,
  };
}


async function getExistingTrial(
  supabaseUrl,
  secretKey,
  machineHash
) {
  const url =
    `${supabaseUrl}/rest/v1/pulse_trials` +
    `?machine_id=eq.${encodeURIComponent(machineHash)}` +
    `&select=id,machine_id,machine_name,customer_email,started_at,expires_at,created_at,updated_at`;


  const response =
    await fetch(url, {
      method: "GET",

      headers:
        supabaseHeaders(
          secretKey
        ),
    });


  if (!response.ok) {
    const text =
      await response.text();

    console.error(
      "Supabase trial lookup failed:",
      response.status,
      text
    );

    throw new Error(
      "Trial lookup failed"
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


async function createTrial(
  supabaseUrl,
  secretKey,
  machineHash,
  machineName
) {
  const startedAt =
    new Date();

  const expiresAt =
    new Date(
      startedAt.getTime() +
      TRIAL_DAYS *
      24 *
      60 *
      60 *
      1000
    );


  const url =
    `${supabaseUrl}/rest/v1/pulse_trials`;


  const response =
    await fetch(url, {
      method: "POST",

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

          customer_email:
            null,

          started_at:
            startedAt.toISOString(),

          expires_at:
            expiresAt.toISOString(),

          updated_at:
            startedAt.toISOString(),
        }),
    });


  if (!response.ok) {
    const text =
      await response.text();

    console.error(
      "Supabase trial insert failed:",
      response.status,
      text
    );


    /*
     * The machine_id column is UNIQUE.
     *
     * If two requests for the same computer
     * arrive at nearly the same time, one
     * insert may lose the race.
     *
     * In that case, retrieve the existing
     * trial rather than issuing another one.
     */
    if (response.status === 409) {
      const existingTrial =
        await getExistingTrial(
          supabaseUrl,
          secretKey,
          machineHash
        );

      if (existingTrial) {
        return existingTrial;
      }
    }


    throw new Error(
      "Could not create trial"
    );
  }


  const rows =
    await response.json();


  if (
    !Array.isArray(rows) ||
    rows.length !== 1
  ) {
    throw new Error(
      "Trial creation returned an unexpected result"
    );
  }


  return rows[0];
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

  return JSON.stringify(
    ordered
  );
}


function createSignedTrialDocument({
  privateKeyPem,
  trial,
  machineHash,
}) {
  const issued =
    new Date(
      trial.started_at
    ).toISOString();

  const expires =
    new Date(
      trial.expires_at
    ).toISOString();


  const payload = {
    product:
      "Colotti Pulse Base",

    customer:
      "Colotti Pulse Trial",

    license_id:
      trial.id,

    license_type:
      "trial",

    seats:
      1,

    issued,

    expires,

    machine_id:
      machineHash,
  };


  const canonical =
    canonicalPayload(
      payload
    );


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
      signature.toString(
        "base64"
      ),
  };
}