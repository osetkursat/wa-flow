// src/index.js
import express from "express";
import bodyParser from "body-parser";

import {
  upsertCustomer,
  upsertConversation,
  insertMessage,
  getFlowState,
  setFlowState,
  clearFlowState,
  getProviderToken,
  setProviderToken,
} from "./db.js";

const app = express();
app.use(bodyParser.json());

const VERIFY_TOKEN = process.env.TS_VERIFY_TOKEN;

// WhatsApp (Cloud API) - System User token + Phone Number ID
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;

// IdeaSoft OAuth
const IDEASOFT_AUTH_URL = process.env.IDEASOFT_AUTH_URL;
const IDEASOFT_TOKEN_URL = process.env.IDEASOFT_TOKEN_URL;
const IDEASOFT_CLIENT_ID = process.env.IDEASOFT_CLIENT_ID;
const IDEASOFT_CLIENT_SECRET = process.env.IDEASOFT_CLIENT_SECRET;
const IDEASOFT_REDIRECT_URI = process.env.IDEASOFT_REDIRECT_URI;

// Sipariş sorgusu endpoint template (sen dolduracaksın)
const IDEASOFT_ORDER_STATUS_URL_TEMPLATE = process.env.IDEASOFT_ORDER_STATUS_URL_TEMPLATE;

function mustEnv(name, val) {
  if (!val) throw new Error(`Missing env: ${name}`);
}

function extractTextMessage(payload) {
  const msg = payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  const from = msg?.from;
  const type = msg?.type;
  const text = msg?.text?.body;
  return { from, type, text, raw: msg };
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null) return obj[k];
  }
  return null;
}

async function sendTextMessage(to, text) {
  mustEnv("WA_TOKEN", WA_TOKEN);
  mustEnv("WA_PHONE_NUMBER_ID", WA_PHONE_NUMBER_ID);

  const url = `https://graph.facebook.com/v22.0/${WA_PHONE_NUMBER_ID}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    const err = new Error("WhatsApp send failed");
    err.details = data;
    throw err;
  }
  return data;
}

// ---------- IdeaSoft OAuth helpers ----------
async function saveIdeaSoftTokensFromTokenResponse(tokenJson) {
  const accessToken = tokenJson.access_token;
  const refreshToken = tokenJson.refresh_token;
  const expiresIn = tokenJson.expires_in; // seconds (genelde)
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

  if (!accessToken) throw new Error("IdeaSoft token response missing access_token");

  await setProviderToken("ideasoft", accessToken, refreshToken, expiresAt);
}

async function refreshIdeaSoftTokenIfNeeded() {
  const tokenRow = await getProviderToken("ideasoft");
  if (!tokenRow) return null;

  // expires_at yoksa (veya null) yine de kullanmayı dene
  if (tokenRow.expires_at) {
    const exp = new Date(tokenRow.expires_at).getTime();
    const now = Date.now();
    // 60sn buffer
    if (now < exp - 60_000) return tokenRow.access_token;
  }

  // refresh token ile yenile
  if (!tokenRow.refresh_token) return tokenRow.access_token;

  mustEnv("IDEASOFT_TOKEN_URL", IDEASOFT_TOKEN_URL);
  mustEnv("IDEASOFT_CLIENT_ID", IDEASOFT_CLIENT_ID);
  mustEnv("IDEASOFT_CLIENT_SECRET", IDEASOFT_CLIENT_SECRET);

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: tokenRow.refresh_token,
    client_id: IDEASOFT_CLIENT_ID,
    client_secret: IDEASOFT_CLIENT_SECRET,
  });

  const res = await fetch(IDEASOFT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const json = await res.json();
  if (!res.ok) {
    const err = new Error("IdeaSoft refresh token failed");
    err.details = json;
    throw err;
  }

  await saveIdeaSoftTokensFromTokenResponse(json);
  const updated = await getProviderToken("ideasoft");
  return updated?.access_token || null;
}

async function getIdeaSoftAccessToken() {
  const tokenRow = await getProviderToken("ideasoft");
  if (!tokenRow) return null;
  return refreshIdeaSoftTokenIfNeeded();
}

async function fetchIdeaSoftOrderStatus(orderNo13) {
  if (!IDEASOFT_ORDER_STATUS_URL_TEMPLATE) {
    // endpoint netleşmeden “kurulum tamam” demeyelim
    return {
      ok: false,
      message:
        "IdeaSoft sipariş sorgu endpoint’i tanımlı değil. Render ENV'e IDEASOFT_ORDER_STATUS_URL_TEMPLATE eklememiz lazım.",
    };
  }

  const accessToken = await getIdeaSoftAccessToken();
  if (!accessToken) {
    return { ok: false, message: "IdeaSoft token yok. Önce /ideasoft/connect ile bağlayalım." };
  }

  const url = IDEASOFT_ORDER_STATUS_URL_TEMPLATE.replace("{orderNo}", orderNo13);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    return {
      ok: false,
      message: `IdeaSoft sipariş sorgusu başarısız (HTTP ${res.status}). Endpoint/Yetki kontrol lazım.`,
      debug: json,
    };
  }

  // JSON şekli IdeaSoft’a göre değişebilir: en azından “durum” yakalamaya çalışıyoruz.
  const status =
    pickFirst(json, ["status", "orderStatus", "state", "order_state"]) ||
    pickFirst(json?.data, ["status", "orderStatus", "state"]) ||
    "BULUNDU (durum alanı yakalanamadı)";

  const trackingNo =
    pickFirst(json, ["trackingNumber", "tracking_code", "trackingCode", "cargoTrackingNumber"]) ||
    pickFirst(json?.data, ["trackingNumber", "trackingCode"]);

  const cargoCompany =
    pickFirst(json, ["cargoCompany", "shippingCompany", "carrier"]) ||
    pickFirst(json?.data, ["cargoCompany", "shippingCompany"]);

  const trackingUrl =
    pickFirst(json, ["trackingUrl", "tracking_url"]) || pickFirst(json?.data, ["trackingUrl"]);

  return { ok: true, status, trackingNo, cargoCompany, trackingUrl };
}

// ---------- Webhook verify ----------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------- Incoming messages ----------
app.post("/webhook", async (req, res) => {
  try {
    const payload = req.body;
    const { from, type, text } = extractTextMessage(payload);

    console.log("INCOMING MESSAGE", { from, text, type });

    // Meta bazen “message olmayan” event de yollar
    if (!from || !type) return res.sendStatus(200);

    const customerId = await upsertCustomer(from, null);
    const conversationId = await upsertConversation(customerId);

    await insertMessage(conversationId, "in", text || "", payload);

    const flow = await getFlowState(customerId);
    const orderNoMatch = (text || "").match(/\b\d{13}\b/);
    const orderNo13 = orderNoMatch ? orderNoMatch[0] : null;

    const normalized = (text || "").toLowerCase();

    if (orderNo13) {
      await clearFlowState(customerId);

      const result = await fetchIdeaSoftOrderStatus(orderNo13);

      if (!result.ok) {
        await sendTextMessage(
          from,
          `Sipariş no: ${orderNo13}\nKontrol edemedim: ${result.message}`
        );
      } else {
        let reply = `Sipariş no: ${orderNo13}\nDurum: ${result.status}`;
        if (result.cargoCompany) reply += `\nKargo: ${result.cargoCompany}`;
        if (result.trackingNo) reply += `\nTakip no: ${result.trackingNo}`;
        if (result.trackingUrl) reply += `\nTakip linki: ${result.trackingUrl}`;
        await sendTextMessage(from, reply);
      }

      await insertMessage(conversationId, "out", "ORDER_STATUS_RESPONSE", null);
      return res.sendStatus(200);
    }

    // Akış: sipariş sorusu -> 13 hane bekle
    const wantsOrder =
      normalized.includes("sipariş") || normalized.includes("siparis") || normalized.includes("kargo");

    if (flow?.step === "awaiting_order_no") {
      await sendTextMessage(from, "Sipariş numaran 13 haneli olmalı. Örn: 1234567890123");
      await insertMessage(conversationId, "out", "ASK_ORDER_NO_AGAIN", null);
      return res.sendStatus(200);
    }

    if (wantsOrder) {
      await setFlowState(customerId, "order_tracking", "awaiting_order_no", {});
      await sendTextMessage(from, "Sipariş takibi için 13 haneli sipariş numaranı yazar mısın? (Örn: 1234567890123)");
      await insertMessage(conversationId, "out", "ASK_ORDER_NO", null);
      return res.sendStatus(200);
    }

    await sendTextMessage(from, "Merhaba! Sipariş takibi için ‘Siparişim nerede’ yazabilir veya 13 haneli sipariş numaranı direkt gönderebilirsin.");
    await insertMessage(conversationId, "out", "DEFAULT_HELP", null);

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook handler error:", err?.details || err);
    return res.sendStatus(200);
  }
});

// ---------- IdeaSoft OAuth endpoints ----------
app.get("/ideasoft/connect", (req, res) => {
  mustEnv("IDEASOFT_AUTH_URL", IDEASOFT_AUTH_URL);
  mustEnv("IDEASOFT_CLIENT_ID", IDEASOFT_CLIENT_ID);
  mustEnv("IDEASOFT_REDIRECT_URI", IDEASOFT_REDIRECT_URI);

  const state = "wa_flow_" + Date.now();

  const url =
    `${IDEASOFT_AUTH_URL}` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(IDEASOFT_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(IDEASOFT_REDIRECT_URI)}` +
    `&state=${encodeURIComponent(state)}`;

  return res.redirect(url);
});

app.get("/ideasoft/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing code");

    mustEnv("IDEASOFT_TOKEN_URL", IDEASOFT_TOKEN_URL);
    mustEnv("IDEASOFT_CLIENT_ID", IDEASOFT_CLIENT_ID);
    mustEnv("IDEASOFT_CLIENT_SECRET", IDEASOFT_CLIENT_SECRET);
    mustEnv("IDEASOFT_REDIRECT_URI", IDEASOFT_REDIRECT_URI);

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: String(code),
      redirect_uri: IDEASOFT_REDIRECT_URI,
      client_id: IDEASOFT_CLIENT_ID,
      client_secret: IDEASOFT_CLIENT_SECRET,
    });

    const tokenRes = await fetch(IDEASOFT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const tokenJson = await tokenRes.json();

    if (!tokenRes.ok) {
      console.error("IdeaSoft token error:", tokenJson);
      return res.status(500).send("IdeaSoft token exchange failed");
    }

    await saveIdeaSoftTokensFromTokenResponse(tokenJson);
    return res.send("OK ✅ IdeaSoft bağlandı. Artık WhatsApp’ta 13 haneli sipariş no ile sorgu yapabiliriz.");
  } catch (e) {
    console.error(e);
    return res.status(500).send("Callback error");
  }
});

app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/", (req, res) => res.json({ ok: true, service: "wa-flow" }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on :${PORT}`));
