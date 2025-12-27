CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'open',
  last_message_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
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
  flow_name TEXT NOT NULL,
  step TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMP DEFAULT NOW()
);
