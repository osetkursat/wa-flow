import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("Missing env: DATABASE_URL");

export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Render Postgres için genelde sorun çıkarmaz
});

export async function query(text, params) {
  return pool.query(text, params);
}

// Güvenli, idempotent schema init (varsa dokunmaz; eksik kolonları ekler)
export async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      name TEXT,
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      status TEXT NOT NULL DEFAULT 'open',
      last_message_at TIMESTAMP DEFAULT now(),
      created_at TIMESTAMP DEFAULT now(),
      started_at TIMESTAMP DEFAULT now(),
      ended_at TIMESTAMP
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      direction TEXT NOT NULL,
      text TEXT,
      raw_payload JSONB,
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS flow_state (
      customer_id INTEGER PRIMARY KEY REFERENCES customers(id),
      state TEXT NOT NULL DEFAULT 'idle',
      data JSONB,
      updated_at TIMESTAMP DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS ideasoft_tokens (
      id SERIAL PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at TIMESTAMP,
      token_type TEXT,
      scope TEXT,
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id SERIAL PRIMARY KEY,
      provider TEXT NOT NULL,
      state TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT now(),
      used_at TIMESTAMP
    );
  `);
}

export async function upsertCustomer({ phone, name }) {
  const r = await query(
    `
    INSERT INTO customers (phone, name)
    VALUES ($1, $2)
    ON CONFLICT (phone) DO UPDATE SET name = COALESCE(EXCLUDED.name, customers.name)
    RETURNING *;
  `,
    [phone, name || null]
  );
  return r.rows[0];
}

export async function getOrCreateOpenConversation(customerId) {
  const existing = await query(
    `SELECT * FROM conversations WHERE customer_id=$1 AND status='open' ORDER BY id DESC LIMIT 1`,
    [customerId]
  );
  if (existing.rows[0]) return existing.rows[0];

  const created = await query(
    `INSERT INTO conversations (customer_id, status) VALUES ($1,'open') RETURNING *`,
    [customerId]
  );
  return created.rows[0];
}

export async function addMessage({ conversationId, direction, text, rawPayload }) {
  await query(
    `INSERT INTO messages (conversation_id, direction, text, raw_payload) VALUES ($1,$2,$3,$4)`,
    [conversationId, direction, text || null, rawPayload ? JSON.stringify(rawPayload) : null]
  );
  await query(`UPDATE conversations SET last_message_at=now() WHERE id=$1`, [conversationId]);
}

export async function getFlowState(customerId) {
  const r = await query(`SELECT * FROM flow_state WHERE customer_id=$1`, [customerId]);
  if (r.rows[0]) return r.rows[0];

  const created = await query(
    `INSERT INTO flow_state (customer_id, state) VALUES ($1,'idle') RETURNING *`,
    [customerId]
  );
  return created.rows[0];
}

export async function setFlowState(customerId, state, data = null) {
  await query(
    `
    INSERT INTO flow_state (customer_id, state, data, updated_at)
    VALUES ($1,$2,$3,now())
    ON CONFLICT (customer_id) DO UPDATE SET state=EXCLUDED.state, data=EXCLUDED.data, updated_at=now();
  `,
    [customerId, state, data ? JSON.stringify(data) : null]
  );
}

export async function saveOAuthState(provider, state) {
  await query(`INSERT INTO oauth_tokens (provider, state) VALUES ($1,$2)`, [provider, state]);
}

export async function consumeOAuthState(provider, state) {
  const r = await query(
    `UPDATE oauth_tokens SET used_at=now() WHERE provider=$1 AND state=$2 AND used_at IS NULL RETURNING *`,
    [provider, state]
  );
  return r.rows[0] || null;
}

export async function upsertIdeaSoftToken(token) {
  // Tek satır mantığı: en son token'ı tut
  await query(`DELETE FROM ideasoft_tokens`);
  await query(
    `
    INSERT INTO ideasoft_tokens (access_token, refresh_token, expires_at, token_type, scope, updated_at)
    VALUES ($1,$2,$3,$4,$5,now())
  `,
    [
      token.access_token,
      token.refresh_token || null,
      token.expires_at || null,
      token.token_type || null,
      token.scope || null,
    ]
  );
}

export async function getIdeaSoftToken() {
  const r = await query(`SELECT * FROM ideasoft_tokens ORDER BY id DESC LIMIT 1`);
  return r.rows[0] || null;
}
