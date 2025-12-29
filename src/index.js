// src/index.js
const express = require("express");
const crypto = require("crypto");
const axios = require("axios");
const qs = require("qs");

const db = require("./db");

const app = express();

const PORT = process.env.PORT || 10000;

const GRAPH_API_VERSION = process.env.GRAPH_API_VERSION || "v22.0";
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_TOKEN = process.env.WA_TOKEN;
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN;

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

// IdeaSoft env
const IDEASOFT_BASE_URL = process.env.IDEASOFT_BASE_URL;
const IDEASOFT_AUTH_URL = process.env.IDEASOFT_AUTH_URL;
const IDEASOFT_TOKEN_URL = process.env.IDEASOFT_TOKEN_URL;
const IDEASOFT_CLIENT_ID = process.env.IDEASOFT_CLIENT_ID;
const IDEASOFT_CLIENT_SECRET = process.env.IDEASOFT_CLIENT_SECRET;
const IDEASOFT_REDIRECT_URI = process.env.IDEASOFT_REDIRECT_URI;

function mustEnv(name, val) {
  if (!val) throw new Error(`Missing env: ${name}`);
}

function buildTextReply(text) {
  return { type: "text", text: { body: text } };
}

async function waSendText(to, text) {
  mustEnv("WA_PHONE_NUMBER_ID", WA_PHONE_NUMBER_ID);
  mustEnv("WA_TOKEN", WA_TOKEN);

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${WA_PHONE_NUMBER_ID}/messages`;
  await axios.post(
    url,
    { messaging_product: "whatsapp", to, ...buildTextReply(text) },
    { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
  );
}

function verifySignature(req) {
  // Meta: X-Hub-Signature-256: sha256=...
  if (!WEBHOOK_SECRET) return true; // istersen kapat: secret yoksa doğrulama yapma
  const sig = req.get("x-hub-signature-256");
  if (!sig) return true; // bazen gelmeyebiliyor; zorlamayalım

  const raw = req.rawBody || "";
  const expected =
    "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// raw body lazım (signature için)
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  })
);

app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// Webhook verify
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ----- IdeaSoft OAuth -----
function ideasoftAuthRedirectUrl() {
  mustEnv("IDEASOFT_AUTH_URL", IDEASOFT_AUTH_URL);
  mustEnv("IDEASOFT_CLIENT_ID", IDEASOFT_CLIENT_ID);
  mustEnv("IDEASOFT_REDIRECT_URI", IDEASOFT_REDIRECT_URI);

  // IdeaSoft tarafı scope istemeyebilir; varsa IDEASOFT_SCOPES ile geçersin
  const scope = process.env.IDEASOFT_SCOPES;

  const params = {
    response_type: "code",
    client_id: IDEASOFT_CLIENT_ID,
    redirect_uri: IDEASOFT_REDIRECT_URI,
    ...(scope ? { scope } : {}),
  };

  return `${IDEASOFT_AUTH_URL}?${qs.stringify(params)}`;
}

app.get("/ideasoft/connect", (req, res) => {
  try {
    const url = ideasoftAuthRedirectUrl();
    res.redirect(url);
  } catch (e) {
    res.status(500).send(String(e.message || e));
  }
});

app.get("/ideasoft/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing code");

    mustEnv("IDEASOFT_TOKEN_URL", IDEASOFT_TOKEN_URL);
    mustEnv("IDEASOFT_CLIENT_ID", IDEASOFT_CLIENT_ID);
    mustEnv("IDEASOFT_CLIENT_SECRET", IDEASOFT_CLIENT_SECRET);
    mustEnv("IDEASOFT_REDIRECT_URI", IDEASOFT_REDIRECT_URI);

    const body = qs.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: IDEASOFT_REDIRECT_URI,
      client_id: IDEASOFT_CLIENT_ID,
      client_secret: IDEASOFT_CLIENT_SECRET,
    });

    const tokenResp = await axios.post(IDEASOFT_TOKEN_URL, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    await db.saveIdeaSoftToken(tokenResp.data);

    res.status(200).send("IdeaSoft bağlandı ✅ Token kaydedildi. WhatsApp’tan test edebilirsin.");
  } catch (e) {
    console.error("ideasoft callback error:", e.response?.data || e.message || e);
    res.status(500).send("IdeaSoft token alınamadı. Loglara bak.");
  }
});

async function refreshIdeaSoftTokenIfNeeded() {
  const t = await db.getIdeaSoftToken();
  if (!t) return null;

  if (!t.expires_at) return t; // expires gelmiyorsa “idare et”
  const exp = new Date(t.expires_at).getTime();
  const now = Date.now();

  // 60 sn tolerans
  if (exp - now > 60 * 1000) return t;

  // refresh token yoksa yenileyemeyiz
  if (!t.refresh_token) return t;

  try {
    const body = qs.stringify({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: IDEASOFT_CLIENT_ID,
      client_secret: IDEASOFT_CLIENT_SECRET,
    });

    const tokenResp = await axios.post(IDEASOFT_TOKEN_URL, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    await db.saveIdeaSoftToken(tokenResp.data);
    return await db.getIdeaSoftToken();
  } catch (e) {
    console.error("ideasoft refresh error:", e.response?.data || e.message || e);
    return t;
  }
}

async function ideasoftGetOrder(orderNo) {
  mustEnv("IDEASOFT_BASE_URL", IDEASOFT_BASE_URL);

  let t = await refreshIdeaSoftTokenIfNeeded();
  if (!t || !t.access_token) {
    throw new Error("IdeaSoft bağlı değil. /ideasoft/connect ile bağla.");
  }

  // 1) Direkt /orders/{id} dene (senin 13 haneli no çoğu panelde bu oluyor)
  const url1 = `${IDEASOFT_BASE_URL}/admin-api/orders/${encodeURIComponent(orderNo)}`;

  try {
    const r = await axios.get(url1, {
      headers: { Authorization: `Bearer ${t.access_token}` },
    });
    return r.data;
  } catch (e) {
    // 404/400 olabilir => 2) LIST ile arama dene (API destekliyorsa)
    const status = e.response?.status;

    if (status && status !== 404 && status !== 400) {
      throw e;
    }

    const url2 = `${IDEASOFT_BASE_URL}/admin-api/orders?${qs.stringify({
      search: orderNo,
      per_page: 1,
    })}`;

    const r2 = await axios.get(url2, {
      headers: { Authorization: `Bearer ${t.access_token}` },
    });

    // Bazı API’lar {data:[...]} döner, bazıları direkt [...]
    const list = Array.isArray(r2.data) ? r2.data : (r2.data?.data || r2.data?.items || []);
    if (!list.length) throw new Error("Sipariş bulunamadı.");
    return list[0];
  }
}

function extractOrderStatus(order) {
  // alan adları dokümana göre değişebiliyor, olabildiğince esnek ol
  return (
    order?.orderStatus?.name ||
    order?.order_status?.name ||
    order?.orderStatus ||
    order?.status ||
    order?.statusName ||
    order?.state ||
    "Bilinmiyor"
  );
}

function looksLikeOrderNo13(text) {
  return /^[0-9]{13}$/.test((text || "").trim());
}

// ----- WhatsApp webhook handler -----
app.post("/webhook", async (req, res) => {
  if (!verifySignature(req)) return res.sendStatus(401);

  try {
    const body = req.body;

    const change = body?.entry?.[0]?.changes?.[0]?.value;
    const messages = change?.messages;

    if (!messages || !messages.length) {
      // status / delivery event vb.
      return res.status(200).send("OK");
    }

    const msg = messages[0];
    const from = msg.from;
    const waMessageId = msg.id;

    // duplicate event gelirse aynı mesajı tekrar işleme
    if (await db.hasIncomingWaMessageId(waMessageId)) {
      return res.status(200).send("OK");
    }

    const name = change?.contacts?.[0]?.profile?.name || null;

    const type = msg.type;
    let text = null;

    if (type === "text") text = msg.text?.body || "";
    else if (type === "button") text = msg.button?.text || "";
    else if (type === "interactive") {
      text =
        msg.interactive?.button_reply?.title ||
        msg.interactive?.list_reply?.title ||
        "";
    } else {
      text = "";
    }

    console.log("INCOMING MESSAGE", { from, text, type });

    const customer = await db.getOrCreateCustomer({ phone: from, name });
    let convoId = await db.getOpenConversation(customer.id);
    if (!convoId) convoId = await db.startConversation(customer.id);

    await db.touchConversation(convoId);
    await db.recordMessage({ conversationId: convoId, direction: "in", text, rawPayload: msg });

    const flow = await db.getFlowState(customer.id);

    // ---- Basit akış ----
    const normalized = (text || "").toLowerCase();

    if (flow.state === "awaiting_order_number") {
      if (!looksLikeOrderNo13(text)) {
        await waSendText(from, "Sipariş takibi için **13 haneli** sipariş numaranı yaz lütfen. (Örn: 2025010100001)");
        return res.status(200).send("OK");
      }

      // IdeaSoft’tan çek
      try {
        const order = await ideasoftGetOrder(text.trim());
        const statusText = extractOrderStatus(order);

        await waSendText(
          from,
          `Sipariş no: ${text.trim()}\nDurum: ${statusText}\n\nİstersen “kargo” yaz, kargo bilgisi/ takip linki varsa ayrıca da döndürebilirim.`
        );

        await db.setFlowState(customer.id, "idle", {});
      } catch (e) {
        console.error("Order lookup error:", e.response?.data || e.message || e);
        await waSendText(
          from,
          `Siparişi sorgularken hata aldım.\n\nMuhtemel sebepler:\n- IdeaSoft bağlantısı yok (bağlamak için: ${process.env.PUBLIC_BASE_URL || "https://wa-flow.onrender.com"}/ideasoft/connect)\n- Sipariş no yanlış\n\nTekrar dener misin?`
        );
      }

      return res.status(200).send("OK");
    }

    // trigger: sipariş takibi
    if (normalized.includes("sipariş") || normalized.includes("siparis") || normalized.includes("nerede")) {
      await db.setFlowState(customer.id, "awaiting_order_number", {});
      await waSendText(from, "Sipariş takibi için 13 haneli sipariş numaranı yazar mısın? (Örn: 2025010100001)");
      return res.status(200).send("OK");
    }

    // default help
    await waSendText(from, "Merhaba! Sipariş takibi için “Siparişim nerede” yazabilir veya direkt 13 haneli sipariş numaranı gönderebilirsin.");
    return res.status(200).send("OK");
  } catch (e) {
    console.error("Webhook handler error:", e.response?.data || e.message || e);
    return res.status(200).send("OK");
  }
});

(async () => {
  await db.initDb();
  app.listen(PORT, () => console.log(`Server running on :${PORT}`));
})();
