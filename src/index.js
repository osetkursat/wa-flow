// src/index.js
import express from "express";
import axios from "axios";

const app = express();

// Meta webhook POST'ları JSON gelir
app.use(express.json());

// Sağlık ve root (Render loglarını temizler)
app.get("/", (_, res) => res.status(200).send("ok"));
app.get("/health", (_, res) => res.status(200).send("ok"));

// 1) Webhook doğrulama (Meta verify)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const expected = process.env.WA_VERIFY_TOKEN;

  if (mode === "subscribe" && token === expected) {
    return res.status(200).send(String(challenge));
  }
  return res.sendStatus(403);
});

// 2) Webhook mesaj alma (asıl olay)
app.post("/webhook", async (req, res) => {
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;

    // "messages" yoksa (status/read vb.) sessizce geç
    const msg = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;

    // Text dışında gelebilecekleri de yakala (buton/list)
    const text =
      msg.text?.body ||
      msg.button?.text ||
      msg.interactive?.button_reply?.title ||
      msg.interactive?.list_reply?.title ||
      "";

    console.log("INCOMING MESSAGE", { from, text, type: msg.type });

    // Basit demo akış
    const reply = buildReply(text);

    // Cevap gönder
    await sendText(from, reply);

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook handler error:", err?.response?.data || err?.message || err);
    // Meta tekrar tekrar denemesin diye 200 dönmek daha iyi
    return res.sendStatus(200);
  }
});

// Basit akış: "sipariş nerede" -> sipariş no iste, no gelirse demo cevap
function buildReply(text) {
  const t = (text || "").toLowerCase().trim();

  // 4+ haneli bir sipariş numarası yakala
  const m = t.match(/\b\d{4,}\b/);
  if (m) {
    const orderNo = m[0];
    return (
      `Sipariş no: ${orderNo}\n` +
      `Kontrol ediyorum. (Şimdilik demo akış)\n` +
      `İstersen “kargo firması” ve “takip linki” de ekleyebilirim.`
    );
  }

  if (t.includes("sipariş") || t.includes("kargo") || t.includes("nerede")) {
    return "Sipariş takibi için sipariş numaranı yazar mısın? (Örn: 123456)";
  }

  return "Merhaba! Sipariş takibi için “Siparişim nerede” yazabilir ya da sipariş numaranı gönderebilirsin.";
}

// WhatsApp'a mesaj gönderme
async function sendText(to, body) {
  const phoneNumberId = process.env.WA_PHONE_NUMBER_ID; // örn: 944975768692341
  const token = process.env.WA_TOKEN;

  if (!phoneNumberId || !token) {
    console.log("Missing env: WA_PHONE_NUMBER_ID or WA_TOKEN");
    return;
  }

  const url = `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body },
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );
}

// Render port
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));
