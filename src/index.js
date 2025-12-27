// src/index.js
import express from "express";
import axios from "axios";
import {
  ensureSchema,
  getOrCreateCustomerByPhone,
  insertMessage,
  getFlowState,
  setFlowState,
  clearFlowState,
} from "./db.js";

const app = express();
app.use(express.json());

// Root + health (Render check)
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

// 2) Webhook mesaj alma
app.post("/webhook", async (req, res) => {
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;

    // Meta bazen messages yerine statuses vs yollar → sessiz geç
    const msg = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    // from bazen msg.from'da, bazen contacts[0].wa_id'da
    const from = msg.from || value?.contacts?.[0]?.wa_id;
    if (!from) return res.sendStatus(200);

    // Text dışında gelebilecekleri de yakala
    const text =
      msg.text?.body ||
      msg.button?.text ||
      msg.interactive?.button_reply?.title ||
      msg.interactive?.list_reply?.title ||
      "";

    console.log("INCOMING MESSAGE", { from, text, type: msg.type });

    // DB hazırla + müşteri/konuşma bul + inbound kaydet
    await ensureSchema();
    const { customer, conversationId } = await getOrCreateCustomerByPhone(from);

    await insertMessage(conversationId, "in", text, req.body);

    // Akışa göre cevap üret (DB'den flow_state okur)
    const reply = await buildReplyWithState(customer.id, text);

    // Outbound kaydet + gönder
    await insertMessage(conversationId, "out", reply, { sent_at: new Date().toISOString() });
    await sendText(from, reply);

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook handler error:", err?.response?.data || err?.message || err);
    // Meta retry spam yapmasın diye 200 dön
    return res.sendStatus(200);
  }
});

// Akış: sipariş sor → sipariş no bekle → no gelince demo dönüş
async function buildReplyWithState(customerId, incomingText) {
  const t = (incomingText || "").trim();
  const tlow = t.toLowerCase();

  const state = await getFlowState(customerId);

  // Sipariş no yakala (4+ hane)
  const m = tlow.match(/\b\d{4,}\b/);
  const orderNo = m?.[0];

  // Eğer sipariş no bekleyen state varsa
  if (state?.flow_name === "order_tracking" && state?.step === "await_order_no") {
    if (orderNo) {
      await clearFlowState(customerId);
      return (
        `Sipariş no: ${orderNo}\n` +
        `Kontrol ediyorum. (Şimdilik demo akış)\n` +
        `İstersen “kargo firması” ve “takip linki” de ekleyebilirim.`
      );
    }
    return "Sipariş takibi için sadece sipariş numaranı yazar mısın? (Örn: 123456)";
  }

  // Yeni akış tetikle
  if (tlow.includes("sipariş") || tlow.includes("kargo") || tlow.includes("nerede")) {
    await setFlowState(customerId, "order_tracking", "await_order_no", {
      started_at: new Date().toISOString(),
    });
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
