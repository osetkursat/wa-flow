import axios from "axios";

export async function sendText(toPhone, text) {
  const url = `https://graph.facebook.com/${process.env.GRAPH_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to: toPhone,
      type: "text",
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      timeout: 15000
    }
  );
}
