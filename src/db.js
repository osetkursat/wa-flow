// src/db.js
const { Pool } = require("pg");

function makePool() {
  const cs = process.env.DATABASE_URL;
  if (!cs) throw new Error("Missing env: DATABASE_URL");

  // Render Postgres genelde SSL ister (external/internal fark etmeksizin güvenli)
  const ssl = { rejectUnauthorized: false };

  return new Pool({
    connectionString: cs,
    ssl,
    max: 5,
  });
}

const pool = makePool();

async function initDb() {
  // customers (phone bazlı)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL UNIQUE,
      name TEXT,
      created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now()
    );
  `);

  // conversations
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      status TEXT NOT NULL DEFAULT 'open',
      started_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now(),
      last_message_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now(),
      ended_at TIMESTAMP WITHOUT TIME ZONE,
      created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now()
    );
  `);

  // messages
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id),
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      text TEXT,
      raw_payload JSONB,
      created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now()
    );
  `);

  // flow_state (customer bazlı tek satır)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS flow_state (
      customer_id INTEGER PRIMARY KEY REFERENCES customers(id),
      state TEXT NOT NULL,
      data JSONB DEFAULT '{}'::jsonb,
      updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now(),
      created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now()
    );
  `);

  // ideasoft token (tek satır id=1)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ideasoft_tokens (
      id INTEGER PRIMARY KEY,
      token_type TEXT,
      access_token TEXT,
      refresh_token TEXT,
      scope TEXT,
      expires_at TIMESTAMP WITHOUT TIME ZONE,
      created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now(),
      updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now()
    );
  `);

  // orders cache (opsiyonel)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_no TEXT NOT NULL,
      status_text TEXT,
      last_checked_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now(),
      raw_payload JSONB
    );
  `);

  // Mevcutta tablo varsa ama kolon eksikse diye "ADD COLUMN IF NOT EXISTS" güvenlikleri
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone TEXT;`);
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS name TEXT;`);
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now();`);

  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS started_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now();`);
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMP WITHOUT TIME ZONE DEFAULT now();`);
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ended_at TIMESTAMP WITHOUT TIME ZONE;`);

  // unique phone yoksa oluştur
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname='public' AND indexname='customers_phone_key'
      ) THEN
        CREATE UNIQUE INDEX customers_phone_key ON customers(phone);
      END IF;
    END $$;
  `);
}

async function getOrCreateCustomer({ phone, name }) {
  const existing = await pool.query(`SELECT id, phone, name FROM customers WHERE phone=$1`, [phone]);
  if (existing.rowCount) return existing.rows[0];

  const created = await pool.query(
    `INSERT INTO customers(phone, name) VALUES ($1, $2) RETURNING id, phone, name`,
    [phone, name || null]
  );
  return created.rows[0];
}

async function getOpenConversation(customerId) {
  const r = await pool.query(
    `SELECT id FROM conversations WHERE customer_id=$1 AND status='open' ORDER BY id DESC LIMIT 1`,
    [customerId]
  );
  return r.rowCount ? r.rows[0].id : null;
}

async function startConversation(customerId) {
  const r = await pool.query(
    `INSERT INTO conversations(customer_id, status, started_at, last_message_at)
     VALUES ($1, 'open', now(), now())
     RETURNING id`,
    [customerId]
  );
  return r.rows[0].id;
}

async function touchConversation(conversationId) {
  await pool.query(`UPDATE conversations SET last_message_at=now() WHERE id=$1`, [conversationId]);
}

async function recordMessage({ conversationId, direction, text, rawPayload }) {
  await pool.query(
    `INSERT INTO messages(conversation_id, direction, text, raw_payload)
     VALUES ($1,$2,$3,$4)`,
    [conversationId, direction, text || null, rawPayload ? JSON.stringify(rawPayload) : null]
  );
}

async function hasIncomingWaMessageId(waMessageId) {
  if (!waMessageId) return false;
  const r = await pool.query(
    `SELECT 1 FROM messages
     WHERE direction='in' AND raw_payload->>'id'=$1
     LIMIT 1`,
    [waMessageId]
  );
  return !!r.rowCount;
}

async function getFlowState(customerId) {
  const r = await pool.query(`SELECT state, data FROM flow_state WHERE customer_id=$1`, [customerId]);
  if (!r.rowCount) return { state: "idle", data: {} };
  return { state: r.rows[0].state, data: r.rows[0].data || {} };
}

async function setFlowState(customerId, state, data = {}) {
  await pool.query(
    `INSERT INTO flow_state(customer_id, state, data, updated_at)
     VALUES ($1,$2,$3,now())
     ON CONFLICT (customer_id) DO UPDATE
     SET state=EXCLUDED.state, data=EXCLUDED.data, updated_at=now()`,
    [customerId, state, JSON.stringify(data)]
  );
}

async function saveIdeaSoftToken(token) {
  const expiresAt =
    token.expires_in ? new Date(Date.now() + Number(token.expires_in) * 1000) : null;

  await pool.query(
    `INSERT INTO ideasoft_tokens(id, token_type, access_token, refresh_token, scope, expires_at, updated_at)
     VALUES (1,$1,$2,$3,$4,$5,now())
     ON CONFLICT (id) DO UPDATE
     SET token_type=EXCLUDED.token_type,
         access_token=EXCLUDED.access_token,
         refresh_token=EXCLUDED.refresh_token,
         scope=EXCLUDED.scope,
         expires_at=EXCLUDED.expires_at,
         updated_at=now()`,
    [
      token.token_type || null,
      token.access_token || null,
      token.refresh_token || null,
      token.scope || null,
      expiresAt,
    ]
  );
}

async function getIdeaSoftToken() {
  const r = await pool.query(`SELECT * FROM ideasoft_tokens WHERE id=1`);
  return r.rowCount ? r.rows[0] : null;
}

module.exports = {
  pool,
  initDb,
  getOrCreateCustomer,
  getOpenConversation,
  startConversation,
  touchConversation,
  recordMessage,
  hasIncomingWaMessageId,
  getFlowState,
  setFlowState,
  saveIdeaSoftToken,
  getIdeaSoftToken,
};
