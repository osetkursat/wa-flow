import "dotenv/config";
import express from "express";
import { getOrCreateCustomerByPhone, insertMessage } from "./db.js";
import { handleIncomingText } from "./flow.js";
import { sendText } from "./whatsapp.js";

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_, res) => res.status(200).send("ok"));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const msg = value?.messages?.[0];
    const from = msg?.from;
    const text = msg?.text?.body;

    // Status updates vs. ignore
    if (!from || !text) return res.sendStatus(200);

    const { customer, conversationId } = await getOrCreateCustomerByPhone(from);
    await insertMessage(conversationId, "in", text, req.body);

    const result = await handleIncomingText({ customerId: customer.id, text });

    if (result?.reply) {
      await sendText(from, result.reply);
      await insertMessage(conversationId, "out", result.reply, null);
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e?.response?.data || e);
    return res.sendStatus(200);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on :${port}`));
