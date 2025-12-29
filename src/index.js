import "dotenv/config";
import express from "express";
import axios from "axios";
import crypto from "crypto";
import qs from "qs";

import {
  initDb,
  upsertCustomer,
  getOrCreateOpenConversation,
  addMessage,
  getFlowState,
  setFlowState,
  saveOAuthState,
  consumeOAuthState,
  upsertIdeaSoftToken,
  getIdeaSoftToken,
} from "./db.js";

const app = express();

// Meta webhook signature doğrulama (istersen kapat: WEBHOOK_SECRET boş bırak)
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

const PORT = process.env.PORT || 10000;

const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_TOKEN = process.env.WA_TOKEN;
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN;

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const IDEASOFT_BASE_URL = process.env.IDEASOFT_BASE_URL; // https://toptansulama.myideasoft.com
const IDEASOFT_AUTH_URL = process.env.IDEASOFT_AUTH_URL; // /panel/auth
const IDEASOFT_TOKEN_URL = process.env.IDEASOFT_TOKEN_URL; // /oauth/v2/token
const IDEASOFT_CLIENT_ID = process.env.IDEASOFT_CLIENT_ID;
const IDEASOFT_CLIENT_SECRET = process.env.IDEASOFT_CLIENT_SECRET;
const IDEASOFT_REDIRECT_URI = process.env.IDEASOFT_REDIRECT_URI;

function verifyMetaSignature(req) {
  if (!WEBHOOK_SECRET) return true; // secret yoksa doğrulama yapma
  const sig = req.get("x-hub-signature-256");
  if (!sig) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", WEBHOOK_SECRET).update(req.rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

function extractIncomingMessage(body) {
  const entry = body?.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const msg = value?.messages?.[0];
  if (!msg) return null;

  const from = msg.from;
  const type = msg.type;
  const text =
    msg.text?.body ||
    msg.button?.text ||
    msg.interactive?.button_reply?.title ||
    msg.interactive?.list_reply?.title ||
    "";

  const name = value?.contacts?.[0]?.profile?.name;

  return { from, type, text: (text || "").trim(), name, raw: body };
}

// 13 karakter: harf+rakam (IdeaSoft’ta senin dediğin bu)
function extractOrderNo(text) {
  if (!text) return null;
  const m = text.match(/\b[a-zA-Z0-9]{13}\b/);
  return m ? m[0] : null;
}

async function sendText(to, text) {
  if (!WA_PHONE_NUMBER_ID || !WA_TOKEN) {
    console.log("Missing env: WA_PHONE_NUMBER_ID or WA_TOKEN");
    return;
  }

  const url = `https://graph.facebook.com/v22.0/${WA_PHONE_NUMBER_ID}/messages`;
  await axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    },
    { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
  );
}

function mkAuthLink() {
  return `${process.env.PUBLIC_BASE_URL || "https://wa-flow.onrender.com"}/ideasoft/connect`;
}

// IdeaSoft token al / gerekirse refresh dene
async function ensureIdeaSoftAccessToken() {
  const row = await getIdeaSoftToken();
  if (!row) return null;

  // expires_at null ise “şimdilik geçerli” kabul
  if (!row.expires_at) return row.access_token;

  const exp = new Date(row.expires_at).getTime();
  if (Date.now() < exp - 60_000) return row.access_token; // 60 sn pay

  // refresh varsa dene
  if (!row.refresh_token) return null;

  try {
    const resp = await axios.post(
      IDEASOFT_TOKEN_URL,
      qs.stringify({
        grant_type: "refresh_token",
        refresh_token: row.refresh_token,
        client_id: IDEASOFT_CLIENT_ID,
        client_secret: IDEASOFT_CLIENT_SECRET,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const tok = resp.data;
    const expiresAt = tok.expires_in
      ? new Date(Date.now() + tok.expires_in * 1000)
      : null;

    await upsertIdeaSoftToken({
      access_token: tok.access_token,
      refresh_token: tok.refresh_token || row.refresh_token,
      expires_at: expiresAt,
      token_type: tok.token_type,
      scope: tok.scope,
    });

    return tok.access_token;
  } catch (e) {
    console.error("IdeaSoft refresh failed:", e?.response?.data || e?.message);
    return null;
  }
}

async function ideasoftGet(path, token, params = undefined) {
  const url = `${IDEASOFT_BASE_URL}${path}`;
  const resp = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    params,
  });
  return resp.data;
}

// Siparişi 13 karakter “sipariş numarası” ile bul: önce filtre dene, sonra fallback
async function findIdeaSoftOrderByOrderNo(orderNo) {
  const token = await ensureIdeaSoftAccessToken();
  if (!token) return { error: "no_token" };

  const listUrl = "/admin-api/orders";
  const candidates = [
    "order_number",
    "orderNumber",
    "number",
    "code",
    "order_code",
    "orderCode",
    "search",
    "q",
  ];

  // 1) Filtre parametreleriyle dene
  for (const key of candidates) {
    try {
      const data = await ideasoftGet(listUrl, token, { [key]: orderNo });
      const items = Array.isArray(data) ? data : data?.data || data?.items || [];
      if (items?.length) return { order: items[0] };
    } catch (e) {
      // bazı parametreler 400 verebilir, sorun değil
    }
  }

  // 2) Fallback: son 50 siparişi çek, alanlarda eşleşme ara
  try {
    const data = await ideasoftGet(listUrl, token, { page: 1, per_page: 50 });
    const items = Array.isArray(data) ? data : data?.data || data?.items || [];
    const lower = String(orderNo).toLowerCase();

    const hit = items.find((o) => {
      const values = [
        o?.order_number,
        o?.orderNumber,
        o?.number,
        o?.code,
        o?.order_code,
        o?.orderCode,
      ]
        .filter(Boolean)
        .map((v) => String(v).toLowerCase());
      return values.includes(lower);
    });

    if (hit) return { order: hit };
    return { order: null };
  } catch (e) {
    console.error("IdeaSoft order list fallback failed:", e?.response?.data || e?.message);
    return { error: "list_failed" };
  }
}

function formatOrderReply(orderNo, order) {
  // Field isimleri IdeaSoft’ta değişebilir; mümkün olduğunca “güvenli” okuyoruz
  const status = order?.status || order?.order_status || order?.state || "Bilinmiyor";
  const cargo = order?.shipping_company || order?.cargo_company || order?.shipment?.company || null;
  const track = order?.tracking_url || order?.shipment?.tracking_url || order?.tracking_number || null;

  let msg = `Sipariş no: ${orderNo}\nDurum: ${status}`;
  if (cargo) msg += `\nKargo: ${cargo}`;
  if (track) msg += `\nTakip: ${track}`;
  msg += `\n\nİstersen “kargo firması” veya “takip linki” formatını da netleştirip daha düzgün gösterebilirim.`;
  return msg;
}

// Ana flow
async function buildFlowReply(customerId, text) {
  const flow = await getFlowState(customerId);
  const state = flow.state || "idle";

  const normalized = (text || "").toLowerCase();

  // 13 karakterlik sipariş no yakala (harf+rakam)
  const orderNo = extractOrderNo(text);

  if (state === "await_order") {
    if (!orderNo) {
      return `13 karakterli sipariş numaranı tek parça gönderir misin? (Harf+rakam olabilir)\nÖrn: A1B2C3D4E5F67`;
    }

    const r = await findIdeaSoftOrderByOrderNo(orderNo);
    if (r.error === "no_token") {
      await setFlowState(customerId, "await_order");
      return `IdeaSoft bağlantısı yok. Şu linkten bağlayalım:\n${mkAuthLink()}`;
    }
    if (r.order) {
      await setFlowState(customerId, "idle");
      return formatOrderReply(orderNo, r.order);
    }

    await setFlowState(customerId, "idle");
    return `Sipariş bulunamadı: ${orderNo}\nİstersen ekran görüntüsü at veya farklı sipariş numarası dene.`;
  }

  // idle
  if (normalized.includes("sipariş") && normalized.includes("nerede")) {
    await setFlowState(customerId, "await_order");
    return `Sipariş takibi için 13 karakterli sipariş numaranı yazar mısın?\n(Harf+rakam olabilir)`;
  }

  if (orderNo) {
    // kullanıcı direkt sipariş no gönderdiyse
    await setFlowState(customerId, "await_order");
    // aynı mesaj içinde işlemek için state’e girmeden direkt sonuç döndür
    const r = await findIdeaSoftOrderByOrderNo(orderNo);
    if (r.error === "no_token") {
      await setFlowState(customerId, "idle");
      return `IdeaSoft bağlantısı yok. Şu linkten bağlayalım:\n${mkAuthLink()}`;
    }
    if (r.order) {
      await setFlowState(customerId, "idle");
      return formatOrderReply(orderNo, r.order);
    }
    await setFlowState(customerId, "idle");
    return `Sipariş bulunamadı: ${orderNo}`;
  }

  return `Merhaba! Sipariş takibi için "Siparişim nerede?" yazabilir veya direkt 13 karakterli sipariş numaranı gönderebilirsin.`;
}

// Health
app.get("/", (req, res) => res.status(200).send("OK"));

// Meta verify (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Meta events (POST)
app.post("/webhook", async (req, res) => {
  try {
    if (!verifyMetaSignature(req)) {
      return res.sendStatus(401);
    }

    const incoming = extractIncomingMessage(req.body);
    if (!incoming) {
      // message olmayan event
      console.log("INCOMING (non-message event) ignored");
      return res.sendStatus(200);
    }

    const { from, text, name, raw, type } = incoming;
    console.log("INCOMING MESSAGE", { from, text, type });

    const customer = await upsertCustomer({ phone: from, name });
    const conv = await getOrCreateOpenConversation(customer.id);

    await addMessage({
      conversationId: conv.id,
      direction: "in",
      text,
      rawPayload: raw,
    });

    const reply = await buildFlowReply(customer.id, text);

    await sendText(from, reply);

    await addMessage({
      conversationId: conv.id,
      direction: "out",
      text: reply,
      rawPayload: null,
    });

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook handler error:", err?.response?.data || err?.message || err);
    return res.sendStatus(200); // Meta tekrar tekrar vurmasın diye 200
  }
});

// IdeaSoft OAuth connect
app.get("/ideasoft/connect", async (req, res) => {
  try {
    if (!IDEASOFT_AUTH_URL || !IDEASOFT_CLIENT_ID || !IDEASOFT_REDIRECT_URI) {
      return res.status(500).send("IdeaSoft env eksik (AUTH_URL/CLIENT_ID/REDIRECT_URI).");
    }

    const state = crypto.randomBytes(16).toString("hex");
    await saveOAuthState("ideasoft", state);

    const url =
      `${IDEASOFT_AUTH_URL}?` +
      qs.stringify({
        client_id: IDEASOFT_CLIENT_ID,
        redirect_uri: IDEASOFT_REDIRECT_URI,
        response_type: "code",
        state, // IdeaSoft bunu istiyor; yoksa “state eksik” hatası
      });

    return res.redirect(url);
  } catch (e) {
    console.error(e);
    return res.status(500).send("Connect failed");
  }
});

// IdeaSoft OAuth callback
app.get("/ideasoft/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send("Missing code");
    if (!state) return res.status(400).send("Missing state");

    const ok = await consumeOAuthState("ideasoft", String(state));
    if (!ok) return res.status(400).send("Invalid state");

    const resp = await axios.post(
      IDEASOFT_TOKEN_URL,
      qs.stringify({
        grant_type: "authorization_code",
        code,
        redirect_uri: IDEASOFT_REDIRECT_URI,
        client_id: IDEASOFT_CLIENT_ID,
        client_secret: IDEASOFT_CLIENT_SECRET,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const tok = resp.data;
    const expiresAt = tok.expires_in ? new Date(Date.now() + tok.expires_in * 1000) : null;

    await upsertIdeaSoftToken({
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: expiresAt,
      token_type: tok.token_type,
      scope: tok.scope,
    });

    return res.send("IdeaSoft bağlandı ✅ WhatsApp’tan tekrar sipariş no gönderebilirsin.");
  } catch (e) {
    console.error("Callback error:", e?.response?.data || e?.message);
    return res.status(500).send("Callback failed");
  }
});

(async () => {
  await initDb();
  app.listen(PORT, () => console.log(`Server running on :${PORT}`));
})();
