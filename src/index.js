// src/index.js
import express from "express";
import axios from "axios";
import crypto from "crypto";
import qs from "qs";

import {
  ensureSchema,
  getOrCreateCustomer,
  findOpenConversation,
  startConversation,
  touchConversation,
  insertMessage,
  getFlowState,
  setFlowState,
  clearFlowState,
  getIdeaSoftToken,
  saveIdeaSoftToken,
} from "./db.js";

const app = express();

// raw body sakla (signature doğrulama için)
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
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET; // Meta App Secret önerilir

const IDEASOFT_BASE_URL = process.env.IDEASOFT_BASE_URL; // https://toptansulama.myideasoft.com
const IDEASOFT_AUTH_URL = process.env.IDEASOFT_AUTH_URL; // https://toptansulama.myideasoft.com/panel/auth
const IDEASOFT_TOKEN_URL = process.env.IDEASOFT_TOKEN_URL; // https://toptansulama.myideasoft.com/oauth/v2/token
const IDEASOFT_CLIENT_ID = process.env.IDEASOFT_CLIENT_ID;
const IDEASOFT_CLIENT_SECRET = process.env.IDEASOFT_CLIENT_SECRET;
const IDEASOFT_REDIRECT_URI = process.env.IDEASOFT_REDIRECT_URI; // https://wa-flow.onrender.com/ideasoft/callback

function timingSafeEqual(a, b) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function verifySignature(req) {
  if (!WEBHOOK_SECRET) return true; // secret yoksa doğrulama kapalı
  const sig = req.get("x-hub-signature-256"); // "sha256=..."
  if (!sig || !req.rawBody) return false;

  const expected =
    "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(req.rawBody).digest("hex");
  return timingSafeEqual(sig, expected);
}

async function sendWAText(to, body) {
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
      text: { body },
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

function extractIncomingText(message) {
  const type = message?.type;
  if (type === "text") return message?.text?.body || "";
  if (type === "button") return message?.button?.text || "";
  if (type === "interactive") {
    const i = message?.interactive;
    return (
      i?.button_reply?.title ||
      i?.list_reply?.title ||
      i?.list_reply?.id ||
      ""
    );
  }
  return "";
}

function isOrderNumber13(text) {
  const t = (text || "").trim();
  return /^\d{13}$/.test(t);
}

function normalizeText(text) {
  return (text || "").toLocaleLowerCase("tr-TR").trim();
}

async function ideasoftTokenRefresh(refreshToken) {
  const payload = qs.stringify({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: IDEASOFT_CLIENT_ID,
    client_secret: IDEASOFT_CLIENT_SECRET,
  });

  const r = await axios.post(IDEASOFT_TOKEN_URL, payload, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
  });

  await saveIdeaSoftToken(r.data);
  return r.data.access_token;
}

async function ideasoftRequest(method, url, accessToken) {
  return axios.request({
    method,
    url,
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 15000,
  });
}

// 13 haneli “sipariş numarası” ile bulmaya çalışır.
// 1) önce GET /orders/{id} dener
// 2) olmazsa LIST üzerinde search/keyword denemesi yapar (API farklıysa yine de güvenli fallback)
async function lookupOrderByNumber(orderNo) {
  const tokenRow = await getIdeaSoftToken();
  if (!tokenRow?.access_token) {
    return { error: "IDEASOFT_NOT_CONNECTED" };
  }

  if (!IDEASOFT_BASE_URL) return { error: "IDEASOFT_BASE_URL_MISSING" };

  let accessToken = tokenRow.access_token;

  const tryGet = async () => {
    const url = `${IDEASOFT_BASE_URL}/admin-api/orders/${encodeURIComponent(orderNo)}`;
    return ideasoftRequest("GET", url, accessToken);
  };

  const tryList = async () => {
    const base = `${IDEASOFT_BASE_URL}/admin-api/orders`;
    // bazı sistemlerde search paramı çalışır, bazısında çalışmaz. Deniyoruz.
    const url1 = `${base}?search=${encodeURIComponent(orderNo)}`;
    const url2 = `${base}?q=${encodeURIComponent(orderNo)}`;
    try {
      return await ideasoftRequest("GET", url1, accessToken);
    } catch {
      return await ideasoftRequest("GET", url2, accessToken);
    }
  };

  try {
    const r = await tryGet();
    return { order: r.data };
  } catch (e) {
    // token expired olabilir -> refresh dene
    const status = e?.response?.status;
    if ((status === 401 || status === 403) && tokenRow.refresh_token) {
      accessToken = await ideasoftTokenRefresh(tokenRow.refresh_token);
      try {
        const r2 = await tryGet();
        return { order: r2.data };
      } catch {
        // get yine olmadı -> list dene
      }
    }
  }

  try {
    const r = await tryList();
    const data = r.data;

    // olası şekiller: {data:[...]} veya doğrudan array
    const items = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];

    // alan adları değişebilir; olabildiğince esnek eşleştir
    const found =
      items.find((x) => String(x?.order_number || x?.orderNumber || x?.number || "") === orderNo) ||
      items.find((x) => String(x?.id || "") === orderNo) ||
      items[0];

    if (!found) return { error: "ORDER_NOT_FOUND" };
    return { order: found };
  } catch (e) {
    return { error: "ORDER_LOOKUP_FAILED", detail: e?.response?.data || e?.message };
  }
}

function pick(obj, paths) {
  for (const p of paths) {
    const parts = p.split(".");
    let cur = obj;
    let ok = true;
    for (const part of parts) {
      if (cur && Object.prototype.hasOwnProperty.call(cur, part)) cur = cur[part];
      else {
        ok = false;
        break;
      }
    }
    if (ok && cur != null && cur !== "") return cur;
  }
  return null;
}

function formatOrderReply(orderNo, order) {
  const status =
    pick(order, [
      "status.name",
      "status",
      "orderStatus.name",
      "order_status",
      "state",
    ]) || "Durum bilgisi alınamadı";

  const cargo =
    pick(order, [
      "shipment.shipping_company",
      "shipment.company",
      "shippingCompany",
      "cargoCompany",
    ]) || null;

  const tracking =
    pick(order, [
      "shipment.tracking_url",
      "shipment.trackingUrl",
      "trackingUrl",
      "tracking_url",
      "trackingLink",
    ]) || null;

  let msg = `Sipariş no: ${orderNo}\nDurum: ${status}`;
  if (cargo) msg += `\nKargo: ${cargo}`;
  if (tracking) msg += `\nTakip: ${tracking}`;
  msg += `\n\nİstersen “kargo firması” veya “takip linki” diye yaz, varsa ayrıca göstereyim.`;
  return msg;
}

// Sağlık kontrol
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

// WhatsApp webhook verify (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// WhatsApp webhook (POST)
app.post("/webhook", async (req, res) => {
  try {
    if (!verifySignature(req)) {
      return res.sendStatus(401);
    }

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const messages = value?.messages || [];
    const contacts = value?.contacts || [];

    if (!messages.length) {
      // status vb event’ler
      return res.sendStatus(200);
    }

    const contactName = contacts?.[0]?.profile?.name || null;

    for (const m of messages) {
      const from = m?.from; // wa_id
      const text = extractIncomingText(m);
      const type = m?.type;

      if (!from) continue;

      console.log("INCOMING MESSAGE", { from, text, type });

      // DB kayıt
      const customer = await getOrCreateCustomer(from, contactName);
      let convId = await findOpenConversation(customer.id);
      if (!convId) convId = await startConversation(customer.id);

      await insertMessage(convId, "in", text, req.body);
      await touchConversation(convId);

      // Flow
      const lower = normalizeText(text);
      const flow = await getFlowState(customer.id);

      if (lower.includes("ideasoft bağla") || lower.includes("connect")) {
        const link = `${req.protocol}://${req.get("host")}/ideasoft/connect`;
        await sendWAText(from, `IdeaSoft bağlantısı için bu linki aç: ${link}`);
        continue;
      }

      if (lower.includes("siparişim nerede") || lower.includes("siparisim nerede") || lower === "sipariş" || lower === "siparis") {
        await setFlowState(customer.id, "order_tracking", "await_order_number", {});
        await sendWAText(from, "Sipariş takibi için 13 haneli sipariş numaranı yazar mısın? (Örn: 2025010100001)");
        continue;
      }

      // 13 haneli geldiyse (veya flow bunu bekliyorsa)
      const expectingOrder = flow?.flow_name === "order_tracking" && flow?.step === "await_order_number";
      if (isOrderNumber13(text) || expectingOrder) {
        const orderNo = (text || "").trim();

        if (!isOrderNumber13(orderNo)) {
          await sendWAText(from, "Sipariş numarası 13 hane olmalı. (Sadece rakam) Örn: 2025010100001");
          continue;
        }

        const result = await lookupOrderByNumber(orderNo);

        if (result.error === "IDEASOFT_NOT_CONNECTED") {
          const link = `${req.protocol}://${req.get("host")}/ideasoft/connect`;
          await sendWAText(from, `IdeaSoft bağlantısı yapılmamış. Bağlamak için bu linki aç: ${link}`);
          continue;
        }

        if (result.error === "ORDER_NOT_FOUND") {
          await sendWAText(from, `Sipariş bulunamadı: ${orderNo}\nNumarayı kontrol edip tekrar yazar mısın?`);
          continue;
        }

        if (result.error) {
          console.error("Order lookup error:", result);
          await sendWAText(from, "Sipariş sorgusunda hata oldu. Birazdan tekrar dener misin?");
          continue;
        }

        await clearFlowState(customer.id);
        await sendWAText(from, formatOrderReply(orderNo, result.order));
        continue;
      }

      // default
      await sendWAText(
        from,
        `Merhaba! Sipariş takibi için "Siparişim nerede" yazabilir veya direkt 13 haneli sipariş numaranı gönderebilirsin.`
      );
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook handler error:", err?.response?.data || err);
    return res.sendStatus(200); // Meta tekrar tekrar denemesin
  }
});

// --- IdeaSoft OAuth ---
app.get("/ideasoft/connect", (req, res) => {
  if (!IDEASOFT_AUTH_URL || !IDEASOFT_CLIENT_ID || !IDEASOFT_REDIRECT_URI) {
    return res
      .status(500)
      .send("Missing IdeaSoft env. Check IDEASOFT_AUTH_URL / IDEASOFT_CLIENT_ID / IDEASOFT_REDIRECT_URI");
  }

  const url = new URL(IDEASOFT_AUTH_URL);
  url.searchParams.set("client_id", IDEASOFT_CLIENT_ID);
  url.searchParams.set("redirect_uri", IDEASOFT_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  // scope gerekiyorsa buraya ekleyebiliriz (dokümanına göre)
  return res.redirect(url.toString());
});

app.get("/ideasoft/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing code");

    if (!IDEASOFT_TOKEN_URL || !IDEASOFT_CLIENT_ID || !IDEASOFT_CLIENT_SECRET || !IDEASOFT_REDIRECT_URI) {
      return res.status(500).send("Missing IdeaSoft token env");
    }

    const payload = qs.stringify({
      grant_type: "authorization_code",
      code,
      client_id: IDEASOFT_CLIENT_ID,
      client_secret: IDEASOFT_CLIENT_SECRET,
      redirect_uri: IDEASOFT_REDIRECT_URI,
    });

    const r = await axios.post(IDEASOFT_TOKEN_URL, payload, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    });

    await saveIdeaSoftToken(r.data);

    return res
      .status(200)
      .send("IdeaSoft bağlantısı tamam ✅ Bu sayfayı kapatabilirsin. WhatsApp’tan sipariş numarası gönder.");
  } catch (err) {
    console.error("IdeaSoft callback error:", err?.response?.data || err);
    return res.status(500).send("IdeaSoft callback failed. Loglara bak.");
  }
});

await ensureSchema();

app.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
