// src/db.js
import pg from "pg";
const { Pool } = pg;

const sslEnabled = process.env.DATABASE_SSL !== "false";
// Render External URL ile bağlanacaksan genelde SSL gerekir.
// Internal URL (Render içinden) bazen SSL'siz de çalışır; DATABASE_SSL=false ile kapatabilirsin.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslEnabled ? { rejectUnauthorized: false } : false,
});

export async function ensureSchema() {
  // Sırayla yarat (tek query’de çoklu statement bazen can sıkabiliyor)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      name TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      customer_id INT NOT NULL REFERENCES customers(id),
      status TEXT NOT NULL DEFAULT 'open',
      last_message_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INT NOT NULL REFERENCES conversations(id),
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      text TEXT,
      raw_payload JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS flow_state (
      customer_id INT PRIMARY KEY REFERENCES customers(id),
      flow_name TEXT NOT NULL,
      step TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

export async function getOrCreateCustomerByPhone(phone) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      "SELECT id, phone, name FROM customers WHERE phone=$1",
      [phone]
    );

    let customer;
    if (existing.rows.length) {
      customer = existing.rows[0];
    } else {
      const ins = await client.query(
        "INSERT INTO customers(phone) VALUES($1) RETURNING id, phone, name",
        [phone]
      );
      customer = ins.rows[0];
    }

    const conv = await client.query(
      "SELECT id FROM conversations WHERE customer_id=$1 AND status='open' ORDER BY id DESC LIMIT 1",
      [customer.id]
    );

    let conversationId;
    if (conv.rows.length) {
      conversationId = conv.rows[0].id;
      await client.query(
        "UPDATE conversations SET last_message_at=NOW() WHERE id=$1",
        [conversationId]
      );
    } else {
      const cins = await client.query(
        "INSERT INTO conversations(customer_id) VALUES($1) RETURNING id",
        [customer.id]
      );
      conversationId = cins.rows[0].id;
    }

    await client.query("COMMIT");
    return { customer, conversationId };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
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
     VALUES($1,$2,$3,$4, NOW())
     ON CONFLICT (customer_id)
     DO UPDATE SET flow_name=EXCLUDED.flow_name, step=EXCLUDED.step, data=EXCLUDED.data, updated_at=NOW()`,
    [customerId, flowName, step, data || {}]
  );
}

export async function clearFlowState(customerId) {
  await pool.query("DELETE FROM flow_state WHERE customer_id=$1", [customerId]);
}
