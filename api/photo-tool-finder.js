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

    let classification = await classifyImage({
      imageBase64,
      hint,
      validCategories,
      retryMode: false
    });

    let retryUsed = false;

    if (
      classification.primary_category === "unknown" ||
      normalizeConfidence(classification.primary_confidence) < 0.6
    ) {
      retryUsed = true;

      const retryHint = [
        hint,
        "industrial automation equipment",
        "look for PLC terminals, labels, sensors, pneumatics, weld tooling, motors, robots, machine frames"
      ].filter(Boolean).join(" | ");

      const retryClassification = await classifyImage({
        imageBase64,
        hint: retryHint,
        validCategories,
        retryMode: true
      });

      if (
        normalizeConfidence(retryClassification.primary_confidence) >
        normalizeConfidence(classification.primary_confidence)
      ) {
        classification = retryClassification;
      }
    }

    const primary = validCategories.includes(classification.primary_category)
      ? classification.primary_category
      : "unknown";

    const secondary = validCategories.includes(classification.secondary_category)
      ? classification.secondary_category
      : "unknown";

    const visibleClues = Array.isArray(classification.visible_clues)
      ? classification.visible_clues
      : [];

    return res.status(200).json({
      primary_category: primary,
      primary_confidence: normalizeConfidence(classification.primary_confidence),
      primary_url: routeMap[primary],
      secondary_category: secondary,
      secondary_confidence: normalizeConfidence(classification.secondary_confidence),
      secondary_url: routeMap[secondary],
      reason: classification.reason || "",
      visible_clues: visibleClues,
      suggested_links: buildSuggestedLinks(primary, visibleClues),
      retry_used: retryUsed
    });

  } catch (err) {
    console.error("API ERROR:", err);
    return res.status(500).json({
      error: err.message || "Unknown error"
    });
  }
}

async function classifyImage({ imageBase64, hint, validCategories, retryMode }) {
  const prompt = `
You are classifying industrial automation photos for a website router.

Prioritize FUNCTION over shape.

${retryMode ? "This is a second-pass classification. Be more decisive if industrial clues are visible." : ""}

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

Confidence must be a decimal between 0 and 1. Example: 0.92, not 92.

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
    throw new Error("OpenAI request failed");
  }

  let parsed = null;

  if (data.output?.[0]?.content?.[0]?.json) {
    parsed = data.output[0].content[0].json;
  }

  if (!parsed) {
    const rawText =
      data.output_text ||
      data.output?.[0]?.content?.find(c => c.type === "output_text")?.text ||
      null;

    if (!rawText) {
      console.error("NO MODEL OUTPUT:", data);

      return {
        primary_category: "unknown",
        primary_confidence: 0,
        secondary_category: "unknown",
        secondary_confidence: 0,
        reason: "Model returned no output.",
        visible_clues: []
      };
    }

    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      console.error("BAD JSON FROM MODEL:", rawText);

      return {
        primary_category: "unknown",
        primary_confidence: 0,
        secondary_category: "unknown",
        secondary_confidence: 0,
        reason: "Model returned invalid JSON.",
        visible_clues: []
      };
    }
  }

  return parsed;
}

function buildSuggestedLinks(category, visibleClues) {
  const clueText = Array.isArray(visibleClues)
    ? visibleClues.join(" ").toLowerCase()
    : "";

  const links = {
    plc_electrical: [
      { label: "PLC / Electrical Hub", url: "/plc-electrical.html", reason: "Main PLC and controls section" },
      { label: "PLC Inputs Not Working", url: "/plc-inputs-not-working.html", reason: "For sensors, input cards, and field wiring" },
      { label: "PLC Outputs Not Working", url: "/plc-outputs-not-working.html", reason: "For output cards, relays, and solenoids" },
      { label: "PLC Communication Troubleshooting", url: "/plc-communication-troubleshooting.html", reason: "For Ethernet/IP, device communication, and network issues" }
    ],
    pneumatics: [
      { label: "Pneumatics Hub", url: "/pneumatics.html", reason: "Main air cylinder and pneumatic tools section" },
      { label: "Pneumatic Force Calculator", url: "/pneumatic.html", reason: "For cylinder force and bore sizing" },
      { label: "Air Consumption Calculator", url: "/air-consumption.html", reason: "For cylinder air use and compressor demand" },
      { label: "Air Line Size Calculator", url: "/air-line-size-calculator.html", reason: "For tubing and pressure drop checks" }
    ],
    welding: [
      { label: "Welding Hub", url: "/welding.html", reason: "Main resistance welding section" },
      { label: "Spot Weld Calculator", url: "/spot-weld-calculator.html", reason: "For weld force, time, and current checks" },
      { label: "Projection Weld Calculator", url: "/projection-weld-calculator.html", reason: "For projection weld setup review" },
      { label: "Coolant Flow Calculator", url: "/coolant-flow-calculator.html", reason: "For weld gun and electrode cooling checks" }
    ],
    robotics: [
      { label: "Robotics Hub", url: "/robotics.html", reason: "Main robot and EOAT section" },
      { label: "Robot Cycle Time Calculator", url: "/robot.html", reason: "For cycle time and movement estimates" },
      { label: "Robot Reach Calculator", url: "/robot-reach-calculator.html", reason: "For reach and layout checks" },
      { label: "Robot Payload Calculator", url: "/robot-payload-calculator.html", reason: "For payload and EOAT checks" }
    ],
    motors_motion: [
      { label: "Motors / Motion Hub", url: "/motors-motion.html", reason: "Main motors and motion section" },
      { label: "Motor Calculator", url: "/motor.html", reason: "For motor sizing and power checks" },
      { label: "Conveyor Speed Calculator", url: "/conveyor-speed.html", reason: "For belt and conveyor speed checks" },
      { label: "Gear Ratio Calculator", url: "/gear-ratio.html", reason: "For gearbox and speed reduction checks" }
    ],
    machine_design: [
      { label: "Machine Design Hub", url: "/machine-design.html", reason: "Main mechanical design section" },
      { label: "Beam Deflection Calculator", url: "/beam-deflection-calculator.html", reason: "For frame and beam stiffness checks" },
      { label: "Bolt Shear / Joint Separation", url: "/bolt-shear-joint-separation-calculator.html", reason: "For bolted joint checks" },
      { label: "Weld Size Calculator", url: "/weld-size-calculator.html", reason: "For structural weld sizing checks" }
    ],
    unknown: [
      { label: "Automation Help", url: "/automation-help.html", reason: "Start here when the image is unclear" },
      { label: "Automation Calculators", url: "/automation-calculators.html", reason: "Browse all tools" }
    ]
  };

  let selected = links[category] || links.unknown;

  if (category === "plc_electrical") {
    if (clueText.includes("sensor") || clueText.includes("input")) {
      selected = [
        links.plc_electrical[1],
        links.plc_electrical[0],
        links.plc_electrical[3],
        links.plc_electrical[2]
      ];
    }

    if (clueText.includes("ethernet") || clueText.includes("communication") || clueText.includes("network")) {
      selected = [
        links.plc_electrical[3],
        links.plc_electrical[0],
        links.plc_electrical[1],
        links.plc_electrical[2]
      ];
    }
  }

  if (category === "welding") {
    if (clueText.includes("coolant") || clueText.includes("water") || clueText.includes("electrode")) {
      selected = [
        links.welding[3],
        links.welding[0],
        links.welding[1],
        links.welding[2]
      ];
    }
  }

  if (category === "pneumatics") {
    if (clueText.includes("cylinder")) {
      selected = [
        links.pneumatics[1],
        links.pneumatics[2],
        links.pneumatics[3],
        links.pneumatics[0]
      ];
    }
  }

  return selected.slice(0, 4);
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
