import { twilioSchema } from './twilio-schema.mjs';
import { shopifyDevStoreSchema, shopifyDevThemeSchema } from './shopify-dev-store-schema.mjs';
import { pilotSchema, pilotColumns } from './pilot-schema.mjs';
import { scheduleSchema } from './schedule-schema.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { validateDatabaseConfiguration } from './database-config.mjs';
import { postgresSql, sqliteSql } from './sql-dialect.mjs';

const databaseUrl = process.env.DATABASE_URL?.trim();
const databaseConfiguration=validateDatabaseConfiguration({databaseUrl,neonAuthBaseUrl:process.env.NEON_AUTH_BASE_URL,nodeEnv:process.env.NODE_ENV});
export const neonAuthBaseUrl = databaseConfiguration.neonAuthBaseUrl;
const filename = resolve(process.env.DATABASE_FILE || './data/crewos.sqlite');
export const databaseFile = filename;
if (!databaseUrl) mkdirSync(dirname(filename), { recursive: true });
export const db = databaseUrl ? null : new DatabaseSync(filename);
if (db) db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
export const postgresPool = databaseUrl ? new pg.Pool({
  connectionString: databaseUrl,
  max: Math.max(1, Math.min(32, Math.trunc(Number(process.env.DATABASE_POOL_MAX) || 10))),
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
}) : null;
export const databaseDialect = databaseUrl ? 'postgres' : 'sqlite';
pg.types.setTypeParser(pg.types.builtins.INT8, Number);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number);
const postgresTransactions = new AsyncLocalStorage();
const transactionCallbacks = new AsyncLocalStorage();
const sqliteTransactions = new AsyncLocalStorage();
let sqliteQueue = Promise.resolve();

const schema = `
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','manager','member')),
  created_at TEXT NOT NULL, PRIMARY KEY(org_id, user_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL, accepted_at TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS solari_profiles (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL, key_hash TEXT NOT NULL, name TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  UNIQUE(org_id, provider_id)
);
CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL, title TEXT NOT NULL, department TEXT NOT NULL DEFAULT 'Operations',
  profile_id TEXT REFERENCES solari_profiles(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'draft', avatar TEXT NOT NULL DEFAULT '◉', x REAL NOT NULL DEFAULT 0.3, y REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS employee_specs (
  id TEXT PRIMARY KEY, employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, data TEXT NOT NULL, provenance TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, UNIQUE(employee_id, version)
);
CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL, tool TEXT NOT NULL, effect TEXT NOT NULL CHECK(effect IN ('ALLOW','REQUIRE_APPROVAL','DENY')),
  condition TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES employees(id), created_by TEXT NOT NULL REFERENCES users(id),
  goal TEXT NOT NULL, status TEXT NOT NULL, runtime_version TEXT NOT NULL DEFAULT 'legacy', plan TEXT NOT NULL DEFAULT '[]', step_index INTEGER NOT NULL DEFAULT 0,
  result TEXT, error TEXT, input_requests TEXT NOT NULL DEFAULT '{}', input_responses TEXT NOT NULL DEFAULT '{}',
  started_at TEXT, finished_at TEXT, worker_id TEXT, lease_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL, employee_id TEXT REFERENCES employees(id) ON DELETE SET NULL,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL, kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS simulations (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL, scenario TEXT NOT NULL, rubric TEXT NOT NULL,
  threshold REAL NOT NULL DEFAULT 0.8, version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS simulation_versions (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  simulation_id TEXT NOT NULL REFERENCES simulations(id) ON DELETE CASCADE, version INTEGER NOT NULL,
  name TEXT NOT NULL, description TEXT NOT NULL, scenario TEXT NOT NULL, rubric TEXT NOT NULL,
  threshold REAL NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  UNIQUE(simulation_id,version)
);
CREATE TABLE IF NOT EXISTS simulation_runs (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  simulation_id TEXT NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
  suite_version INTEGER NOT NULL DEFAULT 1, suite_snapshot TEXT NOT NULL DEFAULT '{}',
  employee_id TEXT NOT NULL REFERENCES employees(id), spec_version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, score REAL NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0, evidence TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE, kind TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1,
  embedding TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  filename TEXT NOT NULL, mime_type TEXT NOT NULL, extracted_text TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coworkers (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE, name TEXT NOT NULL, role TEXT NOT NULL,
  expertise TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title TEXT NOT NULL, agenda TEXT NOT NULL DEFAULT '[]', participant_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'scheduled', decisions TEXT NOT NULL DEFAULT '[]', created_by TEXT NOT NULL REFERENCES users(id),
  starts_at TEXT, meeting_worker_id TEXT, meeting_lease_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meeting_briefs (
  id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE, brief TEXT NOT NULL,
  source_memory_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
  UNIQUE(meeting_id, employee_id)
);
CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  from_employee_id TEXT REFERENCES employees(id) ON DELETE SET NULL, to_employee_id TEXT REFERENCES employees(id) ON DELETE SET NULL,
  body TEXT NOT NULL, evidence_ids TEXT NOT NULL DEFAULT '[]', kind TEXT NOT NULL DEFAULT 'manual',
  type TEXT NOT NULL DEFAULT 'message', delegation_goal TEXT, delegation_status TEXT NOT NULL DEFAULT '',
  workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS action_items (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL, employee_id TEXT REFERENCES employees(id) ON DELETE SET NULL,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL,
  title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, display_name TEXT NOT NULL, secret_ciphertext TEXT, config TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'disconnected', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(org_id, provider)
);
CREATE TABLE IF NOT EXISTS mcp_connections (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL, endpoint TEXT NOT NULL, token_ciphertext TEXT, tools TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'connected', created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(org_id, name), UNIQUE(org_id, endpoint)
);
CREATE TABLE IF NOT EXISTS jira_oauth_states (
  state_hash TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  created_by_employee TEXT REFERENCES employees(id) ON DELETE SET NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS simulated_refunds (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  step_index INTEGER NOT NULL, employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL, amount NUMERIC NOT NULL CHECK(amount > 0), currency TEXT NOT NULL CHECK(length(currency)=3),
  status TEXT NOT NULL DEFAULT 'simulated', created_at TEXT NOT NULL, UNIQUE(workflow_id,step_index)
);
CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, provider_id TEXT, profile_id TEXT, status TEXT NOT NULL, label TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS office_layouts (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  layout TEXT NOT NULL DEFAULT '{"rooms":[],"desks":[]}', updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_runs (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL, step_index INTEGER, tool TEXT NOT NULL,
  input TEXT NOT NULL, output TEXT, duration_ms INTEGER, status TEXT NOT NULL DEFAULT 'started',
  attempt_count INTEGER NOT NULL DEFAULT 1, retry_at TEXT, created_at TEXT NOT NULL,
  UNIQUE(workflow_id,step_index)
);
CREATE TABLE IF NOT EXISTS provider_usage (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, model TEXT NOT NULL, operation TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_employees_org ON employees(org_id);
CREATE INDEX IF NOT EXISTS idx_workflows_org_status ON workflows(org_id, status);
CREATE INDEX IF NOT EXISTS idx_events_org_time ON events(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_org_employee ON memories(org_id, employee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_simruns_org ON simulation_runs(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_org ON solari_profiles(org_id, name);
CREATE INDEX IF NOT EXISTS idx_provider_usage_org_time ON provider_usage(org_id, created_at DESC);
`;

function withSqliteQueue(operation) {
  if (sqliteTransactions.getStore()) return Promise.resolve().then(operation);
  const predecessor = sqliteQueue;
  let release;
  sqliteQueue = new Promise((resolveQueue) => { release = resolveQueue; });
  return predecessor.then(operation).finally(release);
}

const migratedColumns = [
  ['employees', 'profile_id', 'TEXT'],
  ['solari_profiles', 'key_hash', "TEXT NOT NULL DEFAULT ''"],
  ['meeting_briefs', 'source_memory_ids', "TEXT NOT NULL DEFAULT '[]'"],
  ['agent_messages', 'kind', "TEXT NOT NULL DEFAULT 'manual'"],
  ['action_items', 'workflow_id', 'TEXT REFERENCES workflows(id) ON DELETE SET NULL'],
  ['workflows', 'worker_id', 'TEXT'],
  ['workflows', 'lease_expires_at', 'TEXT'],
  ['simulations', 'version', 'INTEGER NOT NULL DEFAULT 1'],
  ['simulation_runs', 'suite_version', 'INTEGER NOT NULL DEFAULT 1'],
  ['simulation_runs', 'suite_snapshot', "TEXT NOT NULL DEFAULT '{}'"],
  ['tool_runs', 'attempt_count', 'INTEGER NOT NULL DEFAULT 1'],
  ['tool_runs', 'retry_at', 'TEXT'],
];

const coworkerRelationshipsSchema = `
CREATE TABLE IF NOT EXISTS coworker_relationships (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  from_coworker_id TEXT NOT NULL, to_coworker_id TEXT NOT NULL,
  last_interaction_summary TEXT NOT NULL, last_interaction_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK(from_coworker_id <> to_coworker_id),
  UNIQUE(org_id, from_coworker_id, to_coworker_id),
  FOREIGN KEY(org_id, from_coworker_id) REFERENCES coworkers(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY(org_id, to_coworker_id) REFERENCES coworkers(org_id, id) ON DELETE CASCADE
);
`;

function simulationSnapshot(row) {
  return JSON.stringify({
    version: row.suite_version,
    name: row.name,
    description: row.description,
    scenario: JSON.parse(row.scenario),
    rubric: JSON.parse(row.rubric),
    threshold: row.threshold,
  });
}

async function migrateRefundAmounts(client) {
  const refundAmountType = (await client.query(
    "SELECT data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='simulated_refunds' AND column_name='amount'",
  )).rows[0]?.data_type;
  if (!refundAmountType || ['numeric', 'decimal'].includes(refundAmountType)) return;

  await client.query('ALTER TABLE simulated_refunds ALTER COLUMN amount TYPE NUMERIC USING amount::numeric');
  const legacyRefunds = (await client.query(
    "SELECT r.id,t.output FROM simulated_refunds r JOIN tool_runs t ON t.workflow_id=r.workflow_id AND t.step_index=r.step_index AND t.tool='payments.refund' WHERE t.output IS NOT NULL",
  )).rows;
  for (const row of legacyRefunds) {
    let output;
    try { output = JSON.parse(row.output); } catch { continue; }
    const amount = Number(output?.amount);
    if (output?.refundId === row.id && Number.isFinite(amount) && amount > 0) {
      await client.query('UPDATE simulated_refunds SET amount=$1::numeric WHERE id=$2', [String(output.amount), row.id]);
    }
  }
}

async function backfillSimulationSnapshots(client) {
  await client.query("INSERT INTO simulation_versions(id,org_id,simulation_id,version,name,description,scenario,rubric,threshold,created_by,created_at) SELECT 'simver_' || s.id || '_' || s.version,s.org_id,s.id,s.version,s.name,s.description,s.scenario,s.rubric,s.threshold,s.created_by,s.updated_at FROM simulations s ON CONFLICT(simulation_id,version) DO NOTHING");
  const legacyRuns = (await client.query(
    "SELECT r.id,r.suite_version,v.name,v.description,v.scenario,v.rubric,v.threshold FROM simulation_runs r JOIN simulation_versions v ON v.simulation_id=r.simulation_id AND v.version=r.suite_version WHERE r.suite_snapshot='{}'",
  )).rows;
  for (const row of legacyRuns) {
    await client.query('UPDATE simulation_runs SET suite_snapshot=$1 WHERE id=$2', [simulationSnapshot(row), row.id]);
  }
}

// v18 is deliberately additive. external_operations is a one-to-one index over
// tool_runs (the existing effect/approval/reconciliation authority), never a
// second queue or permission to execute an effect.
const v18Schema = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_org_id ON workflows(org_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_org_id ON employees(org_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_runs_org_id ON tool_runs(org_id,id);
CREATE TABLE IF NOT EXISTS organization_profiles (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, version INTEGER NOT NULL,
  profile_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(org_id,version)
);
CREATE TABLE IF NOT EXISTS onboarding_sessions (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  graph_thread_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'collecting', current_profile_version INTEGER,
  state_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(org_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_one_active_org ON onboarding_sessions(org_id) WHERE state IN ('collecting','validating','blueprint_review','provisioning');
CREATE TABLE IF NOT EXISTS onboarding_turns (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, session_id TEXT NOT NULL, client_turn_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, response_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(org_id,session_id,client_turn_id), FOREIGN KEY(org_id,session_id) REFERENCES onboarding_sessions(org_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS profile_claims (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, session_id TEXT NOT NULL, field_path TEXT NOT NULL,
  value_json TEXT NOT NULL, source_turn_id TEXT REFERENCES onboarding_turns(id) ON DELETE RESTRICT, confirmed INTEGER NOT NULL DEFAULT 0,
  provenance_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
  FOREIGN KEY(org_id,session_id) REFERENCES onboarding_sessions(org_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_profile_claim_lookup ON profile_claims(org_id,session_id,field_path);
CREATE TABLE IF NOT EXISTS organization_blueprints (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, version INTEGER NOT NULL,
  profile_version INTEGER NOT NULL, blueprint_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'proposed', created_at TEXT NOT NULL,
  PRIMARY KEY(org_id,version)
);
CREATE TABLE IF NOT EXISTS crew_tasks (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workflow_id TEXT, parent_task_id TEXT, owner_employee_id TEXT NOT NULL,
  capability TEXT NOT NULL, goal TEXT NOT NULL, input_refs TEXT NOT NULL DEFAULT '[]', success_criteria TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'queued', priority INTEGER NOT NULL DEFAULT 50, idempotency_key TEXT NOT NULL,
  correlation_id TEXT NOT NULL, spec_version INTEGER NOT NULL DEFAULT 1, runtime_version TEXT NOT NULL,
  lease_generation INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, deadline_at TEXT,
  result_json TEXT, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(org_id,id), UNIQUE(org_id,idempotency_key),
  FOREIGN KEY(org_id,workflow_id) REFERENCES workflows(org_id,id),
  FOREIGN KEY(org_id,parent_task_id) REFERENCES crew_tasks(org_id,id),
  FOREIGN KEY(org_id,owner_employee_id) REFERENCES employees(org_id,id)
);
CREATE INDEX IF NOT EXISTS idx_crew_tasks_ready ON crew_tasks(org_id,state,priority DESC,next_attempt_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_crew_tasks_workflow_once ON crew_tasks(workflow_id) WHERE workflow_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crew_tasks_employee_active ON crew_tasks(org_id,owner_employee_id,state);
CREATE TABLE IF NOT EXISTS task_dependencies (
  org_id TEXT NOT NULL, parent_task_id TEXT NOT NULL, child_task_id TEXT NOT NULL,
  required_outcome TEXT NOT NULL DEFAULT 'completed', created_at TEXT NOT NULL,
  PRIMARY KEY(org_id,parent_task_id,child_task_id), CHECK(parent_task_id<>child_task_id),
  FOREIGN KEY(org_id,parent_task_id) REFERENCES crew_tasks(org_id,id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,child_task_id) REFERENCES crew_tasks(org_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS provider_connections (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, provider_account_id TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment IN ('simulation','staging','production')),
  status TEXT NOT NULL DEFAULT 'setup_required', granted_scopes TEXT NOT NULL DEFAULT '[]', config TEXT NOT NULL DEFAULT '{}',
  credential_ciphertext TEXT, credential_key_id TEXT, credential_version INTEGER NOT NULL DEFAULT 1,
  credential_expires_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(org_id,id), UNIQUE(org_id,provider,provider_account_id,environment)
);
CREATE TABLE IF NOT EXISTS service_principals (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, UNIQUE(org_id,id)
);
CREATE TABLE IF NOT EXISTS event_subscriptions (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL, employee_id TEXT NOT NULL, connection_id TEXT NOT NULL,
  event_type TEXT NOT NULL, filter_json TEXT NOT NULL DEFAULT '{}', required_capability TEXT NOT NULL,
  authorized_by TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(org_id,principal_id) REFERENCES service_principals(org_id,id),
  FOREIGN KEY(org_id,connection_id) REFERENCES provider_connections(org_id,id),
  FOREIGN KEY(org_id,employee_id) REFERENCES employees(org_id,id),
  FOREIGN KEY(org_id,authorized_by) REFERENCES memberships(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS event_inbox (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL, connection_id TEXT NOT NULL, external_event_id TEXT NOT NULL, event_type TEXT NOT NULL,
  environment TEXT NOT NULL, simulated INTEGER NOT NULL DEFAULT 0, occurred_at TEXT, received_at TEXT NOT NULL,
  normalized TEXT NOT NULL, correlation_id TEXT, state TEXT NOT NULL DEFAULT 'received', attempts INTEGER NOT NULL DEFAULT 0,
  lease_generation INTEGER NOT NULL DEFAULT 0, lease_expires_at TEXT, next_attempt_at TEXT, processed_at TEXT, last_error TEXT,
  UNIQUE(connection_id,external_event_id), FOREIGN KEY(org_id,connection_id) REFERENCES provider_connections(org_id,id)
);
CREATE INDEX IF NOT EXISTS idx_event_inbox_pending ON event_inbox(state,received_at);
CREATE TABLE IF NOT EXISTS outbox_messages (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type TEXT NOT NULL, payload TEXT NOT NULL, dedup_key TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, lease_generation INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT, created_at TEXT NOT NULL, delivered_at TEXT, last_error TEXT, UNIQUE(org_id,dedup_key)
);
CREATE TABLE IF NOT EXISTS external_operations (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workflow_id TEXT NOT NULL, tool_run_id TEXT NOT NULL UNIQUE,
  connection_id TEXT NOT NULL, environment TEXT NOT NULL, task_id TEXT, action TEXT NOT NULL,
  input_hash TEXT NOT NULL, idempotency_key TEXT NOT NULL, policy_revision TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(org_id,connection_id,environment,idempotency_key),
  FOREIGN KEY(org_id,connection_id) REFERENCES provider_connections(org_id,id),
  FOREIGN KEY(org_id,workflow_id) REFERENCES workflows(org_id,id),
  FOREIGN KEY(org_id,tool_run_id) REFERENCES tool_runs(org_id,id),
  FOREIGN KEY(org_id,task_id) REFERENCES crew_tasks(org_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_external_operations_org_id ON external_operations(org_id,id);
CREATE TABLE IF NOT EXISTS operation_artifacts (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, operation_id TEXT NOT NULL, artifact_type TEXT NOT NULL,
  revision_hash TEXT NOT NULL, path TEXT, metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
  FOREIGN KEY(org_id,operation_id) REFERENCES external_operations(org_id,id)
);
CREATE TABLE IF NOT EXISTS operation_approvals (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, operation_id TEXT NOT NULL, connection_id TEXT NOT NULL,
  environment TEXT NOT NULL, task_id TEXT, action TEXT NOT NULL, policy_revision TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE, signer_user_id TEXT NOT NULL REFERENCES users(id), artifact_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY(org_id,operation_id) REFERENCES external_operations(org_id,id),
  FOREIGN KEY(org_id,connection_id) REFERENCES provider_connections(org_id,id)
);
CREATE TABLE IF NOT EXISTS memory_acl_metadata (
  memory_id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  visibility TEXT NOT NULL DEFAULT 'org', team_ids TEXT NOT NULL DEFAULT '[]', task_ids TEXT NOT NULL DEFAULT '[]',
  source_type TEXT NOT NULL, source_id TEXT NOT NULL, owner_user_id TEXT, owner_employee_id TEXT,
  expires_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS canonical_orders (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, connection_id TEXT NOT NULL, environment TEXT NOT NULL,
  remote_order_id TEXT NOT NULL, currency TEXT NOT NULL, total_minor INTEGER NOT NULL,
  payment_state TEXT NOT NULL, order_state TEXT NOT NULL, occurred_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  simulated INTEGER NOT NULL DEFAULT 0, last_event_id TEXT,
  UNIQUE(connection_id,remote_order_id), FOREIGN KEY(org_id,connection_id) REFERENCES provider_connections(org_id,id)
);
CREATE TABLE IF NOT EXISTS order_event_receipts (
  connection_id TEXT NOT NULL, external_event_id TEXT NOT NULL, order_id TEXT NOT NULL,
  event_type TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(connection_id,external_event_id),
  FOREIGN KEY(order_id) REFERENCES canonical_orders(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS feature_flag_org_allowlist (
  flag TEXT NOT NULL, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, created_at TEXT NOT NULL,
  PRIMARY KEY(flag,org_id)
);
CREATE INDEX IF NOT EXISTS idx_workflows_org_id ON workflows(org_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_org_id ON employees(org_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_runs_org_id ON tool_runs(org_id,id);
`;

const v19Schema = `
CREATE TABLE IF NOT EXISTS chief_generation_requests (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL, generation INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(org_id,request_key)
);
CREATE INDEX IF NOT EXISTS idx_memories_org_id ON memories(org_id,id);
CREATE INDEX IF NOT EXISTS idx_documents_org_id ON documents(org_id,id);
CREATE INDEX IF NOT EXISTS idx_memory_acl_scope ON memory_acl_metadata(org_id,visibility,expires_at);
CREATE INDEX IF NOT EXISTS idx_orders_org_connection_state ON canonical_orders(org_id,connection_id,environment,updated_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_dispatch ON event_subscriptions(org_id,connection_id,event_type,enabled);
CREATE INDEX IF NOT EXISTS idx_outbox_claim ON outbox_messages(state,next_attempt_at,created_at);
`;

const v20Columns = [
  ['workflows','created_by_principal_id','TEXT'],
  ['workflows','origin_subscription_id','TEXT'],
  ['crew_tasks','worker_id','TEXT'],
  ['crew_tasks','lease_expires_at','TEXT'],
  ['crew_tasks','event_inbox_id','TEXT'],
  ['crew_tasks','queue_owner',"TEXT NOT NULL DEFAULT 'legacy_workflow'"],
  ['crew_tasks','blocked_reason','TEXT'],
  ['event_subscriptions','required_scopes','TEXT NOT NULL DEFAULT \'[]\''],
  ['event_subscriptions','capability_grant_hash','TEXT'],
  ['operation_approvals','input_hash','TEXT NOT NULL DEFAULT \'\''],
  ['operation_approvals','credential_version','INTEGER NOT NULL DEFAULT 0'],
  ['operation_approvals','approved_by_user_id','TEXT'],
  ['operation_approvals','approved_at','TEXT'],
  ['operation_approvals','consumed_at','TEXT'],
];

const v20Schema = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_inbox_org_id ON event_inbox(org_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_subscriptions_org_id ON event_subscriptions(org_id,id);
CREATE TABLE IF NOT EXISTS employee_execution_locks (
  org_id TEXT NOT NULL, employee_id TEXT NOT NULL, workflow_id TEXT NOT NULL, task_id TEXT NOT NULL,
  worker_id TEXT NOT NULL, lease_generation INTEGER NOT NULL, lease_expires_at TEXT NOT NULL,
  acquired_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(org_id,employee_id),
  FOREIGN KEY(org_id,employee_id) REFERENCES employees(org_id,id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,workflow_id) REFERENCES workflows(org_id,id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,task_id) REFERENCES crew_tasks(org_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_employee_execution_lock_expiry ON employee_execution_locks(lease_expires_at);
CREATE TABLE IF NOT EXISTS organization_teams (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(org_id,id), UNIQUE(org_id,name)
);
CREATE TABLE IF NOT EXISTS employee_team_memberships (
  org_id TEXT NOT NULL, team_id TEXT NOT NULL, employee_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(org_id,team_id,employee_id),
  FOREIGN KEY(org_id,team_id) REFERENCES organization_teams(org_id,id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,employee_id) REFERENCES employees(org_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_employee_team_membership_member ON employee_team_memberships(org_id,employee_id,team_id);
CREATE TABLE IF NOT EXISTS event_dispatch_records (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, inbox_id TEXT NOT NULL, subscription_id TEXT NOT NULL,
  service_principal_id TEXT NOT NULL, manager_grant_user_id TEXT NOT NULL, task_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending', worker_owner TEXT NOT NULL DEFAULT 'event_dispatcher',
  lease_generation INTEGER NOT NULL DEFAULT 0, lease_expires_at TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT, blocked_reason TEXT, outcome_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(org_id,inbox_id,subscription_id),
  FOREIGN KEY(org_id,inbox_id) REFERENCES event_inbox(org_id,id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,subscription_id) REFERENCES event_subscriptions(org_id,id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,service_principal_id) REFERENCES service_principals(org_id,id),
  FOREIGN KEY(org_id,manager_grant_user_id) REFERENCES memberships(org_id,user_id),
  FOREIGN KEY(org_id,task_id) REFERENCES crew_tasks(org_id,id)
);
CREATE INDEX IF NOT EXISTS idx_event_dispatch_ready ON event_dispatch_records(state,next_attempt_at,created_at);
CREATE TABLE IF NOT EXISTS provider_tool_readiness (
  org_id TEXT NOT NULL, tool TEXT NOT NULL, connection_id TEXT NOT NULL, capability TEXT NOT NULL,
  required_scopes TEXT NOT NULL DEFAULT '[]', handler_id TEXT, verifier_id TEXT,
  readiness_state TEXT NOT NULL DEFAULT 'setup_required', probation_state TEXT NOT NULL DEFAULT 'not_run',
  updated_at TEXT NOT NULL, PRIMARY KEY(org_id,tool,connection_id),
  FOREIGN KEY(org_id,connection_id) REFERENCES provider_connections(org_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_provider_tool_ready ON provider_tool_readiness(org_id,tool,readiness_state,probation_state);
INSERT INTO crew_tasks(id,org_id,workflow_id,owner_employee_id,capability,goal,state,idempotency_key,correlation_id,spec_version,runtime_version,created_at,updated_at)
SELECT w.id,w.org_id,w.id,w.employee_id,'legacy.workflow',w.goal,
  CASE w.status WHEN 'working' THEN 'running' WHEN 'input_required' THEN 'waiting_approval' WHEN 'completed' THEN 'completed' WHEN 'failed' THEN 'failed' WHEN 'cancelled' THEN 'cancelled' WHEN 'reconciliation_required' THEN 'reconciling' ELSE 'queued' END,
  'legacy-workflow:' || w.id,w.id,COALESCE(w.spec_version,1),w.runtime_version,w.created_at,w.updated_at
FROM workflows w WHERE NOT EXISTS (SELECT 1 FROM crew_tasks t WHERE t.org_id=w.org_id AND t.workflow_id=w.id);
`;

const v21Columns = [['provider_tool_readiness','policy_revision',"TEXT NOT NULL DEFAULT ''"]];
const v22Columns = [['organization_blueprints','reviewed_by','TEXT'],['organization_blueprints','reviewed_at','TEXT']];
const v22Schema = `
CREATE TABLE IF NOT EXISTS storefront_revisions (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL, template_id TEXT NOT NULL, revision INTEGER NOT NULL,
  artifact_hash TEXT NOT NULL, files_json TEXT NOT NULL, local_check_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'local_preview', simulated INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  UNIQUE(org_id,connection_id,revision), UNIQUE(org_id,id),
  FOREIGN KEY(org_id,connection_id) REFERENCES provider_connections(org_id,id)
);
CREATE INDEX IF NOT EXISTS idx_storefront_revision_history ON storefront_revisions(org_id,connection_id,revision DESC);
CREATE TABLE IF NOT EXISTS commerce_catalog_projection (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, connection_id TEXT NOT NULL, environment TEXT NOT NULL,
  remote_product_id TEXT NOT NULL, product_json TEXT NOT NULL, verified_at TEXT NOT NULL, simulated INTEGER NOT NULL DEFAULT 1,
  UNIQUE(connection_id,remote_product_id), FOREIGN KEY(org_id,connection_id) REFERENCES provider_connections(org_id,id)
);
CREATE TABLE IF NOT EXISTS commerce_simulation_operations (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, connection_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  input_hash TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(org_id,connection_id,idempotency_key), FOREIGN KEY(org_id,connection_id) REFERENCES provider_connections(org_id,id)
);
`;
const v23Schema = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_subscription_identity ON event_subscriptions(org_id,connection_id,employee_id,event_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_principal_org_name ON service_principals(org_id,kind,name);
`;
const v24Schema = `
CREATE TABLE IF NOT EXISTS shopify_oauth_intents (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, connection_id TEXT NOT NULL, manager_user_id TEXT NOT NULL,
  store_domain TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment IN ('staging','production')),
  state_hash TEXT NOT NULL UNIQUE, requested_scopes TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','processing','completed','failed','superseded','expired')),
  expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(org_id,id),
  FOREIGN KEY(org_id,connection_id) REFERENCES provider_connections(org_id,id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,manager_user_id) REFERENCES memberships(org_id,user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shopify_oauth_one_active_intent ON shopify_oauth_intents(org_id,connection_id)
  WHERE status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS idx_shopify_oauth_intent_expiry ON shopify_oauth_intents(status,expires_at);
`;

// Voice sessions/callbacks are communication records. Protected effects remain
// in operation_approvals/external_operations/tool_runs; voice intents only point
// at an existing operation approval and never create a second effect ledger.
const v25Schema = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_operation_approvals_org_id ON operation_approvals(org_id,id);
CREATE TABLE IF NOT EXISTS sarvam_voice_sessions (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, connection_id TEXT NOT NULL, user_id TEXT NOT NULL,
  task_id TEXT, onboarding_session_id TEXT, approval_id TEXT, provider TEXT NOT NULL DEFAULT 'sarvam' CHECK(provider='sarvam'),
  environment TEXT NOT NULL CHECK(environment IN ('simulation','staging','production')),
  session_type TEXT NOT NULL CHECK(session_type IN ('browser','outbound')),
  state TEXT NOT NULL CHECK(state IN ('created','resolving','url_issued','queued','dialing','connected','no_answer','busy','failed','ended','reconciliation_required','expired')),
  sarvam_org_id TEXT NOT NULL, workspace_id TEXT NOT NULL, app_id TEXT NOT NULL, app_version INTEGER NOT NULL,
  app_config_json TEXT NOT NULL, config_hash TEXT NOT NULL, interaction_type TEXT NOT NULL DEFAULT 'CALL' CHECK(interaction_type='CALL'),
  browser_token_hash TEXT UNIQUE, reference_id TEXT, idempotency_key TEXT, request_hash TEXT,
  recipient_phone_hash TEXT, consent_status TEXT, consent_explicit INTEGER NOT NULL DEFAULT 0, consent_purpose TEXT, consent_captured_at TEXT,
  transcript_consent_status TEXT, transcript_consent_explicit INTEGER NOT NULL DEFAULT 0,
  transcript_consent_recipient_hash TEXT, transcript_consent_captured_at TEXT, transcript_retention_until TEXT,
  last_status TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT, ended_at TEXT,
  UNIQUE(org_id,id),
  FOREIGN KEY(org_id,connection_id) REFERENCES provider_connections(org_id,id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,user_id) REFERENCES memberships(org_id,user_id),
  FOREIGN KEY(org_id,task_id) REFERENCES crew_tasks(org_id,id),
  FOREIGN KEY(org_id,onboarding_session_id) REFERENCES onboarding_sessions(org_id,id),
  FOREIGN KEY(org_id,approval_id) REFERENCES operation_approvals(org_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sarvam_voice_idempotency ON sarvam_voice_sessions(org_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sarvam_voice_sessions_owner ON sarvam_voice_sessions(org_id,user_id,state,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sarvam_voice_sessions_connection ON sarvam_voice_sessions(org_id,connection_id,state,created_at DESC);
CREATE TABLE IF NOT EXISTS sarvam_voice_attempts (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, session_id TEXT NOT NULL, connection_id TEXT NOT NULL,
  task_id TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'sarvam' CHECK(provider='sarvam'),
  environment TEXT NOT NULL CHECK(environment IN ('simulation','staging','production')),
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','dialing','connected','no_answer','busy','failed','reconciliation_required')),
  attempt_id TEXT UNIQUE, interaction_id TEXT, reason_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, accepted_at TEXT,
  UNIQUE(org_id,id), UNIQUE(org_id,connection_id,environment,idempotency_key),
  FOREIGN KEY(org_id,session_id) REFERENCES sarvam_voice_sessions(org_id,id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,connection_id) REFERENCES provider_connections(org_id,id),
  FOREIGN KEY(org_id,task_id) REFERENCES crew_tasks(org_id,id)
);
CREATE INDEX IF NOT EXISTS idx_sarvam_voice_attempt_cooldown ON sarvam_voice_attempts(org_id,connection_id,state,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sarvam_voice_attempt_id ON sarvam_voice_attempts(org_id,attempt_id);
CREATE TABLE IF NOT EXISTS sarvam_voice_callbacks (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, session_id TEXT NOT NULL, attempt_row_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'sarvam' CHECK(provider='sarvam'), attempt_id TEXT NOT NULL,
  callback_id TEXT NOT NULL, interaction_id TEXT, status TEXT NOT NULL CHECK(status IN ('connected','no_answer','busy','failed')),
  transcript_json TEXT, transcript_consent_applied INTEGER NOT NULL DEFAULT 0,
  transcript_retention_until TEXT, received_at TEXT NOT NULL,
  UNIQUE(org_id,attempt_row_id,callback_id), UNIQUE(org_id,id),
  FOREIGN KEY(org_id,session_id) REFERENCES sarvam_voice_sessions(org_id,id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,attempt_row_id) REFERENCES sarvam_voice_attempts(org_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sarvam_voice_callback_retention ON sarvam_voice_callbacks(org_id,session_id,transcript_retention_until);
CREATE TABLE IF NOT EXISTS sarvam_voice_decision_intents (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, session_id TEXT NOT NULL, approval_id TEXT NOT NULL, task_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL, intent_hash TEXT NOT NULL,
  intent TEXT NOT NULL CHECK(intent IN ('approve','reject','more_information','unclear')),
  transcript_ref TEXT, created_at TEXT NOT NULL,
  UNIQUE(org_id,id), UNIQUE(org_id,idempotency_key),
  FOREIGN KEY(org_id,session_id) REFERENCES sarvam_voice_sessions(org_id,id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,approval_id) REFERENCES operation_approvals(org_id,id),
  FOREIGN KEY(org_id,task_id) REFERENCES crew_tasks(org_id,id)
);
CREATE INDEX IF NOT EXISTS idx_sarvam_voice_intents_approval ON sarvam_voice_decision_intents(org_id,session_id,approval_id,created_at DESC);
`;

// Employee-to-employee delegation is authorized independently from task
// prerequisites. In particular, task_dependencies keeps its existing
// parent-prerequisite -> child-dependent direction.
const v26Schema = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_v26_employees_org_id ON employees(org_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_v26_subscriptions_org_id ON event_subscriptions(org_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_v26_dispatch_org_id ON event_dispatch_records(org_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_v26_subscription_delegation_binding ON event_subscriptions(org_id,id,employee_id,principal_id,connection_id,required_capability);
CREATE UNIQUE INDEX IF NOT EXISTS idx_v26_connection_environment_binding ON provider_connections(org_id,id,environment);
CREATE TABLE IF NOT EXISTS task_delegations (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, parent_task_id TEXT NOT NULL, child_task_id TEXT NOT NULL,
  delegation_slot TEXT NOT NULL, request_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'waiting' CHECK(state IN ('waiting','resolved','failed')),
  evidence_json TEXT NOT NULL DEFAULT '{}', resolution_json TEXT NOT NULL DEFAULT '{}',
  dispatch_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, resolved_at TEXT,
  UNIQUE(org_id,id), UNIQUE(org_id,parent_task_id,delegation_slot), UNIQUE(org_id,child_task_id),
  FOREIGN KEY(org_id,parent_task_id) REFERENCES crew_tasks(org_id,id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,child_task_id) REFERENCES crew_tasks(org_id,id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,dispatch_id) REFERENCES event_dispatch_records(org_id,id)
);
CREATE INDEX IF NOT EXISTS idx_task_delegations_state ON task_delegations(org_id,state,updated_at);
CREATE TABLE IF NOT EXISTS employee_delegation_grants (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, grant_scope TEXT NOT NULL CHECK(grant_scope IN ('employee','event')),
  source_employee_id TEXT NOT NULL, target_employee_id TEXT NOT NULL, capability TEXT NOT NULL,
  subscription_id TEXT, principal_id TEXT, connection_id TEXT, environment TEXT,
  manager_signer_user_id TEXT NOT NULL, authorized_by_user_id TEXT NOT NULL,
  authorization_json TEXT NOT NULL DEFAULT '{}', source_spec_revision TEXT NOT NULL, source_deployment_revision TEXT NOT NULL,
  target_spec_revision TEXT NOT NULL, target_deployment_revision TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0), revoked_by_user_id TEXT, revoked_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(org_id,id), CHECK(source_employee_id<>target_employee_id),
  CHECK((grant_scope='employee' AND subscription_id IS NULL AND principal_id IS NULL AND connection_id IS NULL AND environment IS NULL)
     OR (grant_scope='event' AND subscription_id IS NOT NULL AND principal_id IS NOT NULL AND connection_id IS NOT NULL AND environment IS NOT NULL AND environment IN ('simulation','staging','production'))),
  FOREIGN KEY(org_id,source_employee_id) REFERENCES employees(org_id,id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,target_employee_id) REFERENCES employees(org_id,id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,subscription_id,source_employee_id,principal_id,connection_id,capability) REFERENCES event_subscriptions(org_id,id,employee_id,principal_id,connection_id,required_capability) ON DELETE CASCADE,
  FOREIGN KEY(org_id,connection_id,environment) REFERENCES provider_connections(org_id,id,environment),
  FOREIGN KEY(org_id,manager_signer_user_id) REFERENCES memberships(org_id,user_id),
  FOREIGN KEY(org_id,authorized_by_user_id) REFERENCES memberships(org_id,user_id),
  FOREIGN KEY(org_id,revoked_by_user_id) REFERENCES memberships(org_id,user_id)
);
CREATE INDEX IF NOT EXISTS idx_employee_delegation_grants_lookup ON employee_delegation_grants(org_id,source_employee_id,target_employee_id,capability,state);
`;

const v27Schema = `
ALTER TABLE employee_delegation_grants ADD COLUMN delegated_capability TEXT NOT NULL DEFAULT '';
UPDATE employee_delegation_grants SET delegated_capability=capability WHERE delegated_capability='';
`;

// v28 makes event workflow execution and delegation recoverable under separate
// dispatch, workflow, and slot generations. Legacy delegation rows stay marked
// legacy and cannot be treated as verified workflow evidence.
const v28Columns = [
  ['event_dispatch_records','dispatch_deadline_at','TEXT'],
  ['event_dispatch_records','recovery_deadline_at','TEXT'],
  ['event_dispatch_records','primary_workflow_id','TEXT'],
  ['workflows','execution_generation','INTEGER NOT NULL DEFAULT 0'],
  ['workflows','execution_role',"TEXT NOT NULL DEFAULT 'legacy'"],
  ['workflows','provenance_json',"TEXT NOT NULL DEFAULT '{}'"],
  ['workflows','continuation_json',"TEXT NOT NULL DEFAULT '{}'"],
  ['task_delegations','dispatch_slot_key','TEXT'],
  ['task_delegations','slot_generation','INTEGER NOT NULL DEFAULT 0'],
  ['task_delegations','parent_workflow_id','TEXT'],
  ['task_delegations','child_workflow_id','TEXT'],
  ['task_delegations','grant_id','TEXT'],
  ['task_delegations','child_execution_generation','INTEGER'],
  ['task_delegations','request_json',"TEXT NOT NULL DEFAULT '{}'"],
  ['task_delegations','legacy','INTEGER NOT NULL DEFAULT 1'],
];
const v28Schema = `
CREATE TABLE IF NOT EXISTS event_workflow_evidence (
  id TEXT PRIMARY KEY, org_id TEXT NOT NULL, dispatch_id TEXT NOT NULL, workflow_id TEXT NOT NULL,
  connection_id TEXT NOT NULL, source_event_id TEXT NOT NULL, event_version TEXT NOT NULL,
  observation_hash TEXT NOT NULL, step_input_hash TEXT NOT NULL,
  execution_generation INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('primary','child')),
  verifier_id TEXT NOT NULL, bindings_json TEXT NOT NULL, evidence_refs_json TEXT NOT NULL,
  result_json TEXT NOT NULL, continuation_json TEXT NOT NULL DEFAULT '{}', verified_at TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(org_id,id), UNIQUE(org_id,workflow_id,execution_generation),
  FOREIGN KEY(org_id,dispatch_id) REFERENCES event_dispatch_records(org_id,id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,workflow_id) REFERENCES workflows(org_id,id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,connection_id) REFERENCES provider_connections(org_id,id)
);
CREATE TABLE IF NOT EXISTS event_workflow_evidence_runs (
  org_id TEXT NOT NULL, evidence_id TEXT NOT NULL, tool_run_id TEXT NOT NULL,
  PRIMARY KEY(org_id,evidence_id,tool_run_id),
  FOREIGN KEY(org_id,evidence_id) REFERENCES event_workflow_evidence(org_id,id) ON DELETE CASCADE,
  FOREIGN KEY(org_id,tool_run_id) REFERENCES tool_runs(org_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_event_dispatch_recovery_deadline ON event_dispatch_records(state,recovery_deadline_at);
CREATE INDEX IF NOT EXISTS idx_event_dispatch_lease_expiry ON event_dispatch_records(state,lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_event_workflow_evidence_dispatch ON event_workflow_evidence(org_id,dispatch_id,created_at);
CREATE INDEX IF NOT EXISTS idx_task_delegations_dispatch_slot ON task_delegations(org_id,dispatch_id,dispatch_slot_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_delegations_org_dispatch_slot ON task_delegations(org_id,dispatch_id,dispatch_slot_key)
  WHERE dispatch_id IS NOT NULL AND dispatch_slot_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_event_dispatch_ready_v28 ON event_dispatch_records(state,next_attempt_at,recovery_deadline_at,created_at);
CREATE INDEX IF NOT EXISTS idx_event_evidence_runs_tool_run ON event_workflow_evidence_runs(org_id,tool_run_id);
`;

const migrations = [
  {
    version: 1,
    name: 'core-schema',
    sqlite: () => db.exec(schema),
    postgres: (client) => client.query(schema),
  },
  {
    version: 2,
    name: 'workflow-and-suite-columns',
    sqlite: () => {
      for (const [table, column, declaration] of migratedColumns) {
        if (!db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)) {
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
        }
      }
    },
    postgres: async (client) => {
      for (const [table, column, declaration] of migratedColumns) {
        await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${declaration}`);
      }
    },
  },
  {
    version: 3,
    name: 'numeric-simulated-refunds',
    sqlite: () => {},
    postgres: migrateRefundAmounts,
  },
  {
    version: 4,
    name: 'ownership-and-coworker-invariants',
    sqlite: () => {
      const duplicateOwner = db.prepare("SELECT org_id,COUNT(*) AS owners FROM memberships WHERE role='owner' GROUP BY org_id HAVING COUNT(*)>1 LIMIT 1").get();
      if (duplicateOwner) throw new Error(`Cannot enforce one owner per organization: ${duplicateOwner.org_id} currently has ${duplicateOwner.owners}. Resolve duplicate owner memberships before starting.`);
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_single_owner ON memberships(org_id) WHERE role='owner'");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_pre_meeting_once ON agent_messages(meeting_id,from_employee_id) WHERE kind='pre_meeting'");
      db.exec('CREATE INDEX IF NOT EXISTS idx_tool_runs_retry_due ON tool_runs(workflow_id,step_index,status,retry_at)');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_coworkers_org_id ON coworkers(org_id,id)');
      db.exec(coworkerRelationshipsSchema);
    },
    postgres: async (client) => {
      const duplicateOwner = (await client.query("SELECT org_id,COUNT(*) AS owners FROM memberships WHERE role='owner' GROUP BY org_id HAVING COUNT(*)>1 LIMIT 1")).rows[0];
      if (duplicateOwner) throw new Error(`Cannot enforce one owner per organization: ${duplicateOwner.org_id} currently has ${duplicateOwner.owners}. Resolve duplicate owner memberships before starting.`);
      await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_single_owner ON memberships(org_id) WHERE role='owner'");
      await client.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_pre_meeting_once ON agent_messages(meeting_id,from_employee_id) WHERE kind='pre_meeting'");
      await client.query('CREATE INDEX IF NOT EXISTS idx_tool_runs_retry_due ON tool_runs(workflow_id,step_index,status,retry_at)');
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_coworkers_org_id ON coworkers(org_id,id)');
      await client.query(coworkerRelationshipsSchema);
    },
  },
  {
    version: 5,
    name: 'simulation-version-backfill',
    sqlite: () => {
      db.exec("INSERT OR IGNORE INTO simulation_versions(id,org_id,simulation_id,version,name,description,scenario,rubric,threshold,created_by,created_at) SELECT 'simver_' || s.id || '_' || s.version,s.org_id,s.id,s.version,s.name,s.description,s.scenario,s.rubric,s.threshold,s.created_by,s.updated_at FROM simulations s");
      const legacyRuns = db.prepare("SELECT r.id,r.suite_version,v.name,v.description,v.scenario,v.rubric,v.threshold FROM simulation_runs r JOIN simulation_versions v ON v.simulation_id=r.simulation_id AND v.version=r.suite_version WHERE r.suite_snapshot='{}'").all();
      for (const row of legacyRuns) db.prepare('UPDATE simulation_runs SET suite_snapshot=? WHERE id=?').run(simulationSnapshot(row), row.id);
    },
    postgres: backfillSimulationSnapshots,
  },
  {
    version: 6,
    name: 'neon-auth-user-link',
    sqlite: () => {
      if (!db.prepare('PRAGMA table_info(users)').all().some((row) => row.name === 'auth_user_id')) {
        db.exec('ALTER TABLE users ADD COLUMN auth_user_id TEXT');
      }
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auth_user_id ON users(auth_user_id) WHERE auth_user_id IS NOT NULL');
    },
    postgres: async (client) => {
      await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_user_id TEXT');
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auth_user_id ON users(auth_user_id) WHERE auth_user_id IS NOT NULL');
    },
  },
  {
    version: 7,
    name: 'neon-signup-intents',
    sqlite: () => db.exec(`CREATE TABLE IF NOT EXISTS signup_intents (
      email TEXT PRIMARY KEY, name TEXT NOT NULL, organization TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    )`),
    postgres: (client) => client.query(`CREATE TABLE IF NOT EXISTS signup_intents (
      email TEXT PRIMARY KEY, name TEXT NOT NULL, organization TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
    )`),
  },
  {
    version: 8,
    name: 'meeting-worker-leases',
    sqlite: () => {
      for (const column of ['meeting_worker_id', 'meeting_lease_expires_at']) {
        if (!db.prepare('PRAGMA table_info(meetings)').all().some((row) => row.name === column)) {
          db.exec(`ALTER TABLE meetings ADD COLUMN ${column} TEXT`);
        }
      }
    },
    postgres: async (client) => {
      await client.query('ALTER TABLE meetings ADD COLUMN IF NOT EXISTS meeting_worker_id TEXT');
      await client.query('ALTER TABLE meetings ADD COLUMN IF NOT EXISTS meeting_lease_expires_at TEXT');
    },
  },
  {
    version: 9,
    name: 'structured-agent-delegation',
    sqlite: () => {
      const columns = new Set(db.prepare('PRAGMA table_info(agent_messages)').all().map((row) => row.name));
      for (const [column, declaration] of [
        ['type', "TEXT NOT NULL DEFAULT 'message'"],
        ['delegation_goal', 'TEXT'],
        ['delegation_status', "TEXT NOT NULL DEFAULT ''"],
        ['workflow_id', 'TEXT REFERENCES workflows(id) ON DELETE SET NULL'],
      ]) {
        if (!columns.has(column)) db.exec(`ALTER TABLE agent_messages ADD COLUMN ${column} ${declaration}`);
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_agent_delegation_status ON agent_messages(org_id,type,delegation_status,created_at)');
    },
    postgres: async (client) => {
      await client.query("ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'message'");
      await client.query('ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS delegation_goal TEXT');
      await client.query("ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS delegation_status TEXT NOT NULL DEFAULT ''");
      await client.query('ALTER TABLE agent_messages ADD COLUMN IF NOT EXISTS workflow_id TEXT REFERENCES workflows(id) ON DELETE SET NULL');
      await client.query('CREATE INDEX IF NOT EXISTS idx_agent_delegation_status ON agent_messages(org_id,type,delegation_status,created_at)');
    },
  },
  {
    version: 10,
    name: 'openrouter-provider-migration',
    sqlite: () => db.exec(`UPDATE integrations SET provider='openrouter',display_name='OpenRouter',status='reconnect'
      WHERE provider='openai' AND NOT EXISTS (
        SELECT 1 FROM integrations current WHERE current.org_id=integrations.org_id AND current.provider='openrouter'
      )`),
    postgres: (client) => client.query(`UPDATE integrations SET provider='openrouter',display_name='OpenRouter',status='reconnect'
      WHERE provider='openai' AND NOT EXISTS (
        SELECT 1 FROM integrations current WHERE current.org_id=integrations.org_id AND current.provider='openrouter'
      )`),
  },
  {
    version: 11,
    name: 'remove-default-per-call-approvals',
    sqlite: () => db.exec(`UPDATE policies SET active=0 WHERE effect='REQUIRE_APPROVAL' AND condition='{}' AND (
      (name='Review desktop commands' AND tool='solari.desktop.exec') OR
      (name='Review browser UI interactions' AND tool='solari.browser.interact') OR
      (name='Review work item deletion' AND tool='jira.delete_issue')
    )`),
    postgres: (client) => client.query(`UPDATE policies SET active=0 WHERE effect='REQUIRE_APPROVAL' AND condition='{}' AND (
      (name='Review desktop commands' AND tool='solari.desktop.exec') OR
      (name='Review browser UI interactions' AND tool='solari.browser.interact') OR
      (name='Review work item deletion' AND tool='jira.delete_issue')
    )`),
  },
  {
    version: 12,
    name: 'workflow-runtime-version',
    sqlite: () => {
      if (!db.prepare('PRAGMA table_info(workflows)').all().some((row) => row.name === 'runtime_version')) {
        db.exec("ALTER TABLE workflows ADD COLUMN runtime_version TEXT NOT NULL DEFAULT 'legacy'");
      }
    },
    postgres: (client) => client.query("ALTER TABLE workflows ADD COLUMN IF NOT EXISTS runtime_version TEXT NOT NULL DEFAULT 'legacy'"),
  },
  {
    version: 13,
    name: 'workflow-final-snapshots',
    sqlite: () => db.exec(`CREATE TABLE IF NOT EXISTS workflow_snapshots (
      workflow_id TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      schema_version INTEGER NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_workflow_snapshots_org_updated ON workflow_snapshots(org_id,updated_at DESC);`),
    postgres: async (client) => {
      await client.query(`CREATE TABLE IF NOT EXISTS workflow_snapshots (
        workflow_id TEXT PRIMARY KEY REFERENCES workflows(id) ON DELETE CASCADE,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        schema_version INTEGER NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`);
      await client.query('CREATE INDEX IF NOT EXISTS idx_workflow_snapshots_org_updated ON workflow_snapshots(org_id,updated_at DESC)');
    },
  },
  {
    version: 14,
    name: 'employee-runtime-setups',
    sqlite: () => db.exec(`CREATE TABLE IF NOT EXISTS employee_runtime_setups (
      employee_id TEXT PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
      org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      browser_profile_id TEXT REFERENCES solari_profiles(id) ON DELETE SET NULL,
      desktop_environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'provisioning', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_employee_runtime_setup_org ON employee_runtime_setups(org_id,status,updated_at DESC);`),
    postgres: async (client) => {
      await client.query(`CREATE TABLE IF NOT EXISTS employee_runtime_setups (
        employee_id TEXT PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        browser_profile_id TEXT REFERENCES solari_profiles(id) ON DELETE SET NULL,
        desktop_environment_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'provisioning', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`);
      await client.query('CREATE INDEX IF NOT EXISTS idx_employee_runtime_setup_org ON employee_runtime_setups(org_id,status,updated_at DESC)');
    },
  },
  {
    version: 15,
    name: 'private-pilot-durability',
    sqlite: () => {
      for (const [table,column,declaration] of pilotColumns) {
        if (!db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
      }
      db.exec(pilotSchema);
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_idempotency ON workflows(org_id,idempotency_key) WHERE idempotency_key IS NOT NULL');
    },
    postgres: async (client) => {
      for (const [table,column,declaration] of pilotColumns) await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${declaration}`);
      await client.query(pilotSchema);
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_idempotency ON workflows(org_id,idempotency_key) WHERE idempotency_key IS NOT NULL');
    },
  },
  {
    version: 16,
    name: 'durable-work-schedules',
    sqlite: () => db.exec(scheduleSchema),
    postgres: async (client) => { await client.query(scheduleSchema); },
  },
  {
    version: 17,
    name: 'chief-onboarding',
    sqlite: () => db.exec(`CREATE TABLE IF NOT EXISTS chief_sessions (
      org_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'active', stage INTEGER NOT NULL DEFAULT 0,
      answers TEXT NOT NULL DEFAULT '{}', document_ids TEXT NOT NULL DEFAULT '[]', revision INTEGER NOT NULL DEFAULT 1,
      generation_count INTEGER NOT NULL DEFAULT 0, generation_token TEXT, generation_started_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chief_proposals (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'proposed', role TEXT NOT NULL,
      draft TEXT NOT NULL DEFAULT '{}', employee_id TEXT REFERENCES employees(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(org_id,generation,role)
    );
    CREATE INDEX IF NOT EXISTS idx_chief_proposals_org ON chief_proposals(org_id,generation,status);`),
    postgres: async (client) => {
      await client.query(`CREATE TABLE IF NOT EXISTS chief_sessions (
        org_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'active', stage INTEGER NOT NULL DEFAULT 0,
        answers TEXT NOT NULL DEFAULT '{}', document_ids TEXT NOT NULL DEFAULT '[]', revision INTEGER NOT NULL DEFAULT 1,
        generation_count INTEGER NOT NULL DEFAULT 0, generation_token TEXT, generation_started_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS chief_proposals (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'proposed', role TEXT NOT NULL,
        draft TEXT NOT NULL DEFAULT '{}', employee_id TEXT REFERENCES employees(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(org_id,generation,role)
      )`);
      await client.query('CREATE INDEX IF NOT EXISTS idx_chief_proposals_org ON chief_proposals(org_id,generation,status)');
    },
  },
  {
    version: 18,
    name: 'organization-task-event-operation-foundations',
    sqlite: () => db.exec(v18Schema),
    postgres: async (client) => { await client.query(v18Schema); },
  },
  {
    version: 19,
    name: 'task-memory-metrics-foundations',
    sqlite: () => db.exec(v19Schema),
    postgres: async (client) => { await client.query(v19Schema); },
  },
  {
    version: 20,
    name: 'execution-dispatch-approval-and-team-acl-gates',
    sqlite: () => {
      for (const [table,column,declaration] of v20Columns) if (!db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
      db.exec(v20Schema);
    },
    postgres: async (client) => {
      for (const [table,column,declaration] of v20Columns) await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${declaration}`);
      await client.query(v20Schema);
    },
  },
  {
    version: 21,
    name: 'provider-tool-readiness-policy-revision',
    sqlite: () => { for (const [table,column,declaration] of v21Columns) if (!db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`); },
    postgres: async (client) => { for (const [table,column,declaration] of v21Columns) await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${declaration}`); },
  },
  {
    version: 22,
    name: 'local-commerce-theme-projection-and-blueprint-review',
    sqlite: () => { for (const [table,column,declaration] of v22Columns) if (!db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`); db.exec(v22Schema); },
    postgres: async (client) => { for (const [table,column,declaration] of v22Columns) await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${declaration}`); await client.query(v22Schema); },
  },
  {
    version: 23,
    name: 'event-subscription-idempotency',
    sqlite: () => db.exec(v23Schema),
    postgres: async (client) => { await client.query(v23Schema); },
  },
  {
    version: 24,
    name: 'shopify-org-scoped-oauth-intents',
    sqlite: () => db.exec(v24Schema),
    postgres: async (client) => { await client.query(v24Schema); },
  },
  {
    version: 25,
    name: 'sarvam-org-scoped-voice-sessions-and-intents',
    sqlite: () => db.exec(v25Schema),
    postgres: async (client) => { await client.query(v25Schema); },
  },
  {
    version: 26,
    name: 'employee-delegation-foundations',
    sqlite: () => db.exec(v26Schema),
    postgres: async (client) => { await client.query(v26Schema); },
  },
  {
    version: 27,
    name: 'delegation-capability-scope',
    sqlite: () => {
      if (!db.prepare('PRAGMA table_info(employee_delegation_grants)').all().some((row) => row.name === 'delegated_capability')) {
        db.exec(v27Schema);
      }
    },
    postgres: async (client) => {
      await client.query('ALTER TABLE employee_delegation_grants ADD COLUMN IF NOT EXISTS delegated_capability TEXT NOT NULL DEFAULT \'\'');
      await client.query("UPDATE employee_delegation_grants SET delegated_capability=capability WHERE delegated_capability=''");
    },
  },
  { version: 28, name: 'event-workflow-durable-execution-and-delegation-fencing',
    sqlite: () => {
      for (const [table,column,declaration] of v28Columns) {
        if (!db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
      }
      db.exec(v28Schema);
    },
    postgres: async (client) => {
      for (const [table,column,declaration] of v28Columns) await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${declaration}`);
      await client.query(v28Schema);
    },
  },
  { version: 29, name: 'twilio-whatsapp-inbound', sqlite: () => db.exec(twilioSchema), postgres: client => client.query(twilioSchema) },
  { version: 30, name: 'shopify-development-store-provisioning', sqlite: () => db.exec(shopifyDevStoreSchema), postgres: client => client.query(shopifyDevStoreSchema) },
  { version: 31, name: 'shopify-development-theme-previews', sqlite: () => db.exec(shopifyDevThemeSchema), postgres: client => client.query(shopifyDevThemeSchema) },
  { version: 32, name: 'twilio-whatsapp-sales-and-support-assignments', sqlite: () => db.exec(twilioSchema), postgres: client => client.query(twilioSchema) },
];

function validateMigrationHistory(rows) {
  if (rows.length > migrations.length) throw new Error(`Database has unknown migration version ${rows.at(-1).version}.`);
  for (let index = 0; index < rows.length; index += 1) {
    const applied = rows[index];
    const expected = migrations[index];
    if (Number(applied.version) !== expected.version || applied.name !== expected.name) {
      throw new Error(`Database migration history is inconsistent at version ${expected.version}.`);
    }
  }
}

function migrateSqlite() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  while (true) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const applied = db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all();
      validateMigrationHistory(applied);
      const migration = migrations[applied.length];
      if (!migration) {
        db.exec('COMMIT');
        return;
      }
      migration.sqlite();
      db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)').run(migration.version, migration.name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

async function migratePostgres() {
  const client = await postgresPool.connect();
  const lockId = 742311231;
  try {
    while (true) {
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_advisory_xact_lock($1)', [lockId]);
        await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
        const applied = (await client.query('SELECT version,name FROM schema_migrations ORDER BY version')).rows;
        validateMigrationHistory(applied);
        const migration = migrations[applied.length];
        if (!migration) {
          await client.query('COMMIT');
          return;
        }
        await migration.postgres(client);
        await client.query('INSERT INTO schema_migrations(version,name,applied_at) VALUES($1,$2,$3)', [migration.version, migration.name, new Date().toISOString()]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    }
  } finally {
    client.release();
  }
}

if (db) migrateSqlite();
else await migratePostgres();

export const now = () => new Date().toISOString();
export const id = (prefix = 'id') => `${prefix}_${randomUUID().replaceAll('-', '')}`;

async function postgresQuery(sql, params) {
  const executor = postgresTransactions.getStore() || postgresPool;
  return executor.query(postgresSql(sql), params);
}

export async function get(sql, ...params) {
  if (postgresPool) return (await postgresQuery(sql, params)).rows[0];
  return withSqliteQueue(() => db.prepare(sqliteSql(sql)).get(...params));
}
export async function all(sql, ...params) {
  if (postgresPool) return (await postgresQuery(sql, params)).rows;
  return withSqliteQueue(() => db.prepare(sqliteSql(sql)).all(...params));
}
export async function run(sql, ...params) {
  if (postgresPool) {
    const result = await postgresQuery(sql, params);
    return { changes: result.rowCount ?? 0 };
  }
  return withSqliteQueue(() => db.prepare(sqliteSql(sql)).run(...params));
}
export function afterCommit(callback) {
  const callbacks = transactionCallbacks.getStore();
  if (callbacks) callbacks.push(callback); else callback();
}

export async function transaction(fn) {
  if (postgresTransactions.getStore() || sqliteTransactions.getStore()) return fn();
  const callbacks=[];
  const value = await transactionCallbacks.run(callbacks, () => transactionBody(fn));
  for (const callback of callbacks) callback();
  return value;
}

async function transactionBody(fn) {
  if (postgresPool) {
    const client = await postgresPool.connect();
    try {
      await client.query('BEGIN');
      const result = await postgresTransactions.run(client, fn);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  return withSqliteQueue(() => sqliteTransactions.run(true, async () => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }));
}
export async function lockOrganization(orgId) {
  if (postgresPool) return (await postgresQuery('SELECT id FROM organizations WHERE id=? FOR UPDATE', [orgId])).rows[0];
  return get('SELECT id FROM organizations WHERE id=?', orgId);
}
export async function lockEmployee(orgId, employeeId) {
  if (postgresPool) return (await postgresQuery('SELECT id FROM employees WHERE org_id=? AND id=? FOR UPDATE', [orgId, employeeId])).rows[0];
  return get('SELECT id FROM employees WHERE org_id=? AND id=?', orgId, employeeId);
}
export async function closeDatabase() {
  if (postgresPool) await postgresPool.end();
  else db.close();
}
