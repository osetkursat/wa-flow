// src/db.js
import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("Missing env: DATABASE_URL");
}

const connectionString = process.env.DATABASE_URL;

// Render Postgres genelde SSL ister (özellikle external host ile)
const ssl =
  connectionString.includes("render.com") || connectionString.includes("postgres.render.com")
    ? { rejectUnauthorized: false }
    : undefined;

export const pool = new Pool({
  connectionString,
  ssl,
});

export async function ensureSchema() {
  // Temel tablolar (varsa dokunmaz, yoksa oluşturur)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL UNIQUE,
      name TEXT,
      created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      status TEXT NOT NULL DEFAULT 'open',
      last_message_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
      created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
      started_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW(),
      ended_at TIMESTAMP WITHOUT TIME ZONE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      text TEXT,
      raw_payload JSONB,
      created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS flow_state (
      customer_id INTEGER PRIMARY KEY REFERENCES customers(id),
      flow_name TEXT NOT NULL,
      step TEXT NOT NULL,
      data JSONB DEFAULT '{}'::jsonb,
      updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ideasoft_tokens (
      id INTEGER PRIMARY KEY DEFAULT 1,
      access_token TEXT,
      refresh_token TEXT,
      expires_at TIMESTAMP WITHOUT TIME ZONE,
      updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW()
    );
  `);

  // Varsa eski tablolar, kolon eksikse ekle (safe)
  await pool.query(`
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS name TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW();

    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW();
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW();
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS started_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW();
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ended_at TIMESTAMP WITHOUT TIME ZONE;

    ALTER TABLE messages ADD COLUMN IF NOT EXISTS raw_payload JSONB;

    ALTER TABLE flow_state ADD COLUMN IF NOT EXISTS flow_name TEXT;
    ALTER TABLE flow_state ADD COLUMN IF NOT EXISTS step TEXT;
    ALTER TABLE flow_state ADD COLUMN IF NOT EXISTS data JSONB DEFAULT '{}'::jsonb;
    ALTER TABLE flow_state ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW();

    ALTER TABLE ideasoft_tokens ADD COLUMN IF NOT EXISTS access_token TEXT;
    ALTER TABLE ideasoft_tokens ADD COLUMN IF NOT EXISTS refresh_token TEXT;
    ALTER TABLE ideasoft_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITHOUT TIME ZONE;
    ALTER TABLE ideasoft_tokens ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT NOW();
  `);
}

export async function getOrCreateCustomer(phone, name = null) {
  const existing = await pool.query("SELECT id, phone, name FROM customers WHERE phone=$1", [phone]);
  if (existing.rows[0]) return existing.rows[0];

  const inserted = await pool.query(
    "INSERT INTO customers(phone, name) VALUES($1,$2) RETURNING id, phone, name",
    [phone, name]
  );
  return inserted.rows[0];
}

export async function findOpenConversation(customerId) {
  const r = await pool.query(
    "SELECT id FROM conversations WHERE customer_id=$1 AND status='open' ORDER BY started_at DESC LIMIT 1",
    [customerId]
  );
  return r.rows[0]?.id || null;
}

export async function startConversation(customerId) {
  const r = await pool.query(
    "INSERT INTO conversations(customer_id, status, started_at, last_message_at) VALUES($1,'open',NOW(),NOW()) RETURNING id",
    [customerId]
  );
  return r.rows[0].id;
}

export async function touchConversation(conversationId) {
  await pool.query("UPDATE conversations SET last_message_at=NOW() WHERE id=$1", [conversationId]);
}

export async function closeConversation(conversationId) {
  await pool.query(
    "UPDATE conversations SET status='closed', ended_at=NOW() WHERE id=$1",
    [conversationId]
  );
}

export async function insertMessage(conversationId, direction, text, rawPayload) {
  await pool.query(
    "INSERT INTO messages(conversation_id, direction, text, raw_payload) VALUES($1,$2,$3,$4)",
    [conversationId, direction, text || null, rawPayload || null]
  );
}

export async function getFlowState(customerId) {
  const r = await pool.query(
    "SELECT flow_name, step, data FROM flow_state WHERE customer_id=$1",
    [customerId]
  );
  return r.rows[0] || null;
}

export async function setFlowState(customerId, flowName, step, data) {
  await pool.query(
    `INSERT INTO flow_state(customer_id, flow_name, step, data, updated_at)
     VALUES($1,$2,$3,$4,NOW())
     ON CONFLICT (customer_id)
     DO UPDATE SET flow_name=EXCLUDED.flow_name, step=EXCLUDED.step, data=EXCLUDED.data, updated_at=NOW()`,
    [customerId, flowName, step, data || {}]
  );
}

export async function clearFlowState(customerId) {
  await pool.query("DELETE FROM flow_state WHERE customer_id=$1", [customerId]);
}

// --- IdeaSoft Token ---
export async function getIdeaSoftToken() {
  const r = await pool.query(
    "SELECT access_token, refresh_token, expires_at FROM ideasoft_tokens WHERE id=1",
    []
  );
  return r.rows[0] || null;
}

export async function saveIdeaSoftToken({ access_token, refresh_token, expires_in }) {
  const expiresAt =
    typeof expires_in === "number"
      ? new Date(Date.now() + expires_in * 1000)
      : null;

  await pool.query(
    `INSERT INTO ideasoft_tokens(id, access_token, refresh_token, expires_at, updated_at)
     VALUES(1,$1,$2,$3,NOW())
     ON CONFLICT (id)
     DO UPDATE SET access_token=EXCLUDED.access_token,
                   refresh_token=EXCLUDED.refresh_token,
                   expires_at=EXCLUDED.expires_at,
                   updated_at=NOW()`,
    [access_token || null, refresh_token || null, expiresAt]
  );
}
