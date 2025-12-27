import pg from "pg";
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "false" ? false : undefined
});

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
