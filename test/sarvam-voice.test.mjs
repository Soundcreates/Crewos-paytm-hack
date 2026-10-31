import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSarvamOutboundRequest,
  createSarvamFixtureTransport,
  createSarvamOutboundProvider,
  normalizeSarvamCallback,
} from '../backend/src/integrations/sarvam-voice.mjs';
import { createSarvamVoiceSessionService } from '../backend/src/services/sarvam-voice-session.mjs';

const NOW = '2026-10-31T12:00:00.000Z';
const PHONE = '+14155550123';
const BINDING = Object.freeze({
  orgId: 'org-1', sarvamOrgId: 'sarvam-org-1', sarvamWorkspaceId: 'workspace-1',
  appId: 'voice-bridge', appVersion: 3, connectionId: 'tel-connection-1', agentPhoneNumber: '+14155550100',
});
const CONSENT = Object.freeze({ status: 'granted', explicit: true, purpose: 'incident escalation', recipientPhone: PHONE, capturedAt: '2026-10-31T11:00:00.000Z' });
const TRANSCRIPT_CONSENT = Object.freeze({ status: 'granted', explicit: true, recipientPhone: PHONE, capturedAt: '2026-10-31T11:00:00.000Z' });
const TRANSCRIPT = Object.freeze([
  Object.freeze({ role: 'agent', en_text: 'A short fixture greeting.' }),
  Object.freeze({ role: 'user', en_text: 'A short fixture response.' }),
]);

function makeHarness({
  fixtureEnabled = true,
  transport = createSarvamFixtureTransport(),
  claimResult,
  verifyCallback = async () => true,
  transaction,
  callbackClaimResult,
  authorizer = {},
  approval = {},
  session = {},
  attemptRow = {},
  timestamp = () => NOW,
} = {}) {
  const provider = createSarvamOutboundProvider({ transport, webhookUrl: 'https://crewos.example.test/webhooks/sarvam/outbound' });
  const state = { outbound: new Map(), byAttempt: new Map(), callbacks: new Set(), outcomes: [], intents: [], consumeCalls: 0, transactionCalls: 0, logRecords: [] };
  const defaultApproval = {
    id: 'approval-1', org_id: 'org-1', task_id: 'task-1', action_hash: 'action-hash-1',
    manager_user_id: 'manager-1', expires_at: '2026-10-31T13:00:00.000Z', nonce: 'nonce-1',
    policy_revision: 'policy-v1', allowed_decision: 'approve', state: 'pending',
    ...approval,
  };
  const defaultSession = { org_id: 'org-1', voice_session_id: 'voice-1', task_id: 'task-1', approval_id: 'approval-1', ...session };
  const repository = {
    async findOutboundByIdempotency(orgId, key) {
      const row = state.outbound.get(`${orgId}:${key}`);
      return row || null;
    },
    async findLatestOutboundForRecipient(orgId, phone, since) {
      return [...state.outbound.values()].find(row => row.org_id === orgId && row.recipient_phone === phone && Date.parse(row.created_at) >= Date.parse(since)) || null;
    },
    async reserveOutbound({ orgId, idempotencyKey, requestHash, record }) {
      const key = `${orgId}:${idempotencyKey}`;
      const old = state.outbound.get(key);
      if (old) return { created: false, record: old };
      const row = {
        org_id: orgId, voice_session_id: record.voiceSessionId, task_id: record.taskId,
        approval_id: record.approvalId, request_hash: requestHash, state: 'queued', attempt_id: null,
        created_at: record.createdAt, recipient_phone: record.recipientPhone,
        transcript_consent_status: record.transcriptConsent?.status || null,
        transcript_consent_explicit: record.transcriptConsent?.explicit ? 1 : 0,
        transcript_consent_recipient_phone: record.transcriptConsent?.recipientPhone || null,
        transcript_consent_captured_at: record.transcriptConsent?.capturedAt || null,
      };
      state.outbound.set(key, row);
      return { created: true, record: row };
    },
    async markOutboundDialing(orgId, voiceSessionId) {
      if (claimResult) return typeof claimResult === 'function' ? claimResult({ orgId, voiceSessionId }) : claimResult;
      const row = [...state.outbound.values()].find(item => item.org_id === orgId && item.voice_session_id === voiceSessionId);
      if (!row || row.state !== 'queued') return { changes: 0, org_id: orgId, voice_session_id: voiceSessionId, state: row?.state || null };
      row.state = 'dialing';
      return { changes: 1, org_id: orgId, voice_session_id: voiceSessionId, state: 'dialing' };
    },
    async markOutboundAccepted(orgId, voiceSessionId, attemptId) {
      const row = [...state.outbound.values()].find(item => item.org_id === orgId && item.voice_session_id === voiceSessionId);
      if (!row) return null;
      row.attempt_id = attemptId;
      row.state = 'dialing';
      Object.assign(row, attemptRow);
      state.byAttempt.set(attemptId, row);
      return row;
    },
    async markOutboundReconciliationRequired(orgId, voiceSessionId, reasonCode) {
      const row = [...state.outbound.values()].find(item => item.org_id === orgId && item.voice_session_id === voiceSessionId);
      if (!row) return null;
      row.state = 'reconciliation_required';
      row.reason_code = reasonCode;
      return row;
    },
    async findOutboundByAttemptId(attemptId) { return state.byAttempt.get(attemptId) || null; },
    async claimSarvamCallback({ orgId, attemptId, callbackId }) {
      if (callbackClaimResult) return typeof callbackClaimResult === 'function' ? callbackClaimResult({ orgId, attemptId, callbackId }) : callbackClaimResult;
      const key = `${orgId}:${attemptId}:${callbackId}`;
      if (state.callbacks.has(key)) return { duplicate: true, org_id: orgId };
      state.callbacks.add(key);
      return { duplicate: false, org_id: orgId };
    },
    async recordSarvamOutcome(outcome) {
      state.outcomes.push(outcome);
      return { org_id: outcome.orgId, voice_session_id: outcome.voiceSessionId };
    },
    async findVoiceSessionByOrgAndId(orgId, voiceSessionId) {
      return defaultSession.org_id === orgId && defaultSession.voice_session_id === voiceSessionId ? defaultSession : null;
    },
    async findPendingVoiceApproval(orgId, approvalId) {
      return defaultApproval.org_id === orgId && defaultApproval.id === approvalId ? defaultApproval : null;
    },
    async findVoiceIntentByIdempotency(orgId, key) { return state.intents.find(item => item.org_id === orgId && item.idempotency_key === key) || null; },
    async recordVoiceIntent(input) {
      const row = { org_id: input.orgId, voice_session_id: input.voiceSessionId, approval_id: input.approvalId, intent: input.intent, intent_hash: input.intentHash, request_hash: input.requestHash, idempotency_key: input.idempotencyKey };
      state.intents.push(row);
      return row;
    },
    async findLatestVoiceIntentForApproval(orgId, voiceSessionId, approvalId) {
      return [...state.intents].reverse().find(item => item.org_id === orgId && item.voice_session_id === voiceSessionId && item.approval_id === approvalId) || null;
    },
    async consumePendingApproval({ orgId, approvalId, userId, expectedBinding }) {
      state.consumeCalls += 1;
      if (defaultApproval.org_id !== orgId || defaultApproval.id !== approvalId || defaultApproval.manager_user_id !== userId || defaultApproval.state !== 'pending' || defaultApproval.action_hash !== expectedBinding.actionHash || defaultApproval.nonce !== expectedBinding.nonce) return { changes: 0, org_id: orgId };
      defaultApproval.state = 'consumed';
      return { changes: 1, org_id: orgId };
    },
  };
  const defaultAuthorizer = {
    async authorizeOutbound({ orgId, sarvamOrgId, sarvamWorkspaceId, appId, connectionId }) {
      return { allowed: true, orgId, sarvamOrgId, sarvamWorkspaceId, appId, connectionId };
    },
    async authorizeVoiceIntent({ orgId, voiceSessionId, approvalId }) { return { allowed: true, orgId, voiceSessionId, approvalId }; },
    async authorizeManagerConfirmation() { return true; },
    ...authorizer,
  };
  const tx = transaction || (async callback => {
    state.transactionCalls += 1;
    return callback();
  });
  const service = createSarvamVoiceSessionService({
    repository, provider, authorizer: defaultAuthorizer, verifyCallback, transaction: tx,
    lockOrganization: async () => true, fixtureEnabled, timestamp,
    newId: prefix => `${prefix}-generated`, logger: record => state.logRecords.push(record),
  });
  return { service, state, repository, transport, provider, approval: defaultApproval, session: defaultSession };
}

function outbound(overrides = {}) {
  return {
    orgId: 'org-1', taskId: 'task-1', actorId: 'manager-1', incidentId: 'incident-1', voiceSessionId: 'voice-1',
    idempotencyKey: 'outbound-key-1', policyVersion: 'policy-v1', approvalId: 'approval-1',
    recipientPreference: 'on-call manager', recipientPhone: PHONE,
    risk: 'high', severity: 'critical', reason: 'Fixture incident escalation', cooldownMs: 60_000,
    binding: BINDING, consent: CONSENT, transcriptConsent: TRANSCRIPT_CONSENT,
    ...overrides,
  };
}

function callback(overrides = {}) {
  return {
    status: 'connected', attempt_id: 'fixture-attempt-001', interaction_id: 'fixture-interaction-001',
    interaction_transcript: TRANSCRIPT,
    webhook_config: { metadata: { voiceSessionId: 'voice-1', taskId: 'task-1' } },
    ...overrides,
  };
}

async function acceptOutbound(harness, input = outbound()) { return harness.service.requestOutbound(input); }

test('builds only the documented outbound request contract and keeps credentials out of fixture output/logs', async () => {
  const request = buildSarvamOutboundRequest({ binding: BINDING, recipientPhone: PHONE, consent: CONSENT, metadata: { voiceSessionId: 'voice-1', taskId: 'task-1', extra: 'drop me' }, webhookUrl: 'https://crewos.example.test/callback', at: NOW });
  assert.match(request.url, /^https:\/\/apps\.sarvam\.ai\/api\/outbounds\/v1\/orgs\/sarvam-org-1\/workspaces\/workspace-1\/outbounds$/);
  assert.deepEqual(Object.keys(request.body).sort(), ['app_config', 'user_config', 'webhook_config']);
  assert.deepEqual(request.body.app_config, { app_id: 'voice-bridge', app_version: 3, connection_config: { connection_id: 'tel-connection-1', agent_phone_number: '+14155550100' } });
  assert.deepEqual(request.body.user_config, { user_phone_number: PHONE });
  assert.deepEqual(request.body.webhook_config.metadata, { voiceSessionId: 'voice-1', taskId: 'task-1' });

  const h = makeHarness();
  const result = await acceptOutbound(h);
  assert.equal(result.state, 'dialing');
  assert.equal(result.accepted, true);
  assert.equal(h.transport.calls.length, 1);
  assert.equal(h.transport.calls[0].headers['X-API-Key'], undefined);
  const observed = JSON.stringify({ result, logs: h.state.logRecords });
  assert.equal(observed.includes(PHONE), false);
  assert.equal(observed.includes('Fixture incident escalation'), false);
});

test('outbound calls remain disabled by default even with a fixture provider injected', async () => {
  const h = makeHarness({ fixtureEnabled: false });
  await assert.rejects(h.service.requestOutbound(outbound()), { code: 'voice_outbound_disabled' });
  assert.equal(h.transport.calls.length, 0);
});

test('rejects invalid E.164, missing/mismatched consent, and cross-organization app binding before transport', async t => {
  await t.test('invalid recipient number', async () => {
    const h = makeHarness();
    await assert.rejects(h.service.requestOutbound(outbound({ recipientPhone: '4155550123', consent: { ...CONSENT, recipientPhone: '4155550123' } })), { code: 'sarvam_phone_invalid' });
    assert.equal(h.transport.calls.length, 0);
  });
  await t.test('no explicit consent', async () => {
    const h = makeHarness();
    await assert.rejects(h.service.requestOutbound(outbound({ consent: { ...CONSENT, explicit: false } })), { code: 'voice_consent_required' });
    assert.equal(h.transport.calls.length, 0);
  });
  await t.test('consent recipient mismatch', async () => {
    const h = makeHarness();
    await assert.rejects(h.service.requestOutbound(outbound({ consent: { ...CONSENT, recipientPhone: '+14155550124' } })), { code: 'voice_consent_required' });
    assert.equal(h.transport.calls.length, 0);
  });
  await t.test('app authorization mismatch', async () => {
    const h = makeHarness({ authorizer: { authorizeOutbound: async () => ({ allowed: true, orgId: 'org-other', sarvamOrgId: BINDING.sarvamOrgId, sarvamWorkspaceId: BINDING.sarvamWorkspaceId, appId: BINDING.appId, connectionId: BINDING.connectionId }) } });
    await assert.rejects(h.service.requestOutbound(outbound()), { code: 'voice_authorization_denied' });
    assert.equal(h.transport.calls.length, 0);
  });
});

test('idempotency returns the prior result and rejects reuse for different request data', async () => {
  const h = makeHarness();
  const first = await acceptOutbound(h);
  const duplicate = await acceptOutbound(h);
  assert.equal(first.attemptId, duplicate.attemptId);
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(h.service.requestOutbound(outbound({ reason: 'Different action' })), { code: 'voice_idempotency_conflict' });
  assert.equal(h.transport.calls.length, 1);
});

test('recipient cooldown blocks a second idempotency key within the configured window', async () => {
  const h = makeHarness();
  await acceptOutbound(h);
  await assert.rejects(h.service.requestOutbound(outbound({ idempotencyKey: 'outbound-key-2', voiceSessionId: 'voice-2' })), { code: 'voice_cooldown_active' });
  assert.equal(h.transport.calls.length, 1);
});

test('lost conditional dispatch claim makes zero provider calls', async () => {
  const h = makeHarness({ claimResult: { changes: 0, org_id: 'org-1', voice_session_id: 'voice-1', state: 'queued' } });
  await assert.rejects(h.service.requestOutbound(outbound()), { code: 'voice_dispatch_claim_lost' });
  assert.equal(h.transport.calls.length, 0);
});

test('a nominal claim with a foreign organization is also rejected before provider dispatch', async () => {
  const h = makeHarness({ claimResult: { changes: 1, org_id: 'org-other', voice_session_id: 'voice-1', state: 'dialing' } });
  await assert.rejects(h.service.requestOutbound(outbound()), { code: 'voice_dispatch_claim_lost' });
  assert.equal(h.transport.calls.length, 0);
});

test('provider uncertainty moves to reconciliation and an idempotent replay does not retry', async () => {
  let transportCalls = 0;
  const h = makeHarness({ transport: { mode: 'fixture', async post() { transportCalls += 1; throw new Error('fixture timeout'); } } });
  await assert.rejects(h.service.requestOutbound(outbound()));
  const replay = await h.service.requestOutbound(outbound());
  assert.equal(replay.duplicate, true);
  assert.equal(replay.state, 'reconciliation_required');
  assert.equal(transportCalls, 1);
});

test('callbacks verify before transaction and use the verified raw body, ignoring a supplied parsed payload', async () => {
  const order = [];
  const raw = callback();
  const h = makeHarness({
    verifyCallback: async args => { order.push('verify'); assert.deepEqual(Object.keys(args).sort(), ['headers', 'rawBody']); assert.deepEqual(JSON.parse(args.rawBody.toString()), raw); return true; },
    transaction: async fn => { order.push('transaction'); return fn(); },
  });
  await acceptOutbound(h);
  const rawBody = Buffer.from(JSON.stringify(raw));
  const result = await h.service.processCallback({ headers: { 'x-fixture': 'only' }, rawBody, payload: callback({ status: 'failed', attempt_id: 'forged-attempt', interaction_transcript: 'forged' }) });
  assert.deepEqual(order, ['verify', 'transaction']);
  assert.equal(result.status, 'connected');
  assert.equal(h.state.outcomes[0].attemptId, 'fixture-attempt-001');
  assert.equal(h.state.outcomes[0].status, 'connected');
});

test('rejects callback attempt/session/task/org correlation mismatches', async t => {
  await t.test('unknown attempt', async () => {
    const h = makeHarness();
    await acceptOutbound(h);
    await assert.rejects(h.service.processCallback({ headers: {}, rawBody: Buffer.from(JSON.stringify(callback({ attempt_id: 'other-attempt' }))), payload: null }), { code: 'voice_callback_binding_mismatch' });
  });
  await t.test('wrong voice session/task', async () => {
    const h = makeHarness();
    await acceptOutbound(h);
    await assert.rejects(h.service.processCallback({ headers: {}, rawBody: Buffer.from(JSON.stringify(callback({ webhook_config: { metadata: { voiceSessionId: 'wrong-session', taskId: 'task-1' } } }))), payload: null }), { code: 'voice_callback_binding_mismatch' });
  });
  await t.test('wrong task', async () => {
    const h = makeHarness();
    await acceptOutbound(h);
    await assert.rejects(h.service.processCallback({ headers: {}, rawBody: Buffer.from(JSON.stringify(callback({ webhook_config: { metadata: { voiceSessionId: 'voice-1', taskId: 'wrong-task' } } }))), payload: null }), { code: 'voice_callback_binding_mismatch' });
  });
  await t.test('callback inbox returns a different tenant', async () => {
    const h = makeHarness({ callbackClaimResult: { duplicate: false, org_id: 'org-other' } });
    await acceptOutbound(h);
    await assert.rejects(h.service.processCallback({ headers: {}, rawBody: Buffer.from(JSON.stringify(callback())), payload: null }), { code: 'voice_callback_binding_mismatch' });
  });
});

test('duplicate callback is acknowledged once and persisted only once', async () => {
  const h = makeHarness();
  await acceptOutbound(h);
  const input = { headers: {}, rawBody: Buffer.from(JSON.stringify(callback())), payload: null };
  assert.equal((await h.service.processCallback(input)).duplicate, false);
  assert.equal((await h.service.processCallback(input)).duplicate, true);
  assert.equal(h.state.outcomes.length, 1);
});

test('retains documented transcript turn arrays only with explicit matching retention consent', async t => {
  await t.test('retention consent present', async () => {
    const h = makeHarness();
    await acceptOutbound(h);
    const result = await h.service.processCallback({ headers: {}, rawBody: Buffer.from(JSON.stringify(callback())), payload: null });
    assert.equal(result.transcriptRetained, true);
    assert.deepEqual(h.state.outcomes[0].transcript, TRANSCRIPT);
    assert.equal(h.state.outcomes[0].transcriptConsentApplied, true);
  });
  await t.test('retention consent absent', async () => {
    const h = makeHarness();
    await acceptOutbound(h, outbound({ transcriptConsent: undefined }));
    const result = await h.service.processCallback({ headers: {}, rawBody: Buffer.from(JSON.stringify(callback())), payload: null });
    assert.equal(result.transcriptRetained, false);
    assert.equal(h.state.outcomes[0].transcript, null);
    assert.equal(h.state.outcomes[0].transcriptOmitted, true);
  });
  await t.test('retention consent belongs to a different recipient', async () => {
    const h = makeHarness();
    await acceptOutbound(h, outbound({ transcriptConsent: { ...TRANSCRIPT_CONSENT, recipientPhone: '+14155550124' } }));
    const result = await h.service.processCallback({ headers: {}, rawBody: Buffer.from(JSON.stringify(callback())), payload: null });
    assert.equal(result.transcriptRetained, false);
    assert.equal(h.state.outcomes[0].transcript, null);
    assert.equal(h.state.outcomes[0].transcriptOmitted, true);
  });
});

test('transcript normalization skips malformed turns and caps turn count, characters, and UTF-8 bytes', () => {
  const malformed = normalizeSarvamCallback(callback({ interaction_transcript: [
    { role: 'agent', en_text: 'kept' }, { role: 'system', en_text: 'not allowed' }, { role: 'user', en_text: 42 }, null,
  ] }), { retainTranscript: true });
  assert.deepEqual(malformed.transcript, [{ role: 'agent', en_text: 'kept' }]);
  assert.equal(malformed.transcriptMalformedTurns, 3);

  const bounded = normalizeSarvamCallback(callback({ interaction_transcript: [
    { role: 'agent', en_text: '🙂'.repeat(15_000) }, ...Array.from({ length: 110 }, (_, i) => ({ role: i % 2 ? 'agent' : 'user', en_text: 'x' })),
  ] }), { retainTranscript: true });
  assert.equal(bounded.transcript.length <= 100, true);
  assert.equal(bounded.transcript.reduce((sum, turn) => sum + turn.en_text.length, 0) <= 20_000, true);
  assert.equal(Buffer.byteLength(bounded.transcript.map(turn => turn.en_text).join(''), 'utf8') <= 40_000, true);
  assert.equal(bounded.transcriptTruncated, true);
});

test('unverified callback is rejected before database transaction or lookup', async () => {
  let reads = 0;
  let h;
  h = makeHarness({ verifyCallback: async () => false, transaction: async fn => { h.state.transactionCalls += 1; return fn(); } });
  await acceptOutbound(h);
  const original = h.repository.findOutboundByAttemptId;
  h.repository.findOutboundByAttemptId = async (...args) => { reads += 1; return original(...args); };
  await assert.rejects(h.service.processCallback({ headers: {}, rawBody: Buffer.from(JSON.stringify(callback())), payload: null }), { code: 'voice_callback_unverified' });
  assert.equal(reads, 0);
  assert.equal(h.state.transactionCalls, 0);
});

test('spoken approve is proposal-only and cannot consume or execute an action', async () => {
  const h = makeHarness();
  await acceptOutbound(h);
  const result = await h.service.submitVoiceIntent({ orgId: 'org-1', voiceSessionId: 'voice-1', approvalId: 'approval-1', idempotencyKey: 'intent-key-1', intent: 'approve' });
  assert.deepEqual(result, { duplicate: false, intent: 'approve', approvalId: 'approval-1', proposalOnly: true });
  assert.equal(h.approval.state, 'pending');
  assert.equal(h.state.consumeCalls, 0);
  assert.equal(h.transport.calls.length, 1);
});

test('manager authorization, immutable assignment, expiry, and CAS replay gate approval consumption', async t => {
  await t.test('manager role denied', async () => {
    const h = makeHarness({ authorizer: { authorizeManagerConfirmation: async () => false } });
    await acceptOutbound(h);
    await h.service.submitVoiceIntent({ orgId: 'org-1', voiceSessionId: 'voice-1', approvalId: 'approval-1', idempotencyKey: 'intent-role', intent: 'approve' });
    await assert.rejects(h.service.confirmManagerApproval({ orgId: 'org-1', voiceSessionId: 'voice-1', approvalId: 'approval-1', authenticatedUserId: 'manager-1', decision: 'approve' }), { code: 'voice_manager_unauthorized' });
    assert.equal(h.state.consumeCalls, 0);
  });
  await t.test('manager identity does not match immutable approval assignment', async () => {
    const h = makeHarness();
    await acceptOutbound(h);
    await h.service.submitVoiceIntent({ orgId: 'org-1', voiceSessionId: 'voice-1', approvalId: 'approval-1', idempotencyKey: 'intent-assignment', intent: 'approve' });
    await assert.rejects(h.service.confirmManagerApproval({ orgId: 'org-1', voiceSessionId: 'voice-1', approvalId: 'approval-1', authenticatedUserId: 'manager-2', decision: 'approve' }), { code: 'voice_manager_unauthorized' });
    assert.equal(h.state.consumeCalls, 0);
  });
  await t.test('voice session is bound to exactly one approval', async () => {
    const h = makeHarness({ session: { approval_id: 'approval-other' } });
    await acceptOutbound(h);
    await assert.rejects(h.service.submitVoiceIntent({ orgId: 'org-1', voiceSessionId: 'voice-1', approvalId: 'approval-1', idempotencyKey: 'intent-wrong-session-binding', intent: 'approve' }), { code: 'voice_approval_binding_mismatch' });
    assert.equal(h.state.consumeCalls, 0);
  });
  await t.test('changed immutable action hash invalidates the voice proposal', async () => {
    const h = makeHarness();
    await acceptOutbound(h);
    await h.service.submitVoiceIntent({ orgId: 'org-1', voiceSessionId: 'voice-1', approvalId: 'approval-1', idempotencyKey: 'intent-stale-binding', intent: 'approve' });
    h.approval.action_hash = 'changed-action-hash';
    await assert.rejects(h.service.confirmManagerApproval({ orgId: 'org-1', voiceSessionId: 'voice-1', approvalId: 'approval-1', authenticatedUserId: 'manager-1', decision: 'approve' }), { code: 'voice_intent_missing' });
    assert.equal(h.state.consumeCalls, 0);
  });
  await t.test('expired approval cannot be consumed', async () => {
    const h = makeHarness({ approval: { expires_at: '2026-10-31T11:59:59.000Z' } });
    await acceptOutbound(h);
    await h.service.submitVoiceIntent({ orgId: 'org-1', voiceSessionId: 'voice-1', approvalId: 'approval-1', idempotencyKey: 'intent-expired', intent: 'approve' }).catch(() => {});
    await assert.rejects(h.service.confirmManagerApproval({ orgId: 'org-1', voiceSessionId: 'voice-1', approvalId: 'approval-1', authenticatedUserId: 'manager-1', decision: 'approve' }), { code: 'voice_approval_stale' });
    assert.equal(h.state.consumeCalls, 0);
  });
  await t.test('one successful CAS; replay cannot consume twice', async () => {
    const h = makeHarness();
    await acceptOutbound(h);
    await h.service.submitVoiceIntent({ orgId: 'org-1', voiceSessionId: 'voice-1', approvalId: 'approval-1', idempotencyKey: 'intent-cas', intent: 'approve' });
    const input = { orgId: 'org-1', voiceSessionId: 'voice-1', approvalId: 'approval-1', authenticatedUserId: 'manager-1', decision: 'approve' };
    assert.equal((await h.service.confirmManagerApproval(input)).consumed, true);
    await assert.rejects(h.service.confirmManagerApproval(input), { code: 'voice_approval_stale' });
    assert.equal(h.state.consumeCalls, 1);
    assert.equal(h.approval.state, 'consumed');
  });
});
