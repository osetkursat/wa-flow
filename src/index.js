import express from "express";
import crypto from "crypto";
import { pool } from "./db.js";

const app = express();

// Meta webhook POST JSON
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

const PORT = process.env.PORT || 10000;

// ---------- Helpers ----------
function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function is13DigitOrderNo(s) {
  return typeof s === "string" && /^[0-9]{13}$/.test(s.trim());
}

async function waSendText(to, text) {
  const WA_TOKEN = mustEnv("WA_TOKEN");
  const WA_PHONE_NUMBER_ID = mustEnv("WA_PHONE_NUMBER_ID");

  const url = `https://graph.facebook.com/v22.0/${WA_PHONE_NUMBER_ID}/messages`;

  const r = await fetch(url, {
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

  const data = await r.json();
  if (!r.ok) throw data;
  return data;
}

// ---------- IdeaSoft token store ----------
async function getIdeaSoftTokenRow() {
  const r = await pool.query("SELECT * FROM ideasoft_tokens WHERE id=1");
  return r.rows[0] || null;
}

async function upsertIdeaSoftToken({ access_token, refresh_token, expires_at }) {
  await pool.query(
    `INSERT INTO ideasoft_tokens (id, access_token, refresh_token, expires_at, updated_at)
     VALUES (1, $1, $2, $3, NOW())
     ON CONFLICT (id) DO UPDATE
     SET access_token=EXCLUDED.access_token,
         refresh_token=COALESCE(EXCLUDED.refresh_token, ideasoft_tokens.refresh_token),
         expires_at=EXCLUDED.expires_at,
         updated_at=NOW()`,
    [access_token, refresh_token || null, expires_at || null]
  );
}

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  // 60sn buffer
  return new Date(expiresAt).getTime() - Date.now() < 60_000;
}

async function exchangeCodeForToken(code) {
  const TOKEN_URL = mustEnv("IDEASOFT_TOKEN_URL");
  const CLIENT_ID = mustEnv("IDEASOFT_CLIENT_ID");
  const CLIENT_SECRET = mustEnv("IDEASOFT_CLIENT_SECRET");
  const REDIRECT_URI = mustEnv("IDEASOFT_REDIRECT_URI");

  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("client_id", CLIENT_ID);
  body.set("client_secret", CLIENT_SECRET);
  body.set("redirect_uri", REDIRECT_URI);
  body.set("code", code);

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await r.json();
  if (!r.ok) throw data;

  // expires_in saniye olabilir
  const expiresAt = data.expires_in
    ? new Date(Date.now() + Number(data.expires_in) * 1000)
    : null;

  await upsertIdeaSoftToken({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: expiresAt,
  });

  return data;
}

async function refreshIdeaSoftToken(refreshToken) {
  const TOKEN_URL = mustEnv("IDEASOFT_TOKEN_URL");
  const CLIENT_ID = mustEnv("IDEASOFT_CLIENT_ID");
  const CLIENT_SECRET = mustEnv("IDEASOFT_CLIENT_SECRET");

  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("client_id", CLIENT_ID);
  body.set("client_secret", CLIENT_SECRET);
  body.set("refresh_token", refreshToken);

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  const data = await r.json();
  if (!r.ok) throw data;

  const expiresAt = data.expires_in
    ? new Date(Date.now() + Number(data.expires_in) * 1000)
    : null;

  await upsertIdeaSoftToken({
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_at: expiresAt,
  });

  return data.access_token;
}

async function ensureIdeaSoftAccessToken() {
  const row = await getIdeaSoftTokenRow();
  if (!row) throw new Error("IdeaSoft token yok. Önce /ideasoft/connect ile bağla.");

  if (!isExpired(row.expires_at)) return row.access_token;

  if (!row.refresh_token) throw new Error("IdeaSoft refresh_token yok. Yeniden yetkilendirme lazım.");

  return await refreshIdeaSoftToken(row.refresh_token);
}

// ---------- IdeaSoft API ----------
async function ideasoftFetch(path, { method = "GET" } = {}) {
  const base = mustEnv("IDEASOFT_BASE_URL");
  const token = await ensureIdeaSoftAccessToken();

  const url = `${base}${path}`;
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw data;
  return data;
}

// LIST’ten 13 haneli sipariş numarası yakalama (field adları IdeaSoft’a göre değişebiliyor)
function pickOrderNumber(o) {
  return (
    o?.orderNumber ||
    o?.order_no ||
    o?.orderNo ||
    o?.number ||
    o?.code ||
    o?.order_code ||
    null
  );
}

function pickStatus(o) {
  // farklı yapılara tolerans
  return (
    o?.status?.name ||
    o?.status ||
    o?.orderStatus?.name ||
    o?.order_status ||
    o?.state ||
    null
  );
}

async function findOrderBy13Digit(orderNo) {
  // en pratik fallback: son X siparişi tarar (ilk sürüm için yeterli)
  // Sonrasında IdeaSoft filtre paramı bulursak hızlandırırız.
  const maxPages = 10;
  const limit = 50;

  for (let page = 1; page <= maxPages; page++) {
    const data = await ideasoftFetch(`/admin-api/orders?page=${page}&limit=${limit}`);

    // bazı API’lar {data:[...]} döner, bazıları direkt [...]
    const list = Array.isArray(data) ? data : (data?.data || data?.items || []);
    if (!Array.isArray(list) || list.length === 0) break;

    const found = list.find((o) => String(pickOrderNumber(o)) === String(orderNo));
    if (found) return found;
  }

  return null;
}

// ---------- Routes ----------
app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

// Meta verify
app.get("/webhook", (req, res) => {
  const VERIFY = mustEnv("WA_VERIFY_TOKEN");
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// IdeaSoft connect (1 kez)
app.get("/ideasoft/connect", (req, res) => {
  const AUTH_URL = mustEnv("IDEASOFT_AUTH_URL");
  const CLIENT_ID = mustEnv("IDEASOFT_CLIENT_ID");
  const REDIRECT_URI = mustEnv("IDEASOFT_REDIRECT_URI");

  const u = new URL(AUTH_URL);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", REDIRECT_URI);

  // scope gerekiyorsa buraya eklenir (dokümandaki scope adlarına göre)
  // u.searchParams.set("scope", "orders_read");

  res.redirect(u.toString());
});

app.get("/ideasoft/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing code");
    await exchangeCodeForToken(code);
    res.send("IdeaSoft bağlandı ✅ Artık WhatsApp sipariş sorgusu çalışır.");
  } catch (e) {
    console.error("IdeaSoft callback error:", e);
    res.status(500).send("Token alma hatası. Loglara bak.");
  }
});

// WhatsApp messages
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    const changes = body?.entry?.[0]?.changes?.[0];
    const value = changes?.value;

    const msg = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    const type = msg.type;
    const text = type === "text" ? msg.text?.body : null;

    console.log("INCOMING MESSAGE", { from, text, type });

    if (!from || !text) return res.sendStatus(200);

    const incoming = text.trim();

    if (incoming.toLowerCase().includes("sipariş") && incoming.toLowerCase().includes("nerede")) {
      await waSendText(from, "Sipariş takibi için 13 haneli sipariş numaranı yazar mısın? (Örn: 1234567890123)");
      return res.sendStatus(200);
    }

    if (is13DigitOrderNo(incoming)) {
      // IdeaSoft’tan bul
      let order = null;
      try {
        order = await findOrderBy13Digit(incoming);
      } catch (e) {
        console.error("IdeaSoft order fetch error:", e);
        await waSendText(from, "Şu an sipariş sistemine bağlanamadım. 2 dk sonra tekrar dener misin?");
        return res.sendStatus(200);
      }

      if (!order) {
        await waSendText(from, `Sipariş no: ${incoming}\nBu numarayla sipariş bulamadım. Numara doğru mu?`);
        return res.sendStatus(200);
      }

      const status = pickStatus(order) || "Durum bilgisi alınamadı";
      const orderId = order.id || order.orderId || "?";

      await waSendText(
        from,
        `Sipariş no: ${incoming}\nDurum: ${status}\n(Referans: ${orderId})`
      );
      return res.sendStatus(200);
    }

    // default
    await waSendText(from, "Anladım. Sipariş takibi için 'Siparişim nerede' yazabilir veya 13 haneli sipariş numaranı gönderebilirsin.");
    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook handler error:", err);
    return res.sendStatus(200); // Meta tekrar denemesin diye 200 dön
  }
});

app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
