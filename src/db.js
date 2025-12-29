// src/db.js
import pg from "pg";
const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn("Missing env: DATABASE_URL");
}

const shouldUseSSL =
  connectionString &&
  !connectionString.includes("localhost") &&
  !connectionString.includes("127.0.0.1");

export const pool = new Pool({
  connectionString,
  ssl: shouldUseSSL ? { rejectUnauthorized: false } : undefined,
});

export async function ensureSchema() {
  // Tablolar yoksa oluştur
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      wa_id TEXT UNIQUE NOT NULL,
      name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS flow_state (
      customer_id INT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
      flow_name TEXT,
      step TEXT,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ideasoft_tokens (
      id INT PRIMARY KEY DEFAULT 1,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      token_type TEXT,
      scope TEXT,
      expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

export async function getOrCreateCustomer(waId, name) {
  const r = await pool.query("SELECT id, wa_id, name FROM customers WHERE wa_id=$1", [waId]);
  if (r.rows[0]) return r.rows[0];

  const ins = await pool.query(
    `INSERT INTO customers(wa_id, name) VALUES($1,$2) RETURNING id, wa_id, name`,
    [waId, name || null]
  );
  return ins.rows[0];
}

export async function startConversation(customerId) {
  const r = await pool.query(
    "INSERT INTO conversations(customer_id, started_at) VALUES($1, NOW()) RETURNING id",
    [customerId]
  );
  return r.rows[0].id;
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
     VALUES($1,$2,$3,$4, NOW())
     ON CONFLICT (customer_id)
     DO UPDATE SET flow_name=EXCLUDED.flow_name, step=EXCLUDED.step, data=EXCLUDED.data, updated_at=NOW()`,
    [customerId, flowName, step, data || {}]
  );
}

export async function clearFlowState(customerId) {
  await pool.query("DELETE FROM flow_state WHERE customer_id=$1", [customerId]);
}

export async function getIdeaSoftTokenRow() {
  const r = await pool.query("SELECT * FROM ideasoft_tokens WHERE id=1");
  return r.rows[0] || null;
}

export async function upsertIdeaSoftTokenRow({
  access_token,
  refresh_token,
  token_type,
  scope,
  expires_at,
}) {
  await pool.query(
    `INSERT INTO ideasoft_tokens(id, access_token, refresh_token, token_type, scope, expires_at, updated_at)
     VALUES(1,$1,$2,$3,$4,$5, NOW())
     ON CONFLICT (id)
     DO UPDATE SET access_token=EXCLUDED.access_token,
                   refresh_token=EXCLUDED.refresh_token,
                   token_type=EXCLUDED.token_type,
                   scope=EXCLUDED.scope,
                   expires_at=EXCLUDED.expires_at,
                   updated_at=NOW()`,
    [access_token, refresh_token || null, token_type || null, scope || null, expires_at || null]
  );
}
