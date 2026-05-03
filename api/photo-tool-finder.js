export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "https://automationcalculators.net");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { imageBase64, hint = "" } = req.body || {};

    if (!imageBase64) {
      return res.status(400).json({ error: "Missing imageBase64" });
    }

    const validCategories = [
      "welding",
      "pneumatics",
      "plc_electrical",
      "robotics",
      "motors_motion",
      "machine_design",
      "unknown"
    ];

    const routeMap = {
      welding: "/welding.html",
      pneumatics: "/pneumatics.html",
      plc_electrical: "/plc-electrical.html",
      robotics: "/robotics.html",
      motors_motion: "/motors-motion.html",
      machine_design: "/machine-design.html",
      unknown: "/automation-help.html"
    };

    const prompt = `
You are classifying industrial automation photos for a website router.

Prioritize FUNCTION over shape.

User hint:
${hint || "No hint provided"}

Allowed categories:
- welding
- pneumatics
- plc_electrical
- robotics
- motors_motion
- machine_design
- unknown

Return the best site category for the image.

Category rules:

1. plc_electrical
Use for PLCs, programmable controllers, IO cards, relay modules, safety relays, terminal blocks, sensors, photoeyes, prox switches, HMIs, VFDs, control cabinets, wiring, connectors, fuses, breakers, power supplies, industrial network modules, and electrical panels.

Important PLC/electrical clues:
- Allen-Bradley, Siemens, Omron, Keyence, Mitsubishi, Schneider, Phoenix Contact, Pilz, Banner, IFM, Wago, Beckhoff
- PLC model labels such as MicroLogix, CompactLogix, ControlLogix, SLC, GuardLogix
- rows of screw terminals
- removable terminal blocks
- LCD screen on a controller
- serial, Ethernet, or communication ports
- DC input/output labels
- relay output labels
- terminal labels such as COM, IN, OUT, 24V, 0V, L1, L2, NC, NO

If the image clearly shows a PLC or controller, choose plc_electrical with high confidence.

2. welding
Use for weld systems, weld tooling, weld electrodes, weld caps, copper tips, resistance welding parts, spot weld tooling, projection weld tooling, weld guns, weld holders, weld shunts, weld transformers, weld cables, weld fixtures, weld nests, and robot-mounted welding tools.

Important welding clues:
- copper-colored parts
- rounded or tapered copper tips
- threaded weld caps
- water-cooled weld components
- parts that appear to contact sheet metal during resistance welding
- weld gun arms
- electrode holders
- tooling near a weld point

If uncertain between welding and motors_motion, choose welding.
If uncertain between welding and robotics, choose welding when the weld tool is the main subject.

3. pneumatics
Use for air cylinders, pneumatic valves, regulators, FRLs, air tubing, fittings, manifolds, flow controls, gauges, vacuum cups, pneumatic grippers, and air prep components.

Important pneumatics clues:
- blue, black, or clear air tubing
- push-to-connect fittings
- air ports
- regulators or pressure gauges
- solenoid valve manifolds
- cylinder rods and cylinder bodies

4. robotics
Use for robot arms, robot bases, robot wrists, teach pendants, robot dress packs, EOAT, robot grippers, and robot-mounted tools.

If the robot arm itself is the main subject, choose robotics.
If the tool on the robot is clearly a weld tool, choose welding.

5. motors_motion
Use only when the image clearly shows motors, gearboxes, conveyors, belts, pulleys, sprockets, couplings, shafts, bearings, linear rails, servo systems, or motion components.

Do NOT classify a cylindrical object as motors_motion unless motor or motion-system features are visible.

6. machine_design
Use for frames, brackets, plates, gussets, supports, guards, fixtures, bolted joints, welded frames, structural members, machine bases, and mechanical mounting hardware.

7. unknown
Use only if the image is not industrial or cannot reasonably be classified.

Tie breakers:
- A PLC/controller with terminals, screen, or IO labels is plc_electrical.
- Cylindrical does not mean motor.
- Copper industrial weld-contact parts usually mean welding.
- Air tubing/fittings usually mean pneumatics.
- Wires/terminals usually mean plc_electrical.
- Structural metal without controls, air, welding, or motion usually means machine_design.

Return JSON only.
`;

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: prompt
              },
              {
                type: "input_image",
                image_url: `data:image/jpeg;base64,${imageBase64}`
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "industrial_photo_classification",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                primary_category: {
                  type: "string",
                  enum: validCategories
                },
                primary_confidence: {
                  type: "number"
                },
                secondary_category: {
                  type: "string",
                  enum: validCategories
                },
                secondary_confidence: {
                  type: "number"
                },
                reason: {
                  type: "string"
                },
                visible_clues: {
                  type: "array",
                  items: {
                    type: "string"
                  }
                }
              },
              required: [
                "primary_category",
                "primary_confidence",
                "secondary_category",
                "secondary_confidence",
                "reason",
                "visible_clues"
              ]
            }
          }
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("OpenAI error:", data);
      return res.status(response.status).json({
        error: "OpenAI request failed",
        details: data
      });
    }

    let parsed;

    try {
      parsed = JSON.parse(data.output_text || "{}");
    } catch (parseErr) {
      console.error("JSON parse error:", parseErr, data);
      return res.status(500).json({
        error: "Could not parse model response",
        raw: data.output_text || data
      });
    }

    const primary = validCategories.includes(parsed.primary_category)
      ? parsed.primary_category
      : "unknown";

    const secondary = validCategories.includes(parsed.secondary_category)
      ? parsed.secondary_category
      : "unknown";

    return res.status(200).json({
      primary_category: primary,
      primary_confidence: normalizeConfidence(parsed.primary_confidence),
      primary_url: routeMap[primary],
      secondary_category: secondary,
      secondary_confidence: normalizeConfidence(parsed.secondary_confidence),
      secondary_url: routeMap[secondary],
      reason: parsed.reason || "",
      visible_clues: Array.isArray(parsed.visible_clues) ? parsed.visible_clues : []
    });

  } catch (err) {
    console.error("API ERROR:", err);
    return res.status(500).json({
      error: err.message || "Unknown error"
    });
  }
}

function normalizeConfidence(value) {
  const num = Number(value || 0);

  if (Number.isNaN(num)) {
    return 0;
  }

  if (num > 1) {
    return Math.min(num / 100, 1);
  }

  return Math.max(0, Math.min(num, 1));
}
