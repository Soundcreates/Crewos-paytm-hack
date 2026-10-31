import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import test from 'node:test';
import { HttpError } from '../backend/src/utils/errors.mjs';
import { createSarvamVoiceV2Controller } from '../backend/src/controllers/sarvam-voice-v2-controller.mjs';

const NOW = '2026-10-31T12:00:00.000Z';
const ORG = 'org_voice_test';
const USER = 'user_voice_manager';
const FIXTURE_SECRET = 'fixture-only-test-secret-not-a-provider-key';
const APP_CONFIG = {
  sarvamOrgId: 'sarvam_org_test', workspaceId: 'sarvam_workspace_test', appId: 'sarvam_app_test', appVersion: 4,
  voiceModel: 'fixture-model', languages: ['en-IN'], telephonyConnectionId: 'sarvam_tel_test', agentPhoneNumber: '+14155550100', fixture: false,
};

function responseCapture() {
  return { status: null, body: null, headers: {}, writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); }, end(body = '') { this.rawBody = body; } };
}

function makeHarness({ fixtureEnabled = false, liveEnabled = false, v2Enabled = true, pilot = false, callbackVerifier = 'derived', proxyResponse, proxyStatus = 200, onboardingService } = {}) {
  const env = {
    NODE_ENV: 'test', APP_ORIGIN: 'https://crewos.example.test',
    CREWOS_ORG_ENGINE_V2: v2Enabled ? 'true' : 'false', CREWOS_ORG_ENGINE_V2_ORGS: v2Enabled ? ORG : '',
    PILOT_MODE: pilot ? 'true' : 'false', SARVAM_LIVE_ENABLED: liveEnabled ? 'true' : 'false',
    SARVAM_LOCAL_FIXTURES: fixtureEnabled ? 'true' : 'false', CREWOS_LOCAL_WEBHOOK_FIXTURES: fixtureEnabled ? 'true' : 'false',
    CREWOS_LOCAL_WEBHOOK_FIXTURE_SECRET: fixtureEnabled ? FIXTURE_SECRET : '',
  };
  const state = {
    connections: new Map(), sessions: new Map(), callbacks: new Set(), outcomes: [], proxyCalls: [], onboardingTurns: [], logs: [],
    effectCalls: 0, transactionCalls: 0, attemptLookups: 0, transactionSawVerifiedAttemptLookup: false,
    task: { id: 'task_voice_test', org_id: ORG, state: 'queued' },
    onboarding: { id: 'onboarding_voice_test', org_id: ORG, state: 'collecting', current_profile_version: 0 },
  };
  const repository = {
    async createConnection(input) {
      const row = { id: input.connectionId, org_id: input.orgId, provider: 'sarvam', provider_account_id: input.providerAccountId, environment: input.environment,
        status: 'setup_required', config: input.config, credential_ready: 0, credential_version: 1, created_at: input.createdAt, updated_at: input.createdAt };
      state.connections.set(`${input.orgId}:${input.connectionId}`, row);
      return row;
    },
    async activateFixtureConnection(orgId, connectionId, at) {
      const row = state.connections.get(`${orgId}:${connectionId}`);
      if (row?.environment !== 'simulation' || row.config.fixture !== true) return { changes: 0 };
      row.status = 'connected'; row.updated_at = at; return { changes: 1 };
    },
    async findConnectionByOrgAndId(orgId, connectionId) { return state.connections.get(`${orgId}:${connectionId}`) || null; },
    async listConnections(orgId) { return [...state.connections.values()].filter(row => row.org_id === orgId); },
    async disconnectConnection(orgId, connectionId, at) {
      const row = state.connections.get(`${orgId}:${connectionId}`); if (!row) return { changes: 0 };
      row.status = 'revoked'; row.credential_ready = 0; row.updated_at = at; return { changes: 1 };
    },
    async findTaskByOrgAndId(orgId, taskId) { return orgId === ORG && taskId === state.task.id ? state.task : null; },
    async findOnboardingSessionByOrgAndId(orgId, sessionId) { return orgId === ORG && sessionId === state.onboarding.id ? state.onboarding : null; },
    async createBrowserVoiceSession(input) {
      const row = {
        voice_session_id: input.id, org_id: input.orgId, connection_id: input.connectionId, user_id: input.userId, task_id: input.taskId,
        onboarding_session_id: input.onboardingSessionId, session_type: 'browser', state: 'created', environment: input.environment,
        sarvam_org_id: input.sarvamOrgId, workspace_id: input.workspaceId, app_id: input.appId, app_version: input.appVersion,
        app_config: structuredClone(input.appConfig), app_config_json: JSON.stringify(input.appConfig), config_hash: input.configHash, browser_token_hash: input.tokenHash,
        transcript_consent_status: 'granted', transcript_consent_explicit: 1, transcript_retention_until: input.transcriptConsent.retentionUntil,
        expires_at: input.expiresAt, created_at: input.createdAt, updated_at: input.createdAt,
      };
      state.sessions.set(`${input.orgId}:${input.id}`, row); return row;
    },
    async findBrowserSessionByToken(orgId, userId, tokenHash) {
      return [...state.sessions.values()].find(row => row.org_id === orgId && row.user_id === userId && row.browser_token_hash === tokenHash)
        ? { ...[...state.sessions.values()].find(row => row.org_id === orgId && row.user_id === userId && row.browser_token_hash === tokenHash), connection_status: 'connected', connection_config: APP_CONFIG, credential_ready: 1 }
        : null;
    },
    async claimBrowserProxyUrl(orgId, sessionId, userId, at) {
      const row = state.sessions.get(`${orgId}:${sessionId}`);
      if (!row || row.user_id !== userId || row.state !== 'created') return { changes: 0, session: null };
      row.state = 'resolving'; row.updated_at = at; return { changes: 1, session: { ...row } };
    },
    async finishBrowserProxyUrl(orgId, sessionId, referenceId, at) {
      const row = state.sessions.get(`${orgId}:${sessionId}`); if (!row || row.state !== 'resolving') return null;
      row.state = 'url_issued'; row.reference_id = referenceId; row.updated_at = at; return { ...row };
    },
    async markBrowserProxyFailed(orgId, sessionId, at) {
      const row = state.sessions.get(`${orgId}:${sessionId}`); if (row?.state === 'resolving') row.state = 'failed'; row.updated_at = at; return { changes: row ? 1 : 0 };
    },
    async getVoiceSessionStatus(orgId, sessionId, userId) {
      const row = state.sessions.get(`${orgId}:${sessionId}`); return row?.user_id === userId ? { ...row } : null;
    },
    async endVoiceSession(orgId, sessionId, userId, at) {
      const row = state.sessions.get(`${orgId}:${sessionId}`); if (!row || row.user_id !== userId || row.state === 'ended') return { changes: 0 };
      row.state = 'ended'; row.updated_at = at; return { changes: 1 };
    },
    async findVoiceSessionByOrgAndId(orgId, sessionId) { return state.sessions.get(`${orgId}:${sessionId}`) || null; },
    async findOutboundByIdempotency() { return null; },
    async findLatestOutboundForRecipient() { return null; },
    async reserveOutbound() { throw new Error('outbound route must remain unavailable'); },
    async markOutboundDialing() { return { changes: 0 }; },
    async markOutboundAccepted() { return null; },
    async markOutboundReconciliationRequired() { return { changes: 1 }; },
    async findOutboundByAttemptId(attemptId) { state.attemptLookups += 1; return state.attempt?.attempt_id === attemptId ? state.attempt : null; },
    async claimSarvamCallback(input) {
      const key = `${input.orgId}:${input.attemptId}:${input.callbackId}`;
      if (state.callbacks.has(key)) return { duplicate: true, org_id: input.orgId };
      state.callbacks.add(key); return { duplicate: false, org_id: input.orgId };
    },
    async recordSarvamOutcome(input) { state.outcomes.push(input); state.callbackTranscript = input.transcript; return { org_id: input.orgId, voice_session_id: input.voiceSessionId }; },
    async findVoiceCallbackTranscript() { return state.callbackTranscript || null; },
    async findPendingVoiceApproval() { return null; },
    async recordVoiceIntent() { throw new Error('voice intent routes must remain unavailable'); },
    async findVoiceIntentByIdempotency() { return null; },
    async findLatestVoiceIntentForApproval() { return null; },
    async consumePendingApproval() { return { changes: 0 }; },
    async lockOrganization() { return true; },
  };
  const credentialService = {
    async rotate({ orgId, connectionId }) {
      const row = state.connections.get(`${orgId}:${connectionId}`); row.status = 'connected'; row.credential_ready = 1; row.updated_at = NOW;
      return { connectionId, status: 'connected' };
    },
    async resolve() { return 'fixture-api-key-not-real'; },
  };
  const proxyTransport = {
    async get(url, options) {
      state.proxyCalls.push({ url, headers: { ...options.headers }, redirect: options.redirect });
      return { ok: proxyStatus >= 200 && proxyStatus < 300, status: proxyStatus, data: proxyResponse || { url: 'wss://voice.sarvam.ai/one-use?token=fixture-capability', reference_id: 'reference_fixture_1' } };
    },
  };
  const onboarding = onboardingService || {
    async get(orgId, sessionId) { return orgId === ORG && sessionId === state.onboarding.id ? { session: state.onboarding, profile: { version: 0 } } : null; },
    async turn(input) {
      state.onboardingTurns.push(input);
      return { profileVersion: 0, claims: [{ fieldPath: 'business.name', value: 'Fixture claim', confirmed: false, sourceTurnId: input.clientTurnId }] };
    },
  };
  const controller = createSarvamVoiceV2Controller({
    repository, credentialService, onboardingService: onboarding, HttpError,
    requireRole(context, role) {
      if (!context || !context.org || !context.user) throw new HttpError(401, 'Sign in to continue.', 'unauthorized');
      if (role === 'manager' && !['manager', 'admin', 'owner'].includes(context.org.role)) throw new HttpError(403, 'Manager access required.', 'forbidden');
    },
    sendJson(response, status, body, headers = {}) { response.status = status; response.body = body; Object.assign(response.headers, headers); return true; },
    newId: prefix => `${prefix}_fixture_${state.sessions.size + state.connections.size + state.callbacks.size + 1}`,
    timestamp: () => NOW,
    transaction: async operation => { state.transactionCalls += 1; state.transactionSawVerifiedAttemptLookup ||= state.attemptLookups > 0; return operation(); },
    env, pilotMode: () => pilot, proxyTransport, logger: record => state.logs.push(record),
  });
  const context = { org: { id: ORG, role: 'manager' }, user: { id: USER } };
  const call = async ({ path, method = 'GET', body = {}, request = {} } = {}) => {
    const response = responseCapture();
    const handled = await controller.handleAuthenticated({ path, method, request: { url: path, headers: {}, socket: {}, ...request }, response, body, context, org: context.org, user: context.user });
    return { handled, response };
  };
  return { controller, repository, state, env, context, call, credentialService, onboarding: onboarding };
}

async function setupLiveBrowserSession(harness) {
  const { call, state } = harness;
  const created = await call({ path: '/api/sarvam/v2/connections', method: 'POST', body: { ...APP_CONFIG, environment: 'staging', fixture: true } });
  const connectionId = created.response.body.connection.id;
  await call({ path: `/api/sarvam/v2/connections/${connectionId}/credentials`, method: 'POST', body: { apiKey: 'fixture-api-key-not-real' } });
  const session = await call({ path: '/api/sarvam/v2/sessions', method: 'POST', body: { connectionId, taskId: 'task_voice_test', onboardingSessionId: 'onboarding_voice_test', transcriptConsent: { status: 'granted', explicit: true } } });
  const cookie = session.response.headers['set-cookie'].split(';')[0];
  return { connectionId, voiceSessionId: session.response.body.voiceSessionId, cookie, session };
}

test('default status and outbound gates stay disabled; API responses never include credentials', async () => {
  const harness = makeHarness({ liveEnabled: false });
  const status = await harness.call({ path: '/api/sarvam/v2/status' });
  assert.equal(status.response.body.outbound.enabled, false);
  assert.equal(status.response.body.callbacks.liveVerified, false);
  assert.equal(status.response.body.askChief.enabled, false);
  const created = await harness.call({ path: '/api/sarvam/v2/connections', method: 'POST', body: { ...APP_CONFIG, environment: 'staging' } });
  assert.equal(created.response.status, 201);
  await harness.call({ path: `/api/sarvam/v2/connections/${created.response.body.connection.id}/credentials`, method: 'POST', body: { apiKey: 'fixture-api-key-not-real' } });
  const listed = await harness.call({ path: '/api/sarvam/v2/connections' });
  const responseText = JSON.stringify([created.response.body, listed.response.body]);
  assert.equal(responseText.includes('fixture-api-key-not-real'), false);
  assert.equal(responseText.includes('credential_ciphertext'), false);
});

test('manager, V2 allowlist, and PILOT_MODE gates reject setup and session routes', async () => {
  for (const harness of [makeHarness({ v2Enabled: false }), makeHarness({ pilot: true })]) {
    await assert.rejects(harness.call({ path: '/api/sarvam/v2/status' }), error => error instanceof HttpError && error.status >= 403);
  }
  const member = makeHarness();
  member.context.org.role = 'member';
  await assert.rejects(member.call({ path: '/api/sarvam/v2/connections' }), error => error.status === 403);
});

test('credential storage failures return bounded errors without echoing credential material', async () => {
  const harness = makeHarness();
  const created = await harness.call({ path: '/api/sarvam/v2/connections', method: 'POST', body: { ...APP_CONFIG, environment: 'staging' } });
  harness.credentialService.rotate = async () => { throw new Error('fixture-api-key-not-real leaked by broken storage adapter'); };
  await assert.rejects(harness.call({ path: `/api/sarvam/v2/connections/${created.response.body.connection.id}/credentials`, method: 'POST', body: { apiKey: 'fixture-api-key-not-real' } }), error => {
    assert.equal(error.message.includes('fixture-api-key-not-real'), false);
    assert.equal(error.code, 'sarvam_credentials_invalid');
    return true;
  });
});

test('exact SDK proxy path pins path/query, replaces browser API key, and returns only one-use WSS capability', async () => {
  const harness = makeHarness({ liveEnabled: true });
  const { voiceSessionId, cookie, session } = await setupLiveBrowserSession(harness);
  assert.equal(voiceSessionId.startsWith('voice_session_fixture_'), true);
  assert.equal(session.response.body.sdk.apiKey, '');
  assert.equal(harness.state.sessions.size, 1);
  const result = await harness.call({
    path: `/api/sarvam-proxy/orgs/${APP_CONFIG.sarvamOrgId}/workspaces/${APP_CONFIG.workspaceId}/apps/${APP_CONFIG.appId}/url`,
    request: { url: `/api/sarvam-proxy/orgs/${APP_CONFIG.sarvamOrgId}/workspaces/${APP_CONFIG.workspaceId}/apps/${APP_CONFIG.appId}/url?interaction_type=call&version=4&user_identifier=${USER}`, headers: { origin: 'https://crewos.example.test', 'sec-fetch-site': 'same-origin', cookie, 'x-api-key': 'browser-key-must-be-ignored' } },
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(Object.keys(result.response.body).sort(), ['reference_id', 'url']);
  assert.equal(result.response.body.url.startsWith('wss://voice.sarvam.ai/'), true);
  assert.equal(result.response.headers['cache-control'], 'no-store');
  assert.equal(result.response.headers.pragma, 'no-cache');
  assert.equal(harness.state.proxyCalls.length, 1);
  const call = harness.state.proxyCalls[0];
  const target = new URL(call.url);
  assert.equal(`${target.origin}${target.pathname}`, `https://apps.sarvam.ai/api/app-runtime/orgs/${APP_CONFIG.sarvamOrgId}/workspaces/${APP_CONFIG.workspaceId}/apps/${APP_CONFIG.appId}/url`);
  assert.equal(target.searchParams.get('interaction_type'), 'call');
  assert.equal(target.searchParams.get('version'), '4');
  assert.equal(target.searchParams.get('user_identifier'), USER);
  assert.equal(call.headers['X-API-Key'], 'fixture-api-key-not-real');
  assert.equal(JSON.stringify(result.response.body).includes('fixture-api-key-not-real'), false);
  const saved = harness.state.sessions.get(`${ORG}:${voiceSessionId}`);
  assert.equal(saved.state, 'url_issued');
  await assert.rejects(harness.call({
    path: `/api/sarvam-proxy/orgs/${APP_CONFIG.sarvamOrgId}/workspaces/${APP_CONFIG.workspaceId}/apps/${APP_CONFIG.appId}/url`,
    request: { url: `/api/sarvam-proxy/orgs/${APP_CONFIG.sarvamOrgId}/workspaces/${APP_CONFIG.workspaceId}/apps/${APP_CONFIG.appId}/url?interaction_type=CALL`, headers: { origin: 'https://crewos.example.test', 'sec-fetch-site': 'same-origin', cookie } },
  }), error => error.code === 'sarvam_proxy_binding_mismatch');
  assert.equal(harness.state.proxyCalls.length, 1);
});

test('fetch_call_context is read-only and requires the active browser session capability', async () => {
  const harness = makeHarness({ liveEnabled: true });
  const { voiceSessionId, cookie, session } = await setupLiveBrowserSession(harness);
  const proxyPath = `/api/sarvam-proxy/orgs/${APP_CONFIG.sarvamOrgId}/workspaces/${APP_CONFIG.workspaceId}/apps/${APP_CONFIG.appId}/url`;
  await harness.call({ path: proxyPath, request: { url: `${proxyPath}?interaction_type=call&version=4&user_identifier=${USER}`, headers: { origin: 'https://crewos.example.test', 'sec-fetch-site': 'same-origin', cookie } } });
  const response = responseCapture();
  const handled = await harness.controller.handleToolRequest({
    path: '/api/sarvam/v2/tools/fetch-call-context', method: 'POST', request: { headers: {} }, response,
    body: { voice_session_id: voiceSessionId, context_token: session.response.body.contextCapability },
  });
  assert.equal(handled, true);
  assert.equal(response.status, 200);
  assert.equal(response.body.mode, 'simulation');
  assert.equal(response.body.store.domain, 'northstar-demo.myshopify.com');
  assert.equal(response.body.customerService.messagesOrCallsSent, false);
  assert.equal(response.body.externalEffects, false);
  assert.equal(JSON.stringify(response.body).includes(session.response.body.contextCapability), false);

  await assert.rejects(harness.controller.handleToolRequest({
    path: '/api/sarvam/v2/tools/fetch-call-context', method: 'POST', request: { headers: {} }, response: responseCapture(),
    body: { voice_session_id: voiceSessionId, context_token: 'x'.repeat(48) },
  }), error => error.code === 'voice_context_capability_invalid');
  await harness.call({ path: `/api/sarvam/v2/sessions/${voiceSessionId}`, method: 'DELETE' });
  await assert.rejects(harness.controller.handleToolRequest({
    path: '/api/sarvam/v2/tools/fetch-call-context', method: 'POST', request: { headers: {} }, response: responseCapture(),
    body: { voice_session_id: voiceSessionId, context_token: session.response.body.contextCapability },
  }), error => error.code === 'voice_context_capability_invalid');
});

test('proxy rejects cross-origin, malformed path/query, mismatched app, and replay before transport', async () => {
  const harness = makeHarness({ liveEnabled: true });
  const { cookie } = await setupLiveBrowserSession(harness);
  const base = `/api/sarvam-proxy/orgs/${APP_CONFIG.sarvamOrgId}/workspaces/${APP_CONFIG.workspaceId}/apps/${APP_CONFIG.appId}/url`;
  const input = requestUrl => ({ url: requestUrl, headers: { origin: 'https://crewos.example.test', 'sec-fetch-site': 'same-origin', cookie } });
  await assert.rejects(harness.call({ path: `${base}/unexpected`, request: input(`${base}/unexpected?interaction_type=CALL`) }), error => error.code === 'sarvam_proxy_path_invalid');
  const crossOriginRequest = input(`${base}?interaction_type=CALL&unknown=x`);
  crossOriginRequest.headers.origin = 'https://attacker.example';
  await assert.rejects(harness.call({ path: base, request: crossOriginRequest }), error => error.code === 'sarvam_origin_blocked');
  await assert.rejects(harness.call({ path: base, request: input(`${base}?interaction_type=CALL&unknown=x`) }), error => error.code === 'sarvam_proxy_query_invalid');
  await assert.rejects(harness.call({ path: base.replace(APP_CONFIG.appId, 'other_app'), request: input(`${base.replace(APP_CONFIG.appId, 'other_app')}?interaction_type=CALL`) }), error => error.code === 'sarvam_proxy_binding_mismatch');
  await assert.rejects(harness.call({ path: base.replace(APP_CONFIG.sarvamOrgId, 'other_org'), request: input(`${base.replace(APP_CONFIG.sarvamOrgId, 'other_org')}?interaction_type=CALL`) }), error => error.code === 'sarvam_proxy_binding_mismatch');
  await assert.rejects(harness.call({ path: base, request: input(`${base}?interaction_type=CALL&version=999`) }), error => error.code === 'sarvam_proxy_query_invalid');
  assert.equal(harness.state.proxyCalls.length, 0);
});

test('proxy rejects unsafe provider URL without returning it or recording the signed capability', async () => {
  const harness = makeHarness({ liveEnabled: true, proxyResponse: { url: 'https://attacker.example/steal', reference_id: 'reference_fixture_2' } });
  const { cookie } = await setupLiveBrowserSession(harness);
  const base = `/api/sarvam-proxy/orgs/${APP_CONFIG.sarvamOrgId}/workspaces/${APP_CONFIG.workspaceId}/apps/${APP_CONFIG.appId}/url`;
  await assert.rejects(harness.call({ path: base, request: { url: `${base}?interaction_type=CALL`, headers: { origin: 'https://crewos.example.test', 'sec-fetch-site': 'same-origin', cookie } } }), error => error.code === 'sarvam_proxy_response_invalid');
  assert.equal(harness.state.sessions.values().next().value.reference_id, undefined);
});

test('proxy records only upstream HTTP status for failed signed URL requests', async () => {
  const harness = makeHarness({
    liveEnabled: true,
    proxyStatus: 400,
    proxyResponse: { error: 'provider detail', url: 'wss://voice.sarvam.ai/private-signed-url', apiKey: 'provider-secret' },
  });
  const { cookie } = await setupLiveBrowserSession(harness);
  const base = `/api/sarvam-proxy/orgs/${APP_CONFIG.sarvamOrgId}/workspaces/${APP_CONFIG.workspaceId}/apps/${APP_CONFIG.appId}/url`;
  await assert.rejects(harness.call({ path: base, request: { url: `${base}?interaction_type=call`, headers: { origin: 'https://crewos.example.test', 'sec-fetch-site': 'same-origin', cookie } } }), error => error.code === 'sarvam_proxy_upstream_failed');
  assert.deepEqual(harness.state.logs, [{ event: 'sarvam.proxy.upstream_failed', upstreamStatus: 400 }]);
  assert.equal(JSON.stringify(harness.state.logs).includes('provider detail'), false);
  assert.equal(JSON.stringify(harness.state.logs).includes('private-signed-url'), false);
  assert.equal(JSON.stringify(harness.state.logs).includes('provider-secret'), false);
});

test('browser transcript goes through Onboarding V2 with role labels, stable replay hash, and no confirmed claims', async () => {
  const harness = makeHarness({ fixtureEnabled: true });
  const connection = await harness.call({ path: '/api/sarvam/v2/connections', method: 'POST', body: { ...APP_CONFIG, environment: 'simulation' } });
  const created = await harness.call({ path: '/api/sarvam/v2/sessions', method: 'POST', body: { connectionId: connection.response.body.connection.id, taskId: 'task_voice_test', onboardingSessionId: 'onboarding_voice_test', transcriptConsent: true } });
  const voiceSessionId = created.response.body.voiceSessionId;
  const status = await harness.call({ path: `/api/sarvam/v2/sessions/${voiceSessionId}` });
  assert.equal(status.response.body.state, 'created');
  assert.equal(status.response.body.org_id, ORG);
  await harness.call({ path: `/api/sarvam/v2/sessions/${voiceSessionId}`, method: 'DELETE' });
  const ended = await harness.call({ path: `/api/sarvam/v2/sessions/${voiceSessionId}` });
  assert.equal(ended.response.body.state, 'ended');
  const completedSession = harness.state.sessions.get(`${ORG}:${voiceSessionId}`);
  assert.equal(completedSession.session_type, 'browser');
  assert.equal(completedSession.org_id, ORG);
  assert.equal(completedSession.user_id, USER);
  const body = { turns: [{ role: 'agent', en_text: 'Please tell me your business name.' }, { role: 'user', en_text: 'Our business is called Fixture Bakery.' }] };
  const first = await harness.call({ path: `/api/sarvam/v2/sessions/${voiceSessionId}/transcript`, method: 'POST', body });
  const second = await harness.call({ path: `/api/sarvam/v2/sessions/${voiceSessionId}/transcript`, method: 'POST', body });
  assert.equal(first.response.body.clientTurnId, second.response.body.clientTurnId);
  assert.equal(first.response.body.transcriptHash, second.response.body.transcriptHash);
  assert.equal(harness.state.onboardingTurns.length, 2);
  assert.match(harness.state.onboardingTurns[0].text, /role: agent/);
  assert.match(harness.state.onboardingTurns[0].text, /role: user/);
  assert.deepEqual(harness.state.onboardingTurns[0].confirmedClaimIds, []);
  assert.equal(first.response.body.claims[0].confirmed, false);
  assert.equal(first.response.body.managerConfirmationRequired, true);
});

test('callback service rejects before transaction or JSON parse when verifier is missing', async () => {
  const harness = makeHarness({ fixtureEnabled: false, callbackVerifier: null });
  await assert.rejects(harness.controller.handleCallback({
    path: '/api/webhooks/sarvam/outbound', method: 'POST', request: { headers: {} }, response: responseCapture(), rawBody: Buffer.from('{not-json'),
  }), error => error.code === 'voice_callback_verifier_required');
  assert.equal(harness.state.transactionCalls, 0);
  assert.equal(harness.state.outcomes.length, 0);
});

test('local signed fixture callback verifies raw bytes, persists once, and preserves role evidence for Chief', async () => {
  const harness = makeHarness({ fixtureEnabled: true });
  harness.state.attempt = {
    org_id: ORG, voice_session_id: 'voice_fixture_callback', task_id: 'task_voice_test', connection_id: 'fixture_connection',
    environment: 'simulation', attempt_id: 'attempt_fixture_1', recipient_phone: 'phone_hash_fixture',
    transcript_consent_status: 'granted', transcript_consent_explicit: 1,
    transcript_consent_recipient_phone: 'phone_hash_fixture', transcript_consent_captured_at: NOW,
  };
  harness.state.connections.set(`${ORG}:fixture_connection`, { id: 'fixture_connection', org_id: ORG, provider: 'sarvam', environment: 'simulation', status: 'connected', config: { fixture: true } });
  harness.state.sessions.set(`${ORG}:voice_fixture_callback`, { org_id: ORG, voice_session_id: 'voice_fixture_callback', user_id: USER, task_id: 'task_voice_test', onboarding_session_id: 'onboarding_voice_test', approval_id: null, session_type: 'outbound', environment: 'simulation' });
  const payload = {
    status: 'connected', attempt_id: 'attempt_fixture_1', interaction_id: 'interaction_fixture_1',
    interaction_transcript: [{ role: 'agent', en_text: 'Tell me your organization name.' }, { role: 'user', en_text: 'Our business is called Fixture Bakery.' }],
    webhook_config: { metadata: { voiceSessionId: 'voice_fixture_callback', taskId: 'task_voice_test' } },
  };
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = createHmac('sha256', FIXTURE_SECRET).update(rawBody).digest('hex');
  await assert.rejects(harness.controller.handleCallback({ path: '/api/webhooks/sarvam/outbound', method: 'POST', request: { headers: { 'x-crewos-fixture-signature': signature } }, response: responseCapture(), rawBody }), error => error.code === 'voice_callback_verifier_required');
  const first = responseCapture();
  await harness.controller.handleCallback({ path: '/api/local-fixtures/webhooks/sarvam/outbound', method: 'POST', request: { headers: { 'x-crewos-fixture-signature': signature } }, response: first, rawBody });
  const second = responseCapture();
  await harness.controller.handleCallback({ path: '/api/local-fixtures/webhooks/sarvam/outbound', method: 'POST', request: { headers: { 'x-crewos-fixture-signature': signature } }, response: second, rawBody });
  assert.equal(first.status, 202);
  assert.equal(second.status, 200);
  assert.equal(harness.state.outcomes.length, 1);
  assert.equal(harness.state.transactionSawVerifiedAttemptLookup, true);
  assert.equal(harness.state.onboardingTurns.length, 1);
  assert.match(harness.state.onboardingTurns[0].text, /role: agent/);
  assert.match(harness.state.onboardingTurns[0].text, /role: user/);
  assert.deepEqual(harness.state.onboardingTurns[0].confirmedClaimIds, []);
  const transcriptHash = createHash('sha256').update(JSON.stringify({ orgId: ORG, voiceSessionId: 'voice_fixture_callback', onboardingSessionId: 'onboarding_voice_test', turns: payload.interaction_transcript })).digest('hex');
  assert.equal(harness.state.onboardingTurns[0].clientTurnId, `sarvam_${transcriptHash}`);
});

test('spoken approval and ask-chief routes remain unavailable; no action executor is called', async () => {
  const harness = makeHarness({ fixtureEnabled: true });
  await assert.rejects(harness.call({ path: '/api/sarvam/v2/outbounds', method: 'POST', body: { intent: 'approve' } }), error => error.code === 'voice_callback_verifier_required');
  await assert.rejects(harness.call({ path: '/api/sarvam/v2/tools/ask-chief', method: 'POST', body: { intent: 'approve' } }), error => error.code === 'voice_tool_binding_unavailable');
  assert.equal(harness.state.effectCalls, 0);
  assert.equal(harness.state.outcomes.length, 0);
});
