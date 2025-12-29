// src/db.js
import pg from "pg";
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
});

export async function initDb() {
  // minimum şema
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      name TEXT,
      created_at TIMESTAMP DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      status TEXT NOT NULL DEFAULT 'open',
      last_message_at TIMESTAMP DEFAULT now(),
      created_at TIMESTAMP DEFAULT now(),
      started_at TIMESTAMP DEFAULT now(),
      ended_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      text TEXT,
      raw_payload JSONB,
      created_at TIMESTAMP DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS flow_state (
      customer_id INTEGER PRIMARY KEY REFERENCES customers(id),
      flow_name TEXT,
      step TEXT,
      data JSONB DEFAULT '{}'::jsonb,
      updated_at TIMESTAMP DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      state TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS ideasoft_tokens (
      id INTEGER PRIMARY KEY DEFAULT 1,
      access_token TEXT,
      refresh_token TEXT,
      token_type TEXT,
      scope TEXT,
      expires_at TIMESTAMP,
      updated_at TIMESTAMP DEFAULT now()
    );
  `);
}

export const db = {
  async getOrCreateCustomer({ phone, name }) {
    const p = phone?.toString();
    const n = name?.toString() || null;

    const existing = await pool.query(`SELECT * FROM customers WHERE phone=$1`, [p]);
    if (existing.rows[0]) {
      if (n && !existing.rows[0].name) {
        await pool.query(`UPDATE customers SET name=$1 WHERE id=$2`, [n, existing.rows[0].id]);
      }
      return existing.rows[0];
    }

    const ins = await pool.query(
      `INSERT INTO customers (phone, name) VALUES ($1,$2) RETURNING *`,
      [p, n]
    );
    return ins.rows[0];
  },

  async getOrStartConversation({ customer_id }) {
    const open = await pool.query(
      `SELECT * FROM conversations WHERE customer_id=$1 AND status='open' ORDER BY id DESC LIMIT 1`,
      [customer_id]
    );
    if (open.rows[0]) return open.rows[0];

    const ins = await pool.query(
      `INSERT INTO conversations (customer_id, status, last_message_at, started_at) VALUES ($1,'open',now(),now()) RETURNING *`,
      [customer_id]
    );
    return ins.rows[0];
  },

  async insertMessage({ conversation_id, direction, text, raw_payload }) {
    await pool.query(
      `INSERT INTO messages (conversation_id, direction, text, raw_payload) VALUES ($1,$2,$3,$4)`,
      [conversation_id, direction, text, raw_payload ? JSON.stringify(raw_payload) : null]
    );

    await pool.query(`UPDATE conversations SET last_message_at=now() WHERE id=$1`, [conversation_id]);
  },

  async getFlowState({ customer_id }) {
    const r = await pool.query(`SELECT * FROM flow_state WHERE customer_id=$1`, [customer_id]);
    return r.rows[0] || null;
  },

  async setFlowState({ customer_id, flow_name, step, data }) {
    await pool.query(
      `
      INSERT INTO flow_state (customer_id, flow_name, step, data, updated_at)
      VALUES ($1,$2,$3,$4,now())
      ON CONFLICT (customer_id)
      DO UPDATE SET flow_name=EXCLUDED.flow_name, step=EXCLUDED.step, data=EXCLUDED.data, updated_at=now()
      `,
      [customer_id, flow_name, step, JSON.stringify(data || {})]
    );
  },

  async saveOAuthState({ state, provider }) {
    await pool.query(`INSERT INTO oauth_tokens (state, provider) VALUES ($1,$2)`, [state, provider]);
  },

  async consumeOAuthState({ state, provider }) {
    const r = await pool.query(`DELETE FROM oauth_tokens WHERE state=$1 AND provider=$2 RETURNING state`, [
      state,
      provider,
    ]);
    return !!r.rows[0];
  },

  async upsertIdeaSoftToken({ access_token, refresh_token, expires_in, scope, token_type }) {
    const expiresAt =
      typeof expires_in === "number"
        ? new Date(Date.now() + (expires_in - 60) * 1000) // 60sn buffer
        : null;

    await pool.query(
      `
      INSERT INTO ideasoft_tokens (id, access_token, refresh_token, token_type, scope, expires_at, updated_at)
      VALUES (1,$1,$2,$3,$4,$5,now())
      ON CONFLICT (id)
      DO UPDATE SET access_token=EXCLUDED.access_token,
                    refresh_token=EXCLUDED.refresh_token,
                    token_type=EXCLUDED.token_type,
                    scope=EXCLUDED.scope,
                    expires_at=EXCLUDED.expires_at,
                    updated_at=now()
      `,
      [access_token, refresh_token || null, token_type || null, scope || null, expiresAt]
    );
  },

  async getIdeaSoftToken() {
    const r = await pool.query(`SELECT * FROM ideasoft_tokens WHERE id=1`);
    return r.rows[0] || null;
  },
};
