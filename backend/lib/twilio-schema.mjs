export const twilioSchema = `
CREATE TABLE IF NOT EXISTS twilio_whatsapp_connections (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 employee_id TEXT NOT NULL REFERENCES employees(id), authorized_by TEXT NOT NULL REFERENCES users(id),
 account_sid TEXT NOT NULL, sender TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, UNIQUE(account_sid,sender)
);
CREATE TABLE IF NOT EXISTS twilio_whatsapp_messages (
 id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES twilio_whatsapp_connections(id),
 org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, message_sid TEXT NOT NULL UNIQUE,
 sender TEXT NOT NULL, body TEXT NOT NULL, received_at TEXT NOT NULL,
 opted_out INTEGER NOT NULL DEFAULT 0, workflow_id TEXT, reply_state TEXT NOT NULL DEFAULT 'none',
 reply_sid TEXT, reply_body TEXT
);
CREATE TABLE IF NOT EXISTS twilio_whatsapp_connection_employees (
 connection_id TEXT NOT NULL REFERENCES twilio_whatsapp_connections(id) ON DELETE CASCADE,
 org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('sales','customer_service')),
 created_at TEXT NOT NULL,
 PRIMARY KEY(connection_id,employee_id)
);`;
