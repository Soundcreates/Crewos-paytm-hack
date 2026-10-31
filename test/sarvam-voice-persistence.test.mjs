import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'crewos-sarvam-persistence-'));
process.env.DATABASE_FILE = join(directory, 'voice.sqlite');
process.env.DATABASE_URL = '';
process.env.NEON_AUTH_BASE_URL = '';
process.env.NODE_ENV = 'test';

const database = await import('../backend/lib/db.mjs');
const { createSarvamVoiceRepository } = await import('../backend/src/repositories/sarvam-voice-repository.mjs');
const repository = createSarvamVoiceRepository({
  all: database.all, get: database.get, run: database.run, transaction: database.transaction,
  newId: database.id, databaseDialect: 'sqlite',
});
const at = '2026-10-31T12:00:00.000Z';
const orgId = 'org_voice_a';
const userId = 'user_voice_a';
const taskId = 'task_voice_a';
const onboardingId = 'onboard_voice_a';
const crewConnectionId = 'sarvam_connection_a';
const telephonyConnectionId = 'sarvam_tel_a';
const config = {
  sarvamOrgId: 'sarvam_org_a', workspaceId: 'sarvam_workspace_a', appId: 'sarvam_app_a', appVersion: 3,
  voiceModel: 'fixture-model', languages: ['en-IN'], telephonyConnectionId, agentPhoneNumber: '+14155550100', fixture: true,
};

before(async () => {
  for (const [id, name] of [[orgId, 'Voice A'], ['org_voice_b', 'Voice B']]) await database.run('INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)', id, name, at);
  await database.run('INSERT INTO users(id,name,email,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)', userId, 'Voice Manager', 'voice-a@example.test', 'salt', 'hash', at);
  await database.run('INSERT INTO users(id,name,email,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)', 'user_voice_b', 'Other Manager', 'voice-b@example.test', 'salt', 'hash', at);
  await database.run('INSERT INTO memberships(org_id,user_id,role,created_at) VALUES(?,?,?,?)', 'org_voice_b', 'user_voice_b', 'manager', at);
  await database.run('INSERT INTO memberships(org_id,user_id,role,created_at) VALUES(?,?,?,?)', orgId, userId, 'manager', at);
  await database.run('INSERT INTO employees(id,org_id,name,title,created_at,updated_at) VALUES(?,?,?,?,?,?)', 'employee_voice_a', orgId, 'Voice worker', 'Operations', at, at);
  await database.run(`INSERT INTO workflows(id,org_id,employee_id,created_by,goal,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`, 'workflow_voice_a', orgId, 'employee_voice_a', userId, 'Fixture task', 'completed', at, at);
  await database.run(`INSERT INTO crew_tasks(id,org_id,workflow_id,owner_employee_id,capability,goal,idempotency_key,correlation_id,runtime_version,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`, taskId, orgId, 'workflow_voice_a', 'employee_voice_a', 'support.case.triage', 'Fixture task', 'task-key-a', 'corr-a', 'fixture', at, at);
  await database.run(`INSERT INTO onboarding_sessions(id,org_id,graph_thread_id,state,current_profile_version,created_at,updated_at)
    VALUES(?,?,?,'collecting',0,?,?)`, onboardingId, orgId, 'thread_voice_a', at, at);
  await repository.createConnection({ orgId, connectionId: crewConnectionId, providerAccountId: config.workspaceId, environment: 'simulation', config, createdAt: at });
  const activated = await repository.activateFixtureConnection(orgId, crewConnectionId, at);
  assert.equal(activated.changes, 1);
});

after(async () => {
  await database.closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

function outboundRecord({ voiceSessionId, idempotencyKey, requestHash, recipientPhone = '+14155550123', transcriptConsent = null, createdAt = at }) {
  return {
    voiceSessionId, actorId: userId, taskId, approvalId: null, recipientPhone, requestHash, createdAt,
    binding: { orgId, sarvamOrgId: config.sarvamOrgId, sarvamWorkspaceId: config.workspaceId, appId: config.appId, appVersion: config.appVersion, connectionId: telephonyConnectionId },
    consent: { status: 'granted', explicit: true, purpose: 'voice fixture', capturedAt: at },
    transcriptConsent,
    idempotencyKey,
  };
}

test('migration v25 creates tenant-fenced voice tables and idempotency indexes', async () => {
  const versions = await database.all('SELECT version,name FROM schema_migrations ORDER BY version');
  assert.equal(versions.at(-1).version, 25);
  assert.equal(versions.at(-1).name, 'sarvam-org-scoped-voice-sessions-and-intents');
  for (const table of ['sarvam_voice_sessions', 'sarvam_voice_attempts', 'sarvam_voice_callbacks', 'sarvam_voice_decision_intents']) {
    assert.ok(await database.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table));
  }
  assert.ok(await database.get("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sarvam_voice_idempotency'"));
  assert.ok(await database.get("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sarvam_voice_callback_retention'"));
});

test('browser session is org/user bound, stores token hash only, and cannot be read cross-org', async () => {
  const token = 'fixture-cookie-token-never-returned';
  const appConfig = structuredClone(config);
  const session = await repository.createBrowserVoiceSession({
    id: 'voice_browser_a', orgId, connectionId: crewConnectionId, userId, taskId, onboardingSessionId: onboardingId,
    environment: 'simulation', sarvamOrgId: config.sarvamOrgId, workspaceId: config.workspaceId, appId: config.appId,
    appVersion: config.appVersion, appConfig, configHash: createHash('sha256').update(JSON.stringify(appConfig)).digest('hex'),
    tokenHash: createHash('sha256').update(token).digest('hex'),
    transcriptConsent: { capturedAt: at, retentionUntil: '2026-11-30T12:00:00.000Z' },
    createdAt: at, expiresAt: '2026-10-31T12:10:00.000Z',
  });
  assert.equal(session.state, 'created');
  const row = await database.get('SELECT browser_token_hash,app_config_json FROM sarvam_voice_sessions WHERE org_id=? AND id=?', orgId, 'voice_browser_a');
  assert.notEqual(row.browser_token_hash, token);
  assert.equal(JSON.parse(row.app_config_json).fixture, true);
  const crossTenantSession = await repository.findVoiceSessionByOrgAndId('org_voice_b', 'voice_browser_a');
  assert.equal(crossTenantSession, null);
  assert.equal((await repository.findBrowserSessionByToken(orgId, userId, row.browser_token_hash)).voice_session_id, 'voice_browser_a');
});

test('outbound reservation atomically binds idempotency, cooldown, consent and a one-row dialing claim', async () => {
  const record = outboundRecord({ voiceSessionId: 'voice_outbound_a', idempotencyKey: 'outbound_key_a', requestHash: 'request_hash_a' });
  const reserved = await repository.reserveOutbound({ orgId, idempotencyKey: record.idempotencyKey, requestHash: record.requestHash, cooldownSince: at, record });
  assert.equal(reserved.created, true);
  const duplicate = await repository.reserveOutbound({ orgId, idempotencyKey: record.idempotencyKey, requestHash: record.requestHash, cooldownSince: at, record });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.record.voice_session_id, record.voiceSessionId);
  const claim = await repository.markOutboundDialing(orgId, record.voiceSessionId, at);
  assert.deepEqual(claim, { changes: 1, org_id: orgId, voice_session_id: record.voiceSessionId, state: 'dialing' });
  const lost = await repository.markOutboundDialing(orgId, record.voiceSessionId, at);
  assert.equal(lost.changes, 0);
  await assert.rejects(repository.reserveOutbound({
    orgId, idempotencyKey: 'outbound_key_b', requestHash: 'request_hash_b', cooldownSince: at,
    record: outboundRecord({ voiceSessionId: 'voice_outbound_b', idempotencyKey: 'outbound_key_b', requestHash: 'request_hash_b' }),
  }), error => error.code === 'voice_cooldown_active');
});

test('callback inbox is tenant/attempt correlated, replay-safe, and keeps transcript only with recorded consent', async () => {
  const transcriptConsent = { status: 'granted', explicit: true, recipientPhone: '+14155550125', capturedAt: at };
  const record = outboundRecord({ voiceSessionId: 'voice_callback_a', idempotencyKey: 'callback_key_a', requestHash: 'callback_hash_a', recipientPhone: '+14155550125', transcriptConsent });
  await repository.reserveOutbound({ orgId, idempotencyKey: record.idempotencyKey, requestHash: record.requestHash, cooldownSince: at, record });
  await repository.markOutboundDialing(orgId, record.voiceSessionId, at);
  const accepted = await repository.markOutboundAccepted(orgId, record.voiceSessionId, 'attempt_voice_a', at);
  assert.equal(accepted.state, 'dialing');
  const callback = { orgId, attemptId: 'attempt_voice_a', callbackId: 'callback-digest-a', interactionId: 'interaction-a', status: 'connected', receivedAt: at };
  assert.deepEqual(await repository.claimSarvamCallback(callback), { duplicate: false, org_id: orgId });
  assert.deepEqual(await repository.claimSarvamCallback(callback), { duplicate: true, org_id: orgId });
  const crossTenantClaim = await repository.claimSarvamCallback({ ...callback, orgId: 'org_voice_b' });
  assert.equal(crossTenantClaim, null);
  assert.equal(Boolean(crossTenantClaim), false);
  const turns = [{ role: 'user', en_text: 'Fixture only.' }];
  await repository.recordSarvamOutcome({ ...callback, voiceSessionId: record.voiceSessionId, transcript: turns, transcriptConsentApplied: true });
  assert.deepEqual(await repository.findVoiceCallbackTranscript(orgId, record.voiceSessionId, callback.callbackId, at), turns);
  await repository.purgeExpiredVoiceTranscripts('2026-12-01T12:00:00.000Z', orgId);
  assert.equal(await repository.findVoiceCallbackTranscript(orgId, record.voiceSessionId, callback.callbackId, at), null);
  const expired = await database.get('SELECT transcript_json FROM sarvam_voice_callbacks WHERE org_id=? AND callback_id=?', orgId, callback.callbackId);
  assert.equal(expired.transcript_json, null);

  const noConsent = outboundRecord({ voiceSessionId: 'voice_callback_no_consent', idempotencyKey: 'callback_key_no_consent', requestHash: 'callback_hash_no_consent', recipientPhone: '+14155550124' });
  await repository.reserveOutbound({ orgId, idempotencyKey: noConsent.idempotencyKey, requestHash: noConsent.requestHash, cooldownSince: at, record: noConsent });
  await repository.markOutboundDialing(orgId, noConsent.voiceSessionId, at);
  await repository.markOutboundAccepted(orgId, noConsent.voiceSessionId, 'attempt_voice_no_consent', at);
  const noConsentCallback = { orgId, attemptId: 'attempt_voice_no_consent', callbackId: 'callback-digest-no-consent', interactionId: 'interaction-no-consent', status: 'connected', receivedAt: at };
  await repository.claimSarvamCallback(noConsentCallback);
  await repository.recordSarvamOutcome({ ...noConsentCallback, voiceSessionId: noConsent.voiceSessionId, transcript: turns, transcriptConsentApplied: false });
  assert.equal(await repository.findVoiceCallbackTranscript(orgId, noConsent.voiceSessionId, noConsentCallback.callbackId, at), null);
  const stored = await database.get('SELECT transcript_json,transcript_consent_applied FROM sarvam_voice_callbacks WHERE org_id=? AND callback_id=?', orgId, noConsentCallback.callbackId);
  assert.equal(stored.transcript_json, null);
  assert.equal(stored.transcript_consent_applied, 0);
});

test('composite tenant foreign keys reject cross-organization task and connection bindings', async () => {
  await assert.rejects(database.run(`INSERT INTO sarvam_voice_sessions(id,org_id,connection_id,user_id,task_id,provider,environment,session_type,state,
    sarvam_org_id,workspace_id,app_id,app_version,app_config_json,config_hash,created_at,updated_at)
    VALUES('voice_cross_org','org_voice_b',?,'user_voice_b',?,'sarvam','simulation','browser','created','sarvam_org_b','workspace_b','app_b',1,'{}','hash',?,?)`,
  crewConnectionId, taskId, at, at), /FOREIGN KEY constraint failed/);
});
