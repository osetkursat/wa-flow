import pg from "pg";
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render Postgres için genelde SSL gerekir; localde istersen DATABASE_SSL=false yaparsın
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

export async function ensureSchema() {
  // Var olan tabloları bozmadan "eksik olanları ekle" mantığı.
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

    CREATE TABLE IF NOT EXISTS ideasoft_tokens (
      id INTEGER PRIMARY KEY DEFAULT 1,
      access_token TEXT,
      refresh_token TEXT,
      expires_at TIMESTAMP,
      token_type TEXT,
      scope TEXT,
      updated_at TIMESTAMP DEFAULT now()
    );

    -- oauth_tokens eski şemayla var olabilir, yoksa oluştur
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id SERIAL PRIMARY KEY
    );
  `);

  // 🔥 Asıl fix burada: oauth_tokens tablosu varsa bile kolonları güvene al
  await pool.query(`ALTER TABLE IF EXISTS oauth_tokens ADD COLUMN IF NOT EXISTS state TEXT;`);
  await pool.query(`ALTER TABLE IF EXISTS oauth_tokens ADD COLUMN IF NOT EXISTS provider TEXT;`);
  await pool.query(`ALTER TABLE IF EXISTS oauth_tokens ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT now();`);
  await pool.query(`ALTER TABLE IF EXISTS oauth_tokens ADD COLUMN IF NOT EXISTS used_at TIMESTAMP;`);

  // state unique olsun (varsa hata vermez)
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'oauth_tokens_state_unique'
      ) THEN
        ALTER TABLE oauth_tokens ADD CONSTRAINT oauth_tokens_state_unique UNIQUE (state);
      END IF;
    END $$;
  `);
}

export async function getOrCreateCustomerByPhone(phone, name = null) {
  const r = await pool.query(`SELECT id, phone, name FROM customers WHERE phone=$1`, [phone]);
  if (r.rows[0]) {
    if (name && !r.rows[0].name) {
      await pool.query(`UPDATE customers SET name=$1 WHERE id=$2`, [name, r.rows[0].id]);
    }
    return r.rows[0];
  }
  const ins = await pool.query(
    `INSERT INTO customers(phone, name) VALUES($1,$2) RETURNING id, phone, name`,
    [phone, name]
  );
  return ins.rows[0];
}

export async function getOrCreateOpenConversation(customerId) {
  const r = await pool.query(
    `SELECT id FROM conversations WHERE customer_id=$1 AND status='open' ORDER BY id DESC LIMIT 1`,
    [customerId]
  );
  if (r.rows[0]) return r.rows[0].id;

  const ins = await pool.query(
    `INSERT INTO conversations(customer_id, status, started_at, last_message_at)
     VALUES($1,'open',now(),now()) RETURNING id`,
    [customerId]
  );
  return ins.rows[0].id;
}

export async function insertMessage(conversationId, direction, text, rawPayload) {
  await pool.query(
    `INSERT INTO messages(conversation_id, direction, text, raw_payload) VALUES($1,$2,$3,$4)`,
    [conversationId, direction, text ?? null, rawPayload ?? null]
  );
  await pool.query(`UPDATE conversations SET last_message_at=now() WHERE id=$1`, [conversationId]);
}

export async function getFlowState(customerId) {
  const r = await pool.query(
    `SELECT flow_name, step, data FROM flow_state WHERE customer_id=$1`,
    [customerId]
  );
  return r.rows[0] || { flow_name: null, step: null, data: {} };
}

export async function setFlowState(customerId, flowName, step, data = {}) {
  await pool.query(
    `INSERT INTO flow_state(customer_id, flow_name, step, data, updated_at)
     VALUES($1,$2,$3,$4,now())
     ON CONFLICT (customer_id)
     DO UPDATE SET flow_name=EXCLUDED.flow_name, step=EXCLUDED.step, data=EXCLUDED.data, updated_at=now()`,
    [customerId, flowName, step, data]
  );
}

export async function clearFlowState(customerId) {
  await pool.query(`DELETE FROM flow_state WHERE customer_id=$1`, [customerId]);
}

export async function saveOAuthState(provider, state) {
  // state kolonu artık ensureSchema ile garanti
  await pool.query(
    `INSERT INTO oauth_tokens(state, provider, created_at)
     VALUES($1,$2,now())`,
    [state, provider]
  );
}

export async function consumeOAuthState(provider, state) {
  const r = await pool.query(
    `UPDATE oauth_tokens
     SET used_at=now()
     WHERE provider=$1 AND state=$2 AND used_at IS NULL
     RETURNING state`,
    [provider, state]
  );
  return !!r.rows[0];
}

export async function upsertIdeaSoftToken({ access_token, refresh_token, expires_in, scope, token_type }) {
  const expiresAt =
    typeof expires_in === "number" ? new Date(Date.now() + (expires_in - 60) * 1000) : null;

  await pool.query(
    `INSERT INTO ideasoft_tokens(id, access_token, refresh_token, expires_at, scope, token_type, updated_at)
     VALUES(1,$1,$2,$3,$4,$5,now())
     ON CONFLICT (id)
     DO UPDATE SET access_token=EXCLUDED.access_token,
                   refresh_token=EXCLUDED.refresh_token,
                   expires_at=EXCLUDED.expires_at,
                   scope=EXCLUDED.scope,
                   token_type=EXCLUDED.token_type,
                   updated_at=now()`,
    [access_token, refresh_token ?? null, expiresAt, scope ?? null, token_type ?? null]
  );
}

export async function getIdeaSoftToken() {
  const r = await pool.query(`SELECT * FROM ideasoft_tokens WHERE id=1`);
  return r.rows[0] || null;
}
