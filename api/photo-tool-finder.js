export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { imageBase64 } = req.body;

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
              text: "Classify this industrial image into ONE category: plc_electrical, pneumatics, robotics, motors_motion, welding, machine_design. Respond ONLY with the category."
            },
            {
              type: "input_image",
              image_base64: imageBase64
            }
          ]
        }]
      })
    });

    const data = await response.json();

// Debug log (helps us if it breaks again)
console.log("OpenAI response:", JSON.stringify(data));

const resultText =
  data.output_text ||
  data.output?.[0]?.content?.find(c => c.type === "output_text")?.text ||
  "";

    return res.status(200).json({ result: resultText });

  } catch (err) {
    console.error("API ERROR:", err);
return res.status(500).json({ error: err.message || "Unknown error" });
  }
}
