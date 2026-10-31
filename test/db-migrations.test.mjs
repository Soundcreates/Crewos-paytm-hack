import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const migrationVersions = [
  'core-schema',
  'workflow-and-suite-columns',
  'numeric-simulated-refunds',
  'ownership-and-coworker-invariants',
  'simulation-version-backfill',
  'neon-auth-user-link',
  'neon-signup-intents',
  'meeting-worker-leases',
  'structured-agent-delegation',
  'openrouter-provider-migration',
  'remove-default-per-call-approvals',
  'workflow-runtime-version',
  'workflow-final-snapshots',
  'employee-runtime-setups',
  'private-pilot-durability',
  'durable-work-schedules',
  'chief-onboarding',
  'organization-task-event-operation-foundations',
  'task-memory-metrics-foundations',
  'execution-dispatch-approval-and-team-acl-gates',
  'provider-tool-readiness-policy-revision',
  'local-commerce-theme-projection-and-blueprint-review',
  'event-subscription-idempotency',
  'shopify-org-scoped-oauth-intents',
  'sarvam-org-scoped-voice-sessions-and-intents',
  'employee-delegation-foundations',
  'delegation-capability-scope',
  'event-workflow-durable-execution-and-delegation-fencing',
  'twilio-whatsapp-inbound',
  'shopify-development-store-provisioning',
  'shopify-development-theme-previews',
  'twilio-whatsapp-sales-and-support-assignments',
];

function initializeDatabase(filename) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { all, closeDatabase } from './backend/lib/db.mjs';
    const rows = await all('SELECT version,name FROM schema_migrations ORDER BY version');
    await closeDatabase();
    console.log(JSON.stringify(rows));
  `], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_FILE: filename, DATABASE_URL: '', NODE_ENV: 'test' },
  });
  return result;
}

function createLegacyDatabase(filename, { duplicatePreMeeting = false } = {}) {
  const legacy = new DatabaseSync(filename);
  legacy.exec(`
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE memberships (org_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(org_id,user_id));
    CREATE TABLE employees (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, title TEXT NOT NULL, department TEXT NOT NULL DEFAULT 'Operations', state TEXT NOT NULL DEFAULT 'draft', avatar TEXT NOT NULL DEFAULT '◉', x REAL NOT NULL DEFAULT 0.3, y REAL NOT NULL DEFAULT 0.5, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE workflows (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, employee_id TEXT NOT NULL, created_by TEXT NOT NULL, goal TEXT NOT NULL, status TEXT NOT NULL, plan TEXT NOT NULL DEFAULT '[]', step_index INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT, input_requests TEXT NOT NULL DEFAULT '{}', input_responses TEXT NOT NULL DEFAULT '{}', started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE simulations (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, scenario TEXT NOT NULL, rubric TEXT NOT NULL, threshold REAL NOT NULL DEFAULT 0.8, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE simulation_runs (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, simulation_id TEXT NOT NULL, employee_id TEXT NOT NULL, spec_version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL, score REAL NOT NULL DEFAULT 0, passed INTEGER NOT NULL DEFAULT 0, evidence TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, finished_at TEXT);
    CREATE TABLE simulated_refunds (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workflow_id TEXT NOT NULL, step_index INTEGER NOT NULL, employee_id TEXT NOT NULL, case_id TEXT NOT NULL, amount REAL NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'simulated', created_at TEXT NOT NULL);
    CREATE TABLE tool_runs (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, workflow_id TEXT, step_index INTEGER, tool TEXT NOT NULL, input TEXT NOT NULL, output TEXT, duration_ms INTEGER, status TEXT NOT NULL DEFAULT 'started', created_at TEXT NOT NULL);
    CREATE TABLE coworkers (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, employee_id TEXT, name TEXT NOT NULL, role TEXT NOT NULL, expertise TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE meetings (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, agenda TEXT NOT NULL DEFAULT '[]', participant_ids TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'scheduled', decisions TEXT NOT NULL DEFAULT '[]', created_by TEXT NOT NULL, starts_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE agent_messages (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, meeting_id TEXT, from_employee_id TEXT, to_employee_id TEXT, body TEXT NOT NULL, evidence_ids TEXT NOT NULL DEFAULT '[]', kind TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL);
  `);
  const timestamp = '2026-01-01T00:00:00.000Z';
  legacy.prepare('INSERT INTO organizations VALUES(?,?,?)').run('org_legacy', 'Legacy', timestamp);
  legacy.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run('user_legacy', 'Legacy user', 'legacy@example.test', 'salt', 'hash', timestamp);
  legacy.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run('org_legacy', 'user_legacy', 'owner', timestamp);
  legacy.prepare('INSERT INTO employees(id,org_id,name,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('emp_legacy', 'org_legacy', 'Legacy employee', 'Support', timestamp, timestamp);
  legacy.prepare('INSERT INTO workflows(id,org_id,employee_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('wf_legacy', 'org_legacy', 'emp_legacy', 'user_legacy', 'legacy run', 'completed', timestamp, timestamp);
  legacy.prepare('INSERT INTO simulations(id,org_id,name,description,scenario,rubric,threshold,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('sim_legacy', 'org_legacy', 'Legacy suite', 'Original suite', '{"steps":["verify"]}', '{"score":1}', 0.9, 'user_legacy', timestamp, timestamp);
  legacy.prepare('INSERT INTO simulation_runs(id,org_id,simulation_id,employee_id,status,created_at) VALUES(?,?,?,?,?,?)').run('run_legacy', 'org_legacy', 'sim_legacy', 'emp_legacy', 'completed', timestamp);

  if (duplicatePreMeeting) {
    legacy.prepare('INSERT INTO meetings(id,org_id,title,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('meeting_legacy', 'org_legacy', 'Legacy meeting', 'user_legacy', timestamp, timestamp);
    const insertMessage = legacy.prepare('INSERT INTO agent_messages(id,org_id,meeting_id,from_employee_id,body,kind,created_at) VALUES(?,?,?,?,?,?,?)');
    insertMessage.run('message_1', 'org_legacy', 'meeting_legacy', 'emp_legacy', 'first', 'pre_meeting', timestamp);
    insertMessage.run('message_2', 'org_legacy', 'meeting_legacy', 'emp_legacy', 'second', 'pre_meeting', timestamp);
  }
  legacy.close();
}

test('fresh startup records ordered migrations and reruns without changing history', () => {
  const directory = mkdtempSync(join(tmpdir(), 'solari-db-migrations-'));
  const filename = join(directory, 'fresh.sqlite');
  try {
    const first = initializeDatabase(filename);
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), migrationVersions.map((name, index) => ({ version: index + 1, name })));

    const second = initializeDatabase(filename);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(second.stdout), JSON.parse(first.stdout));

    const database = new DatabaseSync(filename);
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='coworker_relationships'").get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memberships_single_owner'").get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_auth_user_id'").get());
    assert.ok(database.prepare('PRAGMA table_info(users)').all().some((row) => row.name === 'auth_user_id'));
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='signup_intents'").get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_snapshots'").get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='employee_runtime_setups'").get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='crew_tasks'").get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='external_operations'").get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shopify_oauth_intents'").get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='twilio_whatsapp_connection_employees'").get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_shopify_oauth_one_active_intent'").get());
    for (const table of ['sarvam_voice_sessions','sarvam_voice_attempts','sarvam_voice_callbacks','sarvam_voice_decision_intents']) {
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table), `${table} should exist after migration v25`);
    }
    for (const table of ['task_delegations','employee_delegation_grants']) {
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table), `${table} should exist after migration v26`);
    }
    const workflowColumns = new Set(database.prepare('PRAGMA table_info(workflows)').all().map((row) => row.name));
    for (const column of ['execution_generation','execution_role','provenance_json','continuation_json']) assert.ok(workflowColumns.has(column));
    const dispatchColumns = new Set(database.prepare('PRAGMA table_info(event_dispatch_records)').all().map((row) => row.name));
    for (const column of ['dispatch_deadline_at','recovery_deadline_at','primary_workflow_id']) assert.ok(dispatchColumns.has(column));
    const delegationColumns = new Set(database.prepare('PRAGMA table_info(task_delegations)').all().map((row) => row.name));
    for (const column of ['dispatch_slot_key','slot_generation','parent_workflow_id','child_workflow_id','grant_id','child_execution_generation','request_json','legacy']) assert.ok(delegationColumns.has(column));
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_workflow_evidence'").get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_workflow_evidence_runs'").get());
    const evidenceColumns = new Set(database.prepare('PRAGMA table_info(event_workflow_evidence)').all().map((row) => row.name));
    for (const column of ['connection_id','source_event_id','event_version','observation_hash','step_input_hash','bindings_json']) assert.ok(evidenceColumns.has(column));
    for (const index of ['idx_event_dispatch_recovery_deadline','idx_event_dispatch_lease_expiry','idx_event_workflow_evidence_dispatch','idx_task_delegations_dispatch_slot','idx_task_delegations_org_dispatch_slot','idx_event_dispatch_ready_v28','idx_event_evidence_runs_tool_run']) {
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(index), `${index} should exist after migration v28`);
    }
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sarvam_voice_idempotency'").get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sarvam_voice_callback_retention'").get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chief_generation_requests'").get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='employee_execution_locks'").get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='storefront_revisions'").get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='commerce_catalog_projection'").get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='commerce_simulation_operations'").get());
    assert.ok(database.prepare('PRAGMA table_info(organization_blueprints)').all().some((row) => row.name === 'reviewed_by'));
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='event_dispatch_records'").get());
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='organization_teams'").get());
    assert.ok(database.prepare('PRAGMA table_info(provider_tool_readiness)').all().some((row) => row.name === 'policy_revision'));
    assert.deepEqual(new Set(database.prepare('PRAGMA table_info(agent_messages)').all().map((row) => row.name)), new Set([
      'id', 'org_id', 'meeting_id', 'from_employee_id', 'to_employee_id', 'body', 'evidence_ids', 'kind', 'type', 'delegation_goal', 'delegation_status', 'workflow_id', 'created_at',
    ]));
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy OpenAI keys are preserved but marked for replacement by an OpenRouter key', () => {
  const directory = mkdtempSync(join(tmpdir(), 'solari-openrouter-migration-'));
  const filename = join(directory, 'legacy-openai-key.sqlite');
  try {
    const initialized = initializeDatabase(filename);
    assert.equal(initialized.status, 0, initialized.stderr);
    const database = new DatabaseSync(filename);
    const timestamp = '2026-01-01T00:00:00.000Z';
    database.prepare('INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)').run('org_key_migration', 'Key migration', timestamp);
    database.prepare('INSERT INTO integrations(id,org_id,provider,display_name,secret_ciphertext,config,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('int_old_openai', 'org_key_migration', 'openai', 'OpenAI', 'encrypted-secret-preserved', '{}', 'connected', timestamp, timestamp);
    database.prepare('DELETE FROM schema_migrations WHERE version>=10').run();
    database.close();

    const migrated = initializeDatabase(filename);
    assert.equal(migrated.status, 0, migrated.stderr);
    const upgraded = new DatabaseSync(filename);
    assert.deepEqual({ ...upgraded.prepare('SELECT provider,display_name,secret_ciphertext,status FROM integrations WHERE org_id=?').get('org_key_migration') }, {
      provider: 'openrouter', display_name: 'OpenRouter', secret_ciphertext: 'encrypted-secret-preserved', status: 'reconnect',
    });
    upgraded.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('terminal workflow snapshots preserve tool runs and events while redacting credentials', () => {
  const directory = mkdtempSync(join(tmpdir(), 'solari-workflow-snapshot-'));
  const filename = join(directory, 'snapshot.sqlite');
  try {
    createLegacyDatabase(filename);
    const initialized = initializeDatabase(filename);
    assert.equal(initialized.status, 0, initialized.stderr);
    const database = new DatabaseSync(filename);
    database.prepare('UPDATE workflows SET result=?,finished_at=? WHERE id=?').run(
      JSON.stringify({ answer: 'Research is complete.', sources: [{ url: 'https://example.test' }] }),
      '2026-01-01T00:01:00.000Z', 'wf_legacy',
    );
    database.prepare('INSERT INTO tool_runs(id,org_id,workflow_id,step_index,tool,input,output,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('tool_legacy', 'org_legacy', 'wf_legacy', 0, 'solari.browser.open', JSON.stringify({ url: 'https://example.test', access_token: 'do-not-store' }), JSON.stringify({ title: 'Example' }), 'completed', '2026-01-01T00:00:30.000Z');
    database.prepare('INSERT INTO events(id,org_id,workflow_id,employee_id,actor_id,kind,detail,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run('event_legacy', 'org_legacy', 'wf_legacy', 'emp_legacy', null, 'verifier.passed', JSON.stringify({ verified: true }), '2026-01-01T00:00:45.000Z');
    database.close();

    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { closeDatabase } from './backend/lib/db.mjs';
      import { persistWorkflowSnapshot, getWorkflowSnapshot } from './backend/workflows/snapshot-store.mjs';
      await persistWorkflowSnapshot('org_legacy', 'wf_legacy');
      console.log(JSON.stringify(await getWorkflowSnapshot('org_legacy', 'wf_legacy')));
      await closeDatabase();
    `], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_FILE: filename, DATABASE_URL: '', NODE_ENV: 'test' },
    });
    assert.equal(result.status, 0, result.stderr);
    const saved = JSON.parse(result.stdout);
    assert.equal(saved.version, 1);
    assert.equal(saved.trace.workflow.status, 'completed');
    assert.equal(saved.trace.workflow.result.answer, 'Research is complete.');
    assert.equal(saved.trace.toolRuns.length, 1);
    assert.equal(saved.trace.toolRuns[0].tool, 'solari.browser.open');
    assert.equal(saved.trace.toolRuns[0].input.access_token, '[redacted]');
    assert.equal(saved.trace.events[0].kind, 'verifier.passed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('deleting a coworker cascades only its own directed relationships', () => {
  const directory = mkdtempSync(join(tmpdir(), 'solari-coworker-delete-'));
  const filename = join(directory, 'coworkers.sqlite');
  try {
    const initialized = initializeDatabase(filename);
    assert.equal(initialized.status, 0, initialized.stderr);

    const database = new DatabaseSync(filename);
    try {
      database.exec('PRAGMA foreign_keys = ON');
      const timestamp = '2026-01-01T00:00:00.000Z';
      database.prepare('INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)').run('org_test', 'Test', timestamp);
      const insertCoworker = database.prepare('INSERT INTO coworkers(id,org_id,name,role,updated_at,created_at) VALUES(?,?,?,?,?,?)');
      for (const id of ['cow_delete', 'cow_keep_a', 'cow_keep_b']) insertCoworker.run(id, 'org_test', id, 'Teammate', timestamp, timestamp);
      const insertRelationship = database.prepare('INSERT INTO coworker_relationships(id,org_id,from_coworker_id,to_coworker_id,last_interaction_summary,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
      insertRelationship.run('rel_outgoing', 'org_test', 'cow_delete', 'cow_keep_a', 'Outgoing', timestamp, timestamp);
      insertRelationship.run('rel_incoming', 'org_test', 'cow_keep_a', 'cow_delete', 'Incoming', timestamp, timestamp);
      insertRelationship.run('rel_unrelated', 'org_test', 'cow_keep_a', 'cow_keep_b', 'Unrelated', timestamp, timestamp);

      const result = database.prepare('DELETE FROM coworkers WHERE id=? AND org_id=? AND employee_id IS NULL').run('cow_delete', 'org_test');
      assert.equal(result.changes, 1);
      assert.deepEqual(database.prepare('SELECT id FROM coworker_relationships ORDER BY id').all().map((row) => row.id), ['rel_unrelated']);
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('legacy SQLite schema upgrades columns and snapshots existing simulation runs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'solari-db-upgrade-'));
  const filename = join(directory, 'legacy.sqlite');
  try {
    createLegacyDatabase(filename);
    const result = initializeDatabase(filename);
    assert.equal(result.status, 0, result.stderr);

    const database = new DatabaseSync(filename);
    const columns = (table) => database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    assert.ok(columns('employees').includes('profile_id'));
    assert.ok(columns('workflows').includes('worker_id'));
    assert.ok(columns('workflows').includes('lease_expires_at'));
    assert.ok(columns('workflows').includes('runtime_version'));
    assert.equal(database.prepare('SELECT runtime_version FROM workflows WHERE id=?').get('wf_legacy').runtime_version, 'legacy');
    assert.ok(columns('meetings').includes('meeting_worker_id'));
    assert.ok(columns('meetings').includes('meeting_lease_expires_at'));
    assert.ok(columns('agent_messages').includes('type'));
    assert.ok(columns('agent_messages').includes('delegation_goal'));
    assert.ok(columns('agent_messages').includes('delegation_status'));
    assert.ok(columns('agent_messages').includes('workflow_id'));
    assert.ok(columns('simulations').includes('version'));
    assert.ok(columns('simulation_runs').includes('suite_snapshot'));
    assert.ok(columns('tool_runs').includes('retry_at'));
    const snapshot = JSON.parse(database.prepare('SELECT suite_snapshot FROM simulation_runs WHERE id=?').get('run_legacy').suite_snapshot);
    assert.deepEqual(snapshot, {
      version: 1,
      name: 'Legacy suite',
      description: 'Original suite',
      scenario: { steps: ['verify'] },
      rubric: { score: 1 },
      threshold: 0.9,
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM simulation_versions WHERE simulation_id=?').get('sim_legacy').count, 1);
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('failed invariant migration rolls back its DDL and is not recorded as applied', () => {
  const directory = mkdtempSync(join(tmpdir(), 'solari-db-migration-rollback-'));
  const filename = join(directory, 'legacy.sqlite');
  try {
    createLegacyDatabase(filename, { duplicatePreMeeting: true });
    const result = initializeDatabase(filename);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /idx_agent_pre_meeting_once|UNIQUE constraint failed/);

    const database = new DatabaseSync(filename);
    assert.deepEqual(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version), [1, 2, 3]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='index' AND name='idx_memberships_single_owner'").get().count, 0);
    database.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
