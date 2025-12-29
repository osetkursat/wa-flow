// src/index.js
import express from "express";
import crypto from "crypto";
import axios from "axios";
import dotenv from "dotenv";

import {
  ensureSchema,
  getOrCreateCustomer,
  startConversation,
  getFlowState,
  setFlowState,
  clearFlowState,
  getIdeaSoftTokenRow,
  upsertIdeaSoftTokenRow,
} from "./db.js";

dotenv.config();

const app = express();

// Meta webhook signature doğrulaması için RAW body lazım
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

const PORT = process.env.PORT || 10000;

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v22.0";
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_TOKEN = process.env.WA_TOKEN;
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// IdeaSoft
const IDEASOFT_AUTH_URL = process.env.IDEASOFT_AUTH_URL; // .../panel/auth
const IDEASOFT_TOKEN_URL = process.env.IDEASOFT_TOKEN_URL; // .../oauth/v2/token
const IDEASOFT_CLIENT_ID = process.env.IDEASOFT_CLIENT_ID;
const IDEASOFT_CLIENT_SECRET = process.env.IDEASOFT_CLIENT_SECRET;
const IDEASOFT_REDIRECT_URI = process.env.IDEASOFT_REDIRECT_URI;
const IDEASOFT_SCOPE = process.env.IDEASOFT_SCOPE || "admin";
const IDEASOFT_API_BASE_URL = process.env.IDEASOFT_API_BASE_URL; // https://toptansulama.myideasoft.com

function verifyMetaSignature(req) {
  if (!WEBHOOK_SECRET) return true; // dev için
  const sig = req.get("x-hub-signature-256");
  if (!sig) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", WEBHOOK_SECRET).update(req.rawBody).digest("hex");

  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return null;
}

// -------- WhatsApp send ----------
async function sendWhatsAppText(to, text) {
  if (!WA_PHONE_NUMBER_ID || !WA_TOKEN) {
    console.error("Missing env: WA_PHONE_NUMBER_ID or WA_TOKEN");
    return;
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;

  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    },
    {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );
}

// -------- IdeaSoft token helpers ----------
async function exchangeIdeaSoftCodeForToken(code) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: IDEASOFT_CLIENT_ID,
    client_secret: IDEASOFT_CLIENT_SECRET,
    redirect_uri: IDEASOFT_REDIRECT_URI,
    code,
  });

  const r = await axios.post(IDEASOFT_TOKEN_URL, params, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 20000,
  });

  return r.data;
}

async function refreshIdeaSoftToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: IDEASOFT_CLIENT_ID,
    client_secret: IDEASOFT_CLIENT_SECRET,
    refresh_token: refreshToken,
  });

  const r = await axios.post(IDEASOFT_TOKEN_URL, params, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 20000,
  });

  return r.data;
}

async function getValidIdeaSoftAccessToken() {
  const row = await getIdeaSoftTokenRow();
  if (!row) return null;

  const now = Date.now();
  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : null;

  // Expire yoksa: olduğu gibi kullan (bazı sistemler böyle döner)
  if (!expiresAt) return row.access_token;

  // 60sn tampon
  if (now < expiresAt - 60_000) return row.access_token;

  // Expire olmuş: refresh dene
  if (!row.refresh_token) return null;

  const refreshed = await refreshIdeaSoftToken(row.refresh_token);
  const newExpiresAt = refreshed.expires_in
    ? new Date(Date.now() + refreshed.expires_in * 1000)
    : null;

  await upsertIdeaSoftTokenRow({
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token || row.refresh_token,
    token_type: refreshed.token_type,
    scope: refreshed.scope,
    expires_at: newExpiresAt,
  });

  return refreshed.access_token;
}

async function fetchIdeaSoftOrder(orderId) {
  if (!IDEASOFT_API_BASE_URL) {
    throw new Error("Missing env: IDEASOFT_API_BASE_URL (ör: https://toptansulama.myideasoft.com)");
  }
  const token = await getValidIdeaSoftAccessToken();
  if (!token) {
    throw new Error("IdeaSoft bağlı değil. /ideasoft/login ile bağla.");
  }

  const url = `${IDEASOFT_API_BASE_URL}/admin-api/orders/${encodeURIComponent(orderId)}`;

  const r = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    timeout: 20000,
  });

  return r.data;
}

function formatOrderReply(orderId, order) {
  // IdeaSoft response alanları değişebilir; güvenli şekilde yakala
  const status =
    pickFirst(order, ["statusName", "status", "orderStatus", "order_status", "state"]) ||
    "Bilinmiyor";

  const cargo =
    pickFirst(order, ["shippingCompanyName", "cargoCompany", "shippingCompany", "carrierName"]) ||
    null;

  const trackingNo =
    pickFirst(order, ["trackingNumber", "cargoTrackingNumber", "shipmentTrackingNumber"]) ||
    null;

  const trackingUrl =
    pickFirst(order, ["trackingUrl", "cargoTrackingUrl", "shipmentTrackingUrl"]) ||
    null;

  let msg = `Sipariş no: ${orderId}\nDurum: ${status}`;

  if (cargo) msg += `\nKargo: ${cargo}`;
  if (trackingNo) msg += `\nTakip no: ${trackingNo}`;
  if (trackingUrl) msg += `\nTakip linki: ${trackingUrl}`;

  // “Bitti mi?” hissi verelim
  msg += `\n\nİstersen alıcı adı/adres veya ödeme durumunu da gösterebilirim.`;

  return msg;
}

// -------- Routes ----------
app.get("/", (req, res) => res.send("OK"));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    if (!verifyMetaSignature(req)) {
      return res.status(401).send("Invalid signature");
    }

    const body = req.body;

    // messages dışında event gelebilir -> patlama
    const change = body?.entry?.[0]?.changes?.[0];
    const value = change?.value;

    const message = value?.messages?.[0];
    const waId = message?.from;
    const msgType = message?.type;
    const text = message?.text?.body;

    // Mesaj yoksa 200 dön (Meta retry yapmasın)
    if (!waId || !msgType || !text) {
      console.log("INCOMING (non-message event) ignored");
      return res.sendStatus(200);
    }

    console.log("INCOMING MESSAGE", { from: waId, text, type: msgType });

    const customer = await getOrCreateCustomer(waId, value?.contacts?.[0]?.profile?.name);
    await startConversation(customer.id);

    const state = await getFlowState(customer.id);

    // 13 haneli sipariş no yakala
    const match13 = text.match(/\b(\d{13})\b/);
    const orderId = match13 ? match13[1] : null;

    // Sipariş akışını tetikle
    const lower = text.toLowerCase();
    const wantsOrder =
      lower.includes("sipariş") || lower.includes("kargo") || lower.includes("takip");

    if (wantsOrder && !orderId) {
      await setFlowState(customer.id, "order_tracking", "awaiting_order_id", {});
      await sendWhatsAppText(
        waId,
        "Sipariş takibi için 13 haneli sipariş numaranı yazar mısın? (Örn: 2025010100001)"
      );
      return res.sendStatus(200);
    }

    // Flow state bekliyor ve 13 hane geldiyse -> sorgula
    if ((state?.flow_name === "order_tracking" && state?.step === "awaiting_order_id" && orderId) || orderId) {
      try {
        const order = await fetchIdeaSoftOrder(orderId);
        const reply = formatOrderReply(orderId, order);
        await sendWhatsAppText(waId, reply);
        await clearFlowState(customer.id);
      } catch (err) {
        const apiErr = err?.response?.data;
        console.error("Order fetch error:", apiErr || err.message);

        await sendWhatsAppText(
          waId,
          `Sipariş bulunamadı veya şu an kontrol edemedim.\nSipariş no: ${orderId}\n\nNot: IdeaSoft bağlantısı yoksa önce /ideasoft/login ile bağlamamız gerekiyor.`
        );
      }
      return res.sendStatus(200);
    }

    // Default
    await sendWhatsAppText(
      waId,
      "Merhaba! Sipariş takibi için 'Siparişim nerede?' yazabilir veya direkt 13 haneli sipariş numaranı gönderebilirsin."
    );

    return res.sendStatus(200);
  } catch (e) {
    console.error("Webhook handler error:", e?.response?.data || e);
    return res.sendStatus(200);
  }
});

// ---- IdeaSoft OAuth endpoints ----
app.get("/ideasoft/login", (req, res) => {
  if (!IDEASOFT_AUTH_URL || !IDEASOFT_CLIENT_ID || !IDEASOFT_REDIRECT_URI) {
    return res.status(500).send("Missing IdeaSoft env (AUTH_URL/CLIENT_ID/REDIRECT_URI)");
  }

  const state = crypto.randomBytes(16).toString("hex");
  const url =
    `${IDEASOFT_AUTH_URL}` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(IDEASOFT_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(IDEASOFT_REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(IDEASOFT_SCOPE)}` +
    `&state=${encodeURIComponent(state)}`;

  return res.redirect(url);
});

app.get("/ideasoft/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing code");

    if (!IDEASOFT_TOKEN_URL || !IDEASOFT_CLIENT_SECRET) {
      return res.status(500).send("Missing IdeaSoft env (TOKEN_URL/CLIENT_SECRET)");
    }

    const token = await exchangeIdeaSoftCodeForToken(code);

    const expiresAt = token.expires_in
      ? new Date(Date.now() + token.expires_in * 1000)
      : null;

    await upsertIdeaSoftTokenRow({
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      token_type: token.token_type,
      scope: token.scope,
      expires_at: expiresAt,
    });

    return res.send("IdeaSoft bağlantısı başarılı ✅ Artık WhatsApp sipariş sorgusu çalışır.");
  } catch (e) {
    console.error("IdeaSoft callback error:", e?.response?.data || e);
    return res.status(500).send("IdeaSoft token alınamadı. Loglara bak.");
  }
});

app.get("/ideasoft/token-status", async (req, res) => {
  const row = await getIdeaSoftTokenRow();
  if (!row) return res.json({ connected: false });
  return res.json({
    connected: true,
    expires_at: row.expires_at,
    updated_at: row.updated_at,
    scope: row.scope,
  });
});

// ---- start ----
(async () => {
  try {
    await ensureSchema();
    app.listen(PORT, () => console.log(`Server running on :${PORT}`));
  } catch (e) {
    console.error("Startup error:", e);
    process.exit(1);
  }
})();
