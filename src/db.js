import pg from "pg";
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render internal postgres genelde SSL ister; connectionString zaten sslmode içerir.
  ssl: process.env.DATABASE_SSL === "false" ? false : undefined,
});

export async function initDb() {
  // Mevcut tabloların varsa dokunmaz; yoksa oluşturur + eksik kolonları ekler.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL UNIQUE,
      name TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      customer_id INT NOT NULL REFERENCES customers(id),
      status TEXT NOT NULL DEFAULT 'open',
      last_message_at TIMESTAMP DEFAULT NOW(),
      created_at TIMESTAMP DEFAULT NOW(),
      started_at TIMESTAMP DEFAULT NOW(),
      ended_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INT NOT NULL REFERENCES conversations(id),
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      text TEXT,
      raw_payload JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS flow_state (
      customer_id INT PRIMARY KEY REFERENCES customers(id),
      flow_name TEXT,
      step TEXT,
      data JSONB DEFAULT '{}'::jsonb,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ideasoft_tokens (
      id INT PRIMARY KEY DEFAULT 1,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at TIMESTAMP,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Güvenli “eksik kolon ekle” (senin DB zaten büyük ihtimal hazır)
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS started_at TIMESTAMP DEFAULT NOW();`);
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMP DEFAULT NOW();`);
}

export async function getOrCreateCustomerByPhone(phone, name) {
  const { rows } = await pool.query(
    `INSERT INTO customers(phone, name)
     VALUES($1, $2)
     ON CONFLICT (phone) DO UPDATE SET name = COALESCE(EXCLUDED.name, customers.name)
     RETURNING id, phone, name`,
    [phone, name || null]
  );
  return rows[0];
}

export async function getOrCreateOpenConversation(customerId) {
  const existing = await pool.query(
    `SELECT id FROM conversations
     WHERE customer_id=$1 AND status='open'
     ORDER BY id DESC LIMIT 1`,
    [customerId]
  );

  if (existing.rowCount) return existing.rows[0].id;

  const created = await pool.query(
    `INSERT INTO conversations(customer_id, status, started_at, last_message_at)
     VALUES($1, 'open', NOW(), NOW())
     RETURNING id`,
    [customerId]
  );
  return created.rows[0].id;
}

export async function touchConversation(conversationId) {
  await pool.query(
    `UPDATE conversations SET last_message_at = NOW() WHERE id=$1`,
    [conversationId]
  );
}

export async function saveMessage(conversationId, direction, text, rawPayload) {
  await pool.query(
    `INSERT INTO messages(conversation_id, direction, text, raw_payload)
     VALUES($1,$2,$3,$4)`,
    [conversationId, direction, text || null, rawPayload ? JSON.stringify(rawPayload) : null]
  );
}

export async function getFlowState(customerId) {
  const { rows } = await pool.query(
    `SELECT flow_name, step, data FROM flow_state WHERE customer_id=$1`,
    [customerId]
  );
  return rows[0] || null;
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
  await pool.query(`DELETE FROM flow_state WHERE customer_id=$1`, [customerId]);
}

export async function saveIdeaSoftTokens({ access_token, refresh_token, expires_in }) {
  const expiresAt = expires_in ? new Date(Date.now() + Number(expires_in) * 1000) : null;

  await pool.query(
    `INSERT INTO ideasoft_tokens(id, access_token, refresh_token, expires_at, updated_at)
     VALUES(1,$1,$2,$3,NOW())
     ON CONFLICT (id)
     DO UPDATE SET access_token=EXCLUDED.access_token,
                   refresh_token=COALESCE(EXCLUDED.refresh_token, ideasoft_tokens.refresh_token),
                   expires_at=EXCLUDED.expires_at,
                   updated_at=NOW()`,
    [access_token, refresh_token || null, expiresAt]
  );
}

export async function getIdeaSoftTokens() {
  const { rows } = await pool.query(
    `SELECT access_token, refresh_token, expires_at FROM ideasoft_tokens WHERE id=1`
  );
  return rows[0] || null;
}
