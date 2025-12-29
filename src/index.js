import express from "express";
import crypto from "crypto";

import {
  initDb,
  getOrCreateCustomerByPhone,
  getOrCreateOpenConversation,
  touchConversation,
  saveMessage,
  getFlowState,
  setFlowState,
  clearFlowState,
  saveIdeaSoftTokens,
  getIdeaSoftTokens,
} from "./db.js";

const app = express();

// Raw body lazım (Meta signature doğrulaması için)
app.use(
  express.json({
    verify: (req, _res, buf) => {
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
const IDEASOFT_BASE_URL = (process.env.IDEASOFT_BASE_URL || "").replace(/\/$/, "");
const IDEASOFT_CLIENT_ID = process.env.IDEASOFT_CLIENT_ID;
const IDEASOFT_CLIENT_SECRET = process.env.IDEASOFT_CLIENT_SECRET;
const IDEASOFT_REDIRECT_URI = process.env.IDEASOFT_REDIRECT_URI;

const IDEASOFT_AUTH_URL =
  (process.env.IDEASOFT_AUTH_URL || (IDEASOFT_BASE_URL ? `${IDEASOFT_BASE_URL}/panel/auth` : "")).replace(/\/$/, "");
const IDEASOFT_TOKEN_URL =
  (process.env.IDEASOFT_TOKEN_URL || (IDEASOFT_BASE_URL ? `${IDEASOFT_BASE_URL}/oauth/v2/token` : "")).replace(/\/$/, "");

function assertEnv() {
  const missing = [];
  if (!WA_PHONE_NUMBER_ID) missing.push("WA_PHONE_NUMBER_ID");
  if (!WA_TOKEN) missing.push("WA_TOKEN");
  if (!WA_VERIFY_TOKEN) missing.push("WA_VERIFY_TOKEN");
  if (!process.env.DATABASE_URL) missing.push("DATABASE_URL");

  // IdeaSoft zorunlu değil (sadece sipariş sorgusunu gerçek yaparken lazım)
  if (missing.length) {
    console.warn("Missing env:", missing.join(", "));
  }
}

function verifyMetaSignature(req) {
  // İstersen kapatabilirsin; ama canlıda açık kalsın.
  if (!WEBHOOK_SECRET) return true;

  const sig = req.get("x-hub-signature-256");
  if (!sig || !req.rawBody) return false;

  const expected =
    "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(req.rawBody).digest("hex");

  // timing safe compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractIncomingText(body) {
  try {
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const msg = value?.messages?.[0];
    if (!msg) return null;

    const from = msg.from; // wa_id
    const type = msg.type;
    const text = msg.text?.body;

    const name = value?.contacts?.[0]?.profile?.name;

    return { from, type, text, name, raw: body };
  } catch {
    return null;
  }
}

async function sendWhatsAppText(to, text) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;

  const resp = await fetch(url, {
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

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw { status: resp.status, data };
  }
  return data;
}

function isOrderQuestion(text) {
  const t = (text || "").toLowerCase();
  return t.includes("sipari") && t.includes("nerede");
}

function extract13DigitOrderNo(text) {
  const m = (text || "").match(/\b\d{13}\b/);
  return m ? m[0] : null;
}

async function getIdeaSoftOrder(orderId) {
  const tokens = await getIdeaSoftTokens();
  if (!tokens?.access_token) {
    return { ok: false, reason: "no_token" };
  }

  // Basit: token expire kontrolü (yaklaşık)
  if (tokens.expires_at && new Date(tokens.expires_at).getTime() < Date.now() - 30_000) {
    return { ok: false, reason: "expired_token" };
  }

  const url = `${IDEASOFT_BASE_URL}/admin-api/orders/${encodeURIComponent(orderId)}`;

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: "application/json",
    },
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    return { ok: false, reason: "api_error", status: resp.status, data };
  }
  return { ok: true, data };
}

async function handleIncomingText({ from, text, name, raw }) {
  // DB kayıt
  const customer = await getOrCreateCustomerByPhone(from, name);
  const conversationId = await getOrCreateOpenConversation(customer.id);
  await touchConversation(conversationId);
  await saveMessage(conversationId, "in", text, raw);

  const flow = await getFlowState(customer.id);
  const orderNo = extract13DigitOrderNo(text);

  // 1) Kullanıcı "siparişim nerede" derse akışı başlat
  if (isOrderQuestion(text)) {
    await setFlowState(customer.id, "order_tracking", "awaiting_order_no", {});
    await sendWhatsAppText(
      from,
      "Sipariş takibi için 13 haneli sipariş numaranı yazar mısın? (Örn: 2025010100001)"
    );
    await saveMessage(conversationId, "out", "13 haneli sipariş numarası istendi.", null);
    return;
  }

  // 2) Akış açıksa ve 13 haneli numara geldiyse: IdeaSoft’tan çek
  if ((flow?.flow_name === "order_tracking" && flow?.step === "awaiting_order_no") || orderNo) {
    if (!orderNo) {
      await sendWhatsAppText(from, "13 haneli sipariş numaranı tek parça gönderir misin?");
      return;
    }

    // IdeaSoft token yoksa uyar (admin aksiyonu)
    if (!IDEASOFT_BASE_URL || !IDEASOFT_CLIENT_ID || !IDEASOFT_CLIENT_SECRET || !IDEASOFT_REDIRECT_URI) {
      await sendWhatsAppText(
        from,
        `Sipariş no: ${orderNo}\nŞu an demo akıştayım. (IdeaSoft bağlantısı eksik)\n`
      );
      return;
    }

    const orderRes = await getIdeaSoftOrder(orderNo);

    if (!orderRes.ok) {
      if (orderRes.reason === "no_token" || orderRes.reason === "expired_token") {
        await sendWhatsAppText(
          from,
          `Sipariş no: ${orderNo}\nSistemde IdeaSoft bağlantısı yok/bitmiş. Yönetici bağlantıyı yenilemeli.\n`
        );
      } else {
        await sendWhatsAppText(
          from,
          `Sipariş no: ${orderNo}\nŞu an sorgularken hata aldım. Birazdan tekrar dener misin?`
        );
      }
      return;
    }

    // IdeaSoft yanıtını minimal özetle (alan isimleri mağazaya göre değişebilir)
    const o = orderRes.data;
    const status =
      o?.status_name || o?.statusName || o?.status || o?.order_status || "Bilinmiyor";
    const cargo =
      o?.shipping_company || o?.shippingCompany || o?.cargo_company || o?.cargoCompany || "";
    const tracking =
      o?.tracking_number || o?.trackingNumber || o?.cargo_tracking_no || o?.cargoTrackingNo || "";

    let reply = `Sipariş no: ${orderNo}\nDurum: ${status}`;
    if (cargo) reply += `\nKargo: ${cargo}`;
    if (tracking) reply += `\nTakip no: ${tracking}`;

    await sendWhatsAppText(from, reply);
    await clearFlowState(customer.id);
    return;
  }

  // 3) Default cevap
  await sendWhatsAppText(
    from,
    'Merhaba! Sipariş takibi için "Siparişim nerede" yazabilir veya direkt 13 haneli sipariş numaranı gönderebilirsin.'
  );
}

app.get("/", (_req, res) => {
  res.status(200).send("OK");
});

// Meta webhook doğrulama
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WA_VERIFY_TOKEN) {
    return res.status(200).send(String(challenge));
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    if (!verifyMetaSignature(req)) {
      return res.sendStatus(401);
    }

    const msg = extractIncomingText(req.body);
    if (!msg?.from || msg.type !== "text") {
      // Non-message event
      return res.sendStatus(200);
    }

    console.log("INCOMING MESSAGE", { from: msg.from, text: msg.text, type: msg.type });
    await handleIncomingText(msg);

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook handler error:", err);
    // Meta tekrar denemesin diye 200 dönmek mantıklı
    return res.sendStatus(200);
  }
});

/**
 * IdeaSoft OAuth:
 * 1) /ideasoft/connect açılır → IdeaSoft auth'a state ile yönlendirir
 * 2) IdeaSoft /ideasoft/callback'e code+state ile döner
 */
app.get("/ideasoft/connect", (_req, res) => {
  if (!IDEASOFT_AUTH_URL || !IDEASOFT_CLIENT_ID || !IDEASOFT_REDIRECT_URI) {
    return res
      .status(500)
      .send("IdeaSoft env eksik: IDEASOFT_AUTH_URL / IDEASOFT_CLIENT_ID / IDEASOFT_REDIRECT_URI");
  }

  const state = crypto.randomBytes(16).toString("hex"); // <-- STATE BURADA!
  const params = new URLSearchParams({
    response_type: "code",
    client_id: IDEASOFT_CLIENT_ID,
    redirect_uri: IDEASOFT_REDIRECT_URI,
    state,
  });

  // Eğer IdeaSoft scope istiyorsa buraya ekleyebilirsin:
  // params.set("scope", "admin");

  const url = `${IDEASOFT_AUTH_URL}?${params.toString()}`;
  return res.redirect(url);
});

app.get("/ideasoft/callback", async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      return res
        .status(400)
        .send(`IdeaSoft OAuth error: ${error} - ${error_description || ""}`);
    }

    if (!code) return res.status(400).send("Missing code");
    if (!state) return res.status(400).send("Missing state"); // senin gördüğün hata burasıydı

    if (!IDEASOFT_TOKEN_URL || !IDEASOFT_CLIENT_ID || !IDEASOFT_CLIENT_SECRET || !IDEASOFT_REDIRECT_URI) {
      return res.status(500).send("IdeaSoft token env eksik.");
    }

    const form = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: IDEASOFT_CLIENT_ID,
      client_secret: IDEASOFT_CLIENT_SECRET,
      redirect_uri: IDEASOFT_REDIRECT_URI,
      code: String(code),
    });

    const tokenResp = await fetch(IDEASOFT_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    const tokenData = await tokenResp.json().catch(() => ({}));

    if (!tokenResp.ok) {
      return res.status(400).send(`Token alınamadı: ${JSON.stringify(tokenData)}`);
    }

    await saveIdeaSoftTokens(tokenData);

    return res
      .status(200)
      .send("✅ IdeaSoft bağlandı. Artık WhatsApp'tan 13 haneli sipariş no ile sorgu yapabilirsin.");
  } catch (e) {
    console.error(e);
    return res.status(500).send("Callback error");
  }
});

// Start
(async () => {
  try {
    assertEnv();
    await initDb();
    app.listen(PORT, () => console.log(`Server running on :${PORT}`));
  } catch (e) {
    console.error("Boot error:", e);
    process.exit(1);
  }
})();
