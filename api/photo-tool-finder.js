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
    const { imageBase64, hint = "" } = req.body;

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
                text: `
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

Return the best category for the image.

Category rules:

1. welding
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

2. pneumatics
Use for air cylinders, pneumatic valves, regulators, FRLs, air tubing, fittings, manifolds, flow controls, gauges, vacuum cups, pneumatic grippers, and air prep components.

If tubing, push-to-connect fittings, air ports, or regulator knobs are visible, prefer pneumatics.

3. plc_electrical
Use for PLCs, IO cards, relays, safety relays, terminal blocks, sensors, photoeyes, prox switches, HMIs, VFDs, control cabinets, wiring, connectors, fuses, breakers, and electrical panels.

If wires, terminals, IO modules, or control devices are visible, prefer plc_electrical.

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
- Cylindrical does not mean motor.
- Copper industrial part usually means welding unless another function is obvious.
- Air tubing/fittings usually means pneumatics.
- Wires/terminals usually means plc_electrical.
- Structural metal without controls, air, welding, or motion usually means machine_design.

Return JSON only.
`
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
      primary_confidence: parsed.primary_confidence ?? 0,
      primary_url: routeMap[primary],
      secondary_category: secondary,
      secondary_confidence: parsed.secondary_confidence ?? 0,
      secondary_url: routeMap[secondary],
      reason: parsed.reason || "",
      visible_clues: parsed.visible_clues || []
    });

  } catch (err) {
    console.error("API ERROR:", err);
    return res.status(500).json({
      error: err.message || "Unknown error"
    });
  }
}
