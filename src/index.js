// src/index.js
import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { initDb, db } from "./db.js";

const app = express();

// Webhook signature doğrulaması için raw body lazım
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

const PORT = process.env.PORT || 10000;

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function normalizeText(t) {
  return (t || "").toString().trim();
}

// 13 haneli alfanümerik (harf+rakam) – senin örnek gibi: 694d66facfb7a
function isOrderCode13(input) {
  const s = normalizeText(input).replace(/\s+/g, "");
  return /^[A-Za-z0-9]{13}$/.test(s);
}

function isTrackIntent(text) {
  const t = normalizeText(text).toLowerCase();
  return t.includes("sipari") && (t.includes("nerede") || t.includes("takip"));
}

// Signature doğrulama: WEBHOOK_SECRET boşsa bypass
function verifyWebhookSignature(req) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) return true;

  const sig = req.get("x-hub-signature-256");
  if (!sig || !req.rawBody) return false;

  const expected =
    "sha256=" + crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");

  // timing-safe compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function sendWhatsAppText(to, body) {
  const WA_PHONE_NUMBER_ID = mustEnv("WA_PHONE_NUMBER_ID");
  const WA_TOKEN = mustEnv("WA_TOKEN");
  const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v22.0";

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WA_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`WA send failed ${r.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

// IdeaSoft OAuth connect
app.get("/ideasoft/connect", async (req, res) => {
  try {
    const authUrl = mustEnv("IDEASOFT_AUTH_URL");
    const clientId = mustEnv("IDEASOFT_CLIENT_ID");
    const redirectUri = mustEnv("IDEASOFT_REDIRECT_URI");

    const state = crypto.randomBytes(16).toString("hex");
    await db.saveOAuthState({ state, provider: "ideasoft" });

    const u = new URL(authUrl);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);

    return res.redirect(u.toString());
  } catch (e) {
    // Artık “Connect failed” değil, gerçek hata
    return res
      .status(500)
      .send(`Connect failed: ${e?.message || e} \n\nCheck Render ENV + DB + IdeaSoft permissions.`);
  }
});

// IdeaSoft OAuth callback
app.get("/ideasoft/callback", async (req, res) => {
  try {
    const code = req.query.code?.toString();
    const state = req.query.state?.toString();

    if (!code) return res.status(400).send("Missing code");

    // state bazen IdeaSoft tarafında gelmiyor / düşebiliyor → dev için zorlamıyoruz
    if (state) {
      const ok = await db.consumeOAuthState({ state, provider: "ideasoft" });
      if (!ok) return res.status(400).send("Invalid state");
    }

    const tokenUrl = mustEnv("IDEASOFT_TOKEN_URL");
    const clientId = mustEnv("IDEASOFT_CLIENT_ID");
    const clientSecret = mustEnv("IDEASOFT_CLIENT_SECRET");
    const redirectUri = mustEnv("IDEASOFT_REDIRECT_URI");

    const form = new URLSearchParams();
    form.set("grant_type", "authorization_code");
    form.set("client_id", clientId);
    form.set("client_secret", clientSecret);
    form.set("redirect_uri", redirectUri);
    form.set("code", code);

    const r = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const data = await r.json();
    if (!r.ok) throw new Error(`IdeaSoft token error ${r.status}: ${JSON.stringify(data)}`);

    await db.upsertIdeaSoftToken({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      scope: data.scope,
      token_type: data.token_type,
    });

    return res.send("IdeaSoft connected ✅ You can close this tab.");
  } catch (e) {
    return res.status(500).send(`Callback failed: ${e?.message || e}`);
  }
});

// IdeaSoft order lookup (çoklu deneme)
async function getIdeaSoftAccessToken() {
  const t = await db.getIdeaSoftToken();
  if (!t?.access_token) return null;
  // basit: expires_at varsa kontrol edelim
  if (t.expires_at && new Date(t.expires_at).getTime() < Date.now()) {
    // refresh implement etmedik (istersen eklerim); şimdilik yeniden bağlan dersin
    return null;
  }
  return t.access_token;
}

async function ideasoftFetch(pathOrUrl) {
  const base = mustEnv("IDEASOFT_BASE_URL");
  const token = await getIdeaSoftAccessToken();
  if (!token) throw new Error("IdeaSoft token missing/expired. Open /ideasoft/connect");

  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${base}${pathOrUrl}`;
  const r = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

async function findOrderByCode(orderCode) {
  const code = normalizeText(orderCode).replace(/\s+/g, "");

  // 1) direkt /orders/{id} dene (bazı sistemler code’u id gibi kabul ediyor)
  {
    const { ok, data } = await ideasoftFetch(`/admin-api/orders/${encodeURIComponent(code)}`);
    if (ok) return data;
  }

  // 2) LIST endpoint üzerinde muhtemel filtreleri dene
  const candidates = [
    `/admin-api/orders?search=${encodeURIComponent(code)}`,
    `/admin-api/orders?code=${encodeURIComponent(code)}`,
    `/admin-api/orders?orderNumber=${encodeURIComponent(code)}`,
    `/admin-api/orders?order_number=${encodeURIComponent(code)}`,
  ];

  for (const u of candidates) {
    const { ok, data } = await ideasoftFetch(u);
    if (ok) {
      // list döndüyse ilk kaydı çekmeye çalış
      if (Array.isArray(data) && data.length) return data[0];
      if (data?.data && Array.isArray(data.data) && data.data.length) return data.data[0];
      if (data?.items && Array.isArray(data.items) && data.items.length) return data.items[0];
    }
  }

  return null;
}

// Health
app.get("/", (req, res) => res.status(200).send("OK"));

// Meta webhook verify
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Meta webhook receive
app.post("/webhook", async (req, res) => {
  try {
    if (!verifyWebhookSignature(req)) {
      return res.status(401).send("Invalid signature");
    }

    const body = req.body;

    const change = body?.entry?.[0]?.changes?.[0];
    const value = change?.value;

    const msg = value?.messages?.[0];
    if (!msg) {
      // status updates vs.
      return res.status(200).json({ ok: true });
    }

    const from = msg.from;
    const type = msg.type;
    const text = msg.text?.body;

    console.log("INCOMING MESSAGE", { from, text, type });

    // DB’ye yaz
    const customer = await db.getOrCreateCustomer({ phone: from, name: value?.contacts?.[0]?.profile?.name });
    const conv = await db.getOrStartConversation({ customer_id: customer.id });
    await db.insertMessage({
      conversation_id: conv.id,
      direction: "in",
      text: text || null,
      raw_payload: body,
    });

    // Flow state
    const state = await db.getFlowState({ customer_id: customer.id });

    // 1) Kullanıcı “siparişim nerede” dediyse sipariş kodu iste
    if (isTrackIntent(text)) {
      await db.setFlowState({
        customer_id: customer.id,
        flow_name: "order_tracking",
        step: "await_order_code",
        data: {},
      });

      await sendWhatsAppText(
        from,
        "Sipariş takibi için 13 karakterlik sipariş kodunu tek parça yazar mısın?\n(Örn: 694d66facfb7a)"
      );

      return res.status(200).json({ ok: true });
    }

    // 2) Sipariş kodu bekliyorsak
    if (state?.flow_name === "order_tracking" && state?.step === "await_order_code") {
      const code = normalizeText(text).replace(/\s+/g, "");
      if (!isOrderCode13(code)) {
        await sendWhatsAppText(from, "13 karakterlik (harf+rakam olabilir) sipariş kodunu tek parça gönderir misin?");
        return res.status(200).json({ ok: true });
      }

      // IdeaSoft'tan sipariş bul
      const order = await findOrderByCode(code);

      if (!order) {
        await sendWhatsAppText(
          from,
          "Bu kodla sipariş bulamadım. Eğer /ideasoft/connect yapmadıysan önce bağlantıyı kur.\nBulamazsa bana paneldeki sipariş linkini at, filtreyi kesinleştirelim."
        );
        return res.status(200).json({ ok: true });
      }

      // Basit cevap
      const status = order?.status || order?.orderStatus || order?.state || "Bilinmiyor";
      const cargo = order?.shipmentCompany || order?.cargoCompany || order?.shipping_company || "";
      const tracking = order?.trackingUrl || order?.tracking_url || order?.shipmentTrackingUrl || "";

      let reply = `Sipariş bulundu ✅\nDurum: ${status}`;
      if (cargo) reply += `\nKargo: ${cargo}`;
      if (tracking) reply += `\nTakip: ${tracking}`;

      await sendWhatsAppText(from, reply);

      await db.setFlowState({
        customer_id: customer.id,
        flow_name: "order_tracking",
        step: "done",
        data: { last_code: code },
      });

      return res.status(200).json({ ok: true });
    }

    // Default
    await sendWhatsAppText(
      from,
      "Merhaba! Sipariş takibi için 'Siparişim nerede' yazabilir veya 13 karakterlik sipariş kodunu gönderebilirsin."
    );

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("Webhook handler error:", e);
    return res.status(200).json({ ok: true }); // Meta retry flood olmasın
  }
});

await initDb();

app.listen(PORT, () => console.log(`Server running on :${PORT}`));
