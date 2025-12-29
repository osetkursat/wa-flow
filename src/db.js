// src/db.js
import pg from "pg";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

export async function upsertCustomer(phone, name = null) {
  const { rows } = await pool.query(
    `
    INSERT INTO customers (phone, name)
    VALUES ($1, $2)
    ON CONFLICT (phone)
    DO UPDATE SET name = COALESCE(EXCLUDED.name, customers.name)
    RETURNING id
    `,
    [phone, name]
  );
  return rows[0].id;
}

export async function upsertConversation(customerId) {
  const { rows } = await pool.query(
    `
    INSERT INTO conversations (customer_id, status)
    VALUES ($1, 'open')
    RETURNING id
    `,
    [customerId]
  );
  return rows[0].id;
}

export async function insertMessage(conversationId, direction, text, rawPayload = null) {
  await pool.query(
    `
    INSERT INTO messages (conversation_id, direction, text, raw_payload)
    VALUES ($1, $2, $3, $4)
    `,
    [conversationId, direction, text, rawPayload]
  );

  await pool.query(
    `
    UPDATE conversations
    SET last_message_at = NOW()
    WHERE id = $1
    `,
    [conversationId]
  );
}

export async function getFlowState(customerId) {
  const { rows } = await pool.query(
    `SELECT flow_name, step, data FROM flow_state WHERE customer_id = $1`,
    [customerId]
  );
  return rows[0] || null;
}

export async function setFlowState(customerId, flowName, step, data = {}) {
  await pool.query(
    `
    INSERT INTO flow_state (customer_id, flow_name, step, data)
    VALUES ($1, $2, $3, $4::jsonb)
    ON CONFLICT (customer_id)
    DO UPDATE SET flow_name = EXCLUDED.flow_name,
                  step = EXCLUDED.step,
                  data = EXCLUDED.data,
                  updated_at = NOW()
    `,
    [customerId, flowName, step, JSON.stringify(data || {})]
  );
}

export async function clearFlowState(customerId) {
  await pool.query(`DELETE FROM flow_state WHERE customer_id = $1`, [customerId]);
}

// --- OAuth token storage (IdeaSoft etc.)
export async function getProviderToken(provider) {
  const { rows } = await pool.query(
    `SELECT provider, access_token, refresh_token, expires_at FROM oauth_tokens WHERE provider = $1`,
    [provider]
  );
  return rows[0] || null;
}

export async function setProviderToken(provider, accessToken, refreshToken, expiresAt) {
  await pool.query(
    `
    INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (provider)
    DO UPDATE SET access_token = EXCLUDED.access_token,
                  refresh_token = COALESCE(EXCLUDED.refresh_token, oauth_tokens.refresh_token),
                  expires_at = EXCLUDED.expires_at,
                  updated_at = NOW()
    `,
    [provider, accessToken, refreshToken, expiresAt]
  );
}
