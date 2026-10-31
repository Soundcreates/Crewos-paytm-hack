export const pilotSchema = `
CREATE TABLE IF NOT EXISTS approvals (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), workflow_id TEXT NOT NULL REFERENCES workflows(id),
 request_key TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
 request TEXT NOT NULL, response TEXT, reviewed_by TEXT REFERENCES users(id), created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 UNIQUE(workflow_id,request_key,fingerprint)
);
CREATE TABLE IF NOT EXISTS background_jobs (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), kind TEXT NOT NULL, payload TEXT NOT NULL,
 dedupe_key TEXT NOT NULL UNIQUE, input_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
 available_at TEXT NOT NULL, lease_owner TEXT, lease_expires_at TEXT, result TEXT, error TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_ready ON background_jobs(status,available_at,lease_expires_at);
CREATE TABLE IF NOT EXISTS workflow_artifacts (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), workflow_id TEXT NOT NULL REFERENCES workflows(id),
 operation_id TEXT NOT NULL UNIQUE, provider TEXT NOT NULL, external_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT,
 evidence TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS employee_deployments (
 id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id), employee_id TEXT NOT NULL REFERENCES employees(id),
 spec_version INTEGER NOT NULL, runtime_version TEXT NOT NULL, policy_revision TEXT NOT NULL, evidence TEXT NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS probation_requirements (
 org_id TEXT NOT NULL REFERENCES organizations(id), employee_id TEXT NOT NULL REFERENCES employees(id),
 spec_version INTEGER NOT NULL, simulation_id TEXT NOT NULL REFERENCES simulations(id),
 PRIMARY KEY(employee_id,spec_version,simulation_id)
);
CREATE TABLE IF NOT EXISTS slack_installations (
 org_id TEXT PRIMARY KEY REFERENCES organizations(id), team_id TEXT NOT NULL UNIQUE, team_name TEXT NOT NULL,
 bot_token TEXT NOT NULL, channel_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS slack_users (
 team_id TEXT NOT NULL, slack_user_id TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id),
 user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(team_id,slack_user_id)
);
CREATE TABLE IF NOT EXISTS oauth_tickets (
 token_hash TEXT PRIMARY KEY, purpose TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id),
 user_id TEXT REFERENCES users(id), payload TEXT NOT NULL DEFAULT '{}', expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS service_leases (
 name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at TEXT NOT NULL
);
`;

export const pilotColumns = [
 ['workflows','spec_version','INTEGER'],
 ['workflows','deployment_id','TEXT'],
 ['workflows','lease_generation','INTEGER NOT NULL DEFAULT 0'],
 ['workflows','idempotency_key','TEXT'],
 ['workflows','origin',"TEXT NOT NULL DEFAULT '{}'"],
 ['tool_runs','operation_id','TEXT'],
 ['tool_runs','verification','TEXT'],
 ['tool_runs','lease_generation','INTEGER NOT NULL DEFAULT 0'],
 ['employee_runtime_setups','lease_expires_at','TEXT'],
 ['memories','index_status',"TEXT NOT NULL DEFAULT 'pending'"],
 ['memories','embedding_model','TEXT'],
 ['memories','embedding_dimensions','INTEGER'],
];
