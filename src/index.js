import "dotenv/config";
import express from "express";
import axios from "axios";
import crypto from "crypto";

import {
  ensureSchema,
  getOrCreateCustomerByPhone,
  getOrCreateOpenConversation,
  insertMessage,
  getFlowState,
  setFlowState,
  clearFlowState,
  saveOAuthState,
  consumeOAuthState,
  upsertIdeaSoftToken,
  getIdeaSoftToken,
} from "./db.js";

const app = express();
app.use(express.json());

app.get("/", (_, res) => res.status(200).send("ok"));
app.get("/health", (_, res) => res.status(200).send("ok"));

const PORT = process.env.PORT || 10000;

function isOrderCode13(text) {
  const s = String(text || "").trim().replace(/\s+/g, "");
  return /^[A-Za-z0-9]{13}$/.test(s);
}

function isTrackIntent(text) {
  const t = String(text || "").toLowerCase();
  return t.includes("sipari") && (t.includes("nerede") || t.includes("takip"));
}

async function sendWhatsAppText(to, body) {
  const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
  const WA_TOKEN = process.env.WA_TOKEN;
  const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v22.0";
  if (!WA_PHONE_NUMBER_ID || !WA_TOKEN) throw new Error("Missing env: WA_PHONE_NUMBER_ID or WA_TOKEN");

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;
  await axios.post(
    url,
    { messaging_product: "whatsapp", to, type: "text", text: { body } },
    { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
  );
}

function publicBase() {
  return process.env.PUBLIC_BASE_URL || "https://wa-flow.onrender.com";
}

// --- Meta verify ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- Meta incoming ---
app.post("/webhook", async (req, res) => {
  try {
    await ensureSchema();

    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg) return res.status(200).json({ ok: true });

    const from = msg.from;
    const text = msg.text?.body || "";
    const name = value?.contacts?.[0]?.profile?.name || null;

    console.log("INCOMING MESSAGE", { from, text, type: msg.type });

    const customer = await getOrCreateCustomerByPhone(from, name);
    const convId = await getOrCreateOpenConversation(customer.id);

    await insertMessage(convId, "in", text, req.body);

    const flow = await getFlowState(customer.id);

    if (isTrackIntent(text)) {
      await setFlowState(customer.id, "order_tracking", "await_order_code", {});
      await sendWhatsAppText(
        from,
        "Sipariş takibi için 13 karakterli sipariş kodunu tek parça yazar mısın? (Harf+rakam olabilir)\nÖrn: 694d66facfb7a"
      );
      await insertMessage(convId, "out", "asked order code", null);
      return res.status(200).json({ ok: true });
    }

    if (flow.flow_name === "order_tracking" && flow.step === "await_order_code") {
      const code = String(text || "").trim().replace(/\s+/g, "");
      if (!isOrderCode13(code)) {
        await sendWhatsAppText(from, "13 karakterli (harf+rakam olabilir) sipariş kodunu tek parça gönderir misin?");
        return res.status(200).json({ ok: true });
      }

      // IdeaSoft token var mı?
      const tok = await getIdeaSoftToken();
      if (!tok?.access_token) {
        await sendWhatsAppText(from, `IdeaSoft bağlantısı yok. Şu linkten bağlayalım:\n${publicBase()}/ideasoft/connect`);
        return res.status(200).json({ ok: true });
      }

      const statusText = await lookupIdeaSoftOrder(code);
      await sendWhatsAppText(from, statusText);
      await clearFlowState(customer.id);
      return res.status(200).json({ ok: true });
    }

    await sendWhatsAppText(
      from,
      "Merhaba! Sipariş takibi için 'Siparişim nerede' yazabilir veya 13 karakterli sipariş kodunu gönderebilirsin."
    );

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.log("Webhook handler error:", e?.response?.data || e?.message || e);
    return res.status(200).json({ ok: true });
  }
});

// --- IdeaSoft OAuth connect ---
app.get("/ideasoft/connect", async (req, res) => {
  try {
    await ensureSchema();

    const authUrl = process.env.IDEASOFT_AUTH_URL;
    const clientId = process.env.IDEASOFT_CLIENT_ID;
    const redirectUri = process.env.IDEASOFT_REDIRECT_URI;

    if (!authUrl || !clientId || !redirectUri) {
      return res.status(500).send("Missing IdeaSoft env: IDEASOFT_AUTH_URL / IDEASOFT_CLIENT_ID / IDEASOFT_REDIRECT_URI");
    }

    const state = crypto.randomBytes(16).toString("hex");
    await saveOAuthState("ideasoft", state);

    const u = new URL(authUrl);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);

    return res.redirect(u.toString());
  } catch (e) {
    return res.status(500).send(`Connect failed: ${e?.message || e}`);
  }
});

// --- IdeaSoft OAuth callback ---
app.get("/ideasoft/callback", async (req, res) => {
  try {
    await ensureSchema();

    const code = req.query.code?.toString();
    const state = req.query.state?.toString();

    if (!code) return res.status(400).send("Missing code");
    if (!state) return res.status(400).send("Missing state");

    const ok = await consumeOAuthState("ideasoft", state);
    if (!ok) return res.status(400).send("Invalid state");

    const tokenUrl = process.env.IDEASOFT_TOKEN_URL;
    const clientId = process.env.IDEASOFT_CLIENT_ID;
    const clientSecret = process.env.IDEASOFT_CLIENT_SECRET;
    const redirectUri = process.env.IDEASOFT_REDIRECT_URI;

    if (!tokenUrl || !clientId || !clientSecret || !redirectUri) {
      return res.status(500).send("Missing IdeaSoft env: TOKEN_URL/CLIENT_ID/CLIENT_SECRET/REDIRECT_URI");
    }

    const form = new URLSearchParams();
    form.set("grant_type", "authorization_code");
    form.set("client_id", clientId);
    form.set("client_secret", clientSecret);
    form.set("redirect_uri", redirectUri);
    form.set("code", code);

    const r = await axios.post(tokenUrl, form.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    });

    await upsertIdeaSoftToken(r.data);
    return res.send("IdeaSoft connected ✅");
  } catch (e) {
    return res.status(500).send(`Callback failed: ${e?.response?.data ? JSON.stringify(e.response.data) : e?.message || e}`);
  }
});

// --- IdeaSoft order lookup ---
async function lookupIdeaSoftOrder(orderCode) {
  const baseUrl = process.env.IDEASOFT_BASE_URL; // https://toptansulama.myideasoft.com
  if (!baseUrl) return "IDEASOFT_BASE_URL eksik.";

  const tok = await getIdeaSoftToken();
  if (!tok?.access_token) return `IdeaSoft token yok. ${publicBase()}/ideasoft/connect`;

  const headers = { Authorization: `Bearer ${tok.access_token}`, Accept: "application/json" };

  // 1) Direkt orders/{id} dene (bazı sistemlerde çalışır)
  try {
    const r1 = await axios.get(`${baseUrl}/admin-api/orders/${encodeURIComponent(orderCode)}`, { headers, timeout: 15000 });
    const status = r1.data?.status || r1.data?.order_status || r1.data?.state || "Bilinmiyor";
    return `Sipariş: ${orderCode}\nDurum: ${status}`;
  } catch (_) {}

  // 2) LIST endpoint üzerinde muhtemel filtreler
  const tries = [
    `${baseUrl}/admin-api/orders?search=${encodeURIComponent(orderCode)}`,
    `${baseUrl}/admin-api/orders?code=${encodeURIComponent(orderCode)}`,
    `${baseUrl}/admin-api/orders?orderNumber=${encodeURIComponent(orderCode)}`,
    `${baseUrl}/admin-api/orders?order_number=${encodeURIComponent(orderCode)}`,
  ];

  for (const u of tries) {
    try {
      const r = await axios.get(u, { headers, timeout: 15000 });
      const items = Array.isArray(r.data) ? r.data : (r.data?.data || r.data?.items || []);
      if (items && items.length) {
        const o = items[0];
        const status = o?.status || o?.order_status || o?.state || "Bilinmiyor";
        return `Sipariş: ${orderCode}\nDurum: ${status}`;
      }
    } catch (_) {}
  }

  return `Sipariş bulunamadı: ${orderCode}\nNot: Eğer bağlandıysan ama bulamıyorsa, IdeaSoft sipariş “kod” alanının API'deki ismini netleştirmemiz gerekir.`;
}

app.listen(PORT, () => console.log(`Server running on :${PORT}`));
