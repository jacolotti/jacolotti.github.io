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
    const { imageBase64 } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: "Missing imageBase64" });
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [{
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Classify this industrial image into ONE category only: plc_electrical, pneumatics, robotics, motors_motion, welding, machine_design. If the image shows weld coolant, weld hoses, weld gun cooling, water flow for a welder, or weld flow meters, return welding. Respond ONLY with the category."
            },
            {
              type: "input_image",
              image_url: `data:image/jpeg;base64,${imageBase64}`
            }
          ]
        }]
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

    const resultText =
      data.output_text ||
      data.output?.[0]?.content?.find(c => c.type === "output_text")?.text ||
      "";

    return res.status(200).json({ result: resultText.trim() });

  } catch (err) {
    console.error("API ERROR:", err);
    return res.status(500).json({ error: err.message || "Unknown error" });
  }
}
