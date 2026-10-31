import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createSarvamVoiceSessionService } from '../services/sarvam-voice-session.mjs';
import { normalizeSarvamCallback } from '../integrations/sarvam-voice.mjs';
import { organizationEngineV2Status } from '../services/feature-flags.mjs';
import { expectedAppOrigin, isAllowedAppOrigin } from '../utils/origin-policy.mjs';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const API_RUNTIME_ORIGIN = 'https://apps.sarvam.ai';
const API_RUNTIME_PATH = '/api/app-runtime';
const VOICE_COOKIE = 'crewos_sarvam_voice';
const ENABLED = new Set(['1', 'true', 'on', 'yes']);
const truthy = value => ENABLED.has(String(value ?? '').toLowerCase());
const digest = value => createHash('sha256').update(value).digest('hex');
const idValid = value => typeof value === 'string' && ID_PATTERN.test(value);
const fail = (HttpError, status, message, code = 'sarvam_voice_unavailable') => { throw new HttpError(status, message, code); };

function cleanConfig(config) {
  return {
    sarvamOrgId: config.sarvamOrgId,
    workspaceId: config.workspaceId,
    appId: config.appId,
    appVersion: config.appVersion,
    voiceModel: config.voiceModel,
    languages: config.languages,
    telephonyConnectionId: config.telephonyConnectionId || null,
    agentPhoneNumber: config.agentPhoneNumber || null,
    fixture: config.fixture === true,
  };
}

function publicConnection(row) {
  return {
    id: row.id,
    provider: 'sarvam',
    environment: row.environment,
    status: row.status,
    config: cleanConfig(row.config || {}),
    credentialReady: Boolean(row.credential_ready),
    credentialVersion: Number(row.credential_version || 0),
    credentialExpiresAt: row.credential_expires_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function consentIsExplicit(value) {
  return value === true || value?.explicit === true && value?.status === 'granted';
}

function serverAppConfigDefaults(env) {
  const languages = [...new Set(String(env.SARVAM_LANGUAGES || 'en-IN').split(',').map(value => value.trim()).filter(value => /^[A-Za-z0-9_-]{2,24}$/.test(value)))];
  const rawVersion = String(env.SARVAM_APP_VERSION || '').trim();
  const appVersion = /^\d+$/.test(rawVersion) ? Number(rawVersion) : null;
  const defaults = {
    sarvamOrgId: String(env.SARVAM_ORG_ID || '').trim(),
    workspaceId: String(env.SARVAM_WORKSPACE_ID || '').trim(),
    appId: String(env.SARVAM_APP_ID || '').trim(),
    appVersion,
    voiceModel: String(env.SARVAM_VOICE_MODEL || 'Sarvam Voice Agent').trim(),
    languages: languages.length ? languages : ['en-IN'],
    environment: ['staging', 'production', 'simulation'].includes(String(env.SARVAM_ENVIRONMENT || '').trim())
      ? String(env.SARVAM_ENVIRONMENT).trim() : 'staging',
  };
  return {
    ...defaults,
    configured: idValid(defaults.sarvamOrgId) && idValid(defaults.workspaceId) && idValid(defaults.appId) &&
      Number.isSafeInteger(defaults.appVersion) && defaults.appVersion > 0,
    provided: {
      sarvamOrgId: idValid(defaults.sarvamOrgId),
      workspaceId: idValid(defaults.workspaceId),
      appId: idValid(defaults.appId),
      appVersion: Number.isSafeInteger(defaults.appVersion) && defaults.appVersion > 0,
      voiceModel: Boolean(String(env.SARVAM_VOICE_MODEL || '').trim()),
      languages: Boolean(String(env.SARVAM_LANGUAGES || '').trim()),
    },
  };
}

function normalizeBrowserTurns(turns, HttpError) {
  if (!Array.isArray(turns) || turns.length < 1 || turns.length > 100) fail(HttpError, 400, 'Transcript turns must contain between 1 and 100 entries.', 'voice_transcript_invalid');
  let chars = 0;
  const normalized = [];
  for (const turn of turns) {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn) || !['agent', 'user'].includes(turn.role) || typeof turn.en_text !== 'string') {
      fail(HttpError, 400, 'Transcript turns must include a supported role and text.', 'voice_transcript_invalid');
    }
    chars += turn.en_text.length;
    normalized.push({ role: turn.role, en_text: turn.en_text });
    if (chars > 20_000 || Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 40_000) {
      fail(HttpError, 413, 'Transcript exceeds the retention limit.', 'voice_transcript_too_large');
    }
  }
  if (!normalized.some(turn => turn.role === 'user' && turn.en_text.trim())) fail(HttpError, 400, 'Transcript must contain a user turn.', 'voice_transcript_invalid');
  return normalized;
}

function transcriptForOnboarding(turns) {
  return turns.map(turn => `[Sarvam transcript role: ${turn.role}]\n${turn.en_text}`).join('\n\n');
}

function signedFixtureVerifier(secret, repository) {
  return async ({ headers, rawBody }) => {
    if (!Buffer.isBuffer(rawBody) || typeof secret !== 'string' || secret.length < 16) return false;
    const supplied = String(headers?.['x-crewos-fixture-signature'] || '');
    if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    const actual = Buffer.from(supplied, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    let payload;
    try { payload = JSON.parse(rawBody.toString('utf8')); } catch { return false; }
    if (!idValid(payload?.attempt_id)) return false;
    const attempt = await repository.findOutboundByAttemptId(payload.attempt_id);
    if (!attempt || attempt.environment !== 'simulation') return false;
    const connection = await repository.findConnectionByOrgAndId(attempt.org_id, attempt.connection_id);
    return Boolean(connection && connection.environment === 'simulation' && connection.status === 'connected' && connection.config?.fixture === true);
  };
}

/**
 * Authenticated V2 connection, browser session, and exact SDK proxy boundary.
 * Outbound and voice-tool calls remain disabled until separately wired to trusted
 * authorization and callback verification.
 */
export function createSarvamVoiceV2Controller({
  repository,
  credentialService = null,
  onboardingService = null,
  HttpError,
  requireRole,
  sendJson,
  newId,
  timestamp,
  transaction = operation => operation(),
  env = process.env,
  pilotMode = () => truthy(env.PILOT_MODE),
  parseCookie = defaultParseCookie,
  proxyTransport = null,
  liveCredentialResolver = credentialService,
  logger = () => {},
}) {
  if (!repository || typeof requireRole !== 'function' || typeof sendJson !== 'function' || typeof newId !== 'function' || typeof timestamp !== 'function') {
    throw new Error('Sarvam V2 controller requires repository, authorization, response, ID, and clock interfaces.');
  }

  const fixtureEnabled = env.NODE_ENV !== 'production' && truthy(env.CREWOS_LOCAL_WEBHOOK_FIXTURES) && truthy(env.SARVAM_LOCAL_FIXTURES);
  const callbackVerifier = fixtureEnabled ? signedFixtureVerifier(env.CREWOS_LOCAL_WEBHOOK_FIXTURE_SECRET, repository) : undefined;
  const callbackServiceOptions = {
    repository,
    provider: null,
    authorizer: {
      authorizeOutbound: async () => ({ allowed: false }),
      authorizeVoiceIntent: async () => ({ allowed: false }),
      authorizeManagerConfirmation: async () => false,
    },
    transaction,
    lockOrganization: repository.lockOrganization,
    liveEnabled: false,
    newId,
    timestamp,
    logger,
  };
  // The public Sarvam route is unconditionally fail-closed. The internal fixture
  // route gets a separate service instance so its synthetic HMAC can never be
  // mistaken for provider authentication on the public callback URL.
  const callbackService = createSarvamVoiceSessionService({ ...callbackServiceOptions, fixtureEnabled: false });
  const fixtureCallbackService = fixtureEnabled
    ? createSarvamVoiceSessionService({ ...callbackServiceOptions, verifyCallback: callbackVerifier, fixtureEnabled: true })
    : null;

  function requireV2(context, org) {
    requireRole(context, 'manager');
    if (!organizationEngineV2Status(org.id, env).enabled) fail(HttpError, 404, 'Organization Engine V2 voice setup is disabled for this workspace.', 'v2_disabled');
    if (pilotMode()) fail(HttpError, 403, 'Sarvam voice is unavailable while PILOT_MODE is enabled.', 'pilot_mode_blocked');
  }

  function capabilityStatus(org) {
    const liveEnabled = truthy(env.SARVAM_LIVE_ENABLED);
    const serverCredentialConfigured = Boolean(String(env.SARVAM_API_KEY || '').trim() && credentialService);
    return {
      enabled: organizationEngineV2Status(org.id, env).enabled && !pilotMode(),
      pilotMode: Boolean(pilotMode()),
      localFixtureEnabled: fixtureEnabled,
      serverCredentialConfigured,
      browserVoice: { liveEnabled, fixtureEnabled, status: liveEnabled || fixtureEnabled ? 'configuration_required' : 'disabled' },
      outbound: { enabled: false, status: 'callback_verifier_required' },
      callbacks: { liveVerified: false, status: 'supported_verifier_or_trusted_ingress_required' },
      voiceIntent: { enabled: false, status: 'trusted_voice_tool_session_binding_unavailable' },
      askChief: { enabled: false, status: 'trusted_voice_tool_session_binding_unavailable' },
      protectedActionsExecutedByVoice: false,
    };
  }

  function makeConnectionConfig(body, environment) {
    const defaults = serverAppConfigDefaults(env);
    const configuredValue = (value, fallback) => typeof value === 'string' && value.trim() ? value.trim() : fallback;
    const sarvamOrgId = configuredValue(body.sarvamOrgId, defaults.sarvamOrgId);
    const workspaceId = configuredValue(body.workspaceId, defaults.workspaceId);
    const appId = configuredValue(body.appId, defaults.appId);
    const voiceModel = configuredValue(body.voiceModel, defaults.voiceModel);
    if (!idValid(sarvamOrgId) || sarvamOrgId.length > 160) fail(HttpError, 400, 'Sarvam organization ID is required. Set SARVAM_ORG_ID in backend/.env or enter it in Voice setup.', 'sarvam_config_invalid');
    if (!idValid(workspaceId) || workspaceId.length > 160) fail(HttpError, 400, 'Sarvam workspace ID is required. Set SARVAM_WORKSPACE_ID in backend/.env or enter it in Voice setup.', 'sarvam_config_invalid');
    if (!idValid(appId) || appId.length > 160) fail(HttpError, 400, 'Sarvam app ID is required. Set SARVAM_APP_ID in backend/.env or enter it in Voice setup.', 'sarvam_config_invalid');
    if (typeof voiceModel !== 'string' || !voiceModel.trim() || voiceModel.length > 160 || /[\u0000-\u001f\u007f]/.test(voiceModel)) fail(HttpError, 400, 'Sarvam voice model label is invalid.', 'sarvam_config_invalid');
    const appVersion = body.appVersion == null || body.appVersion === '' ? defaults.appVersion : Number(body.appVersion);
    if (!Number.isSafeInteger(appVersion) || appVersion < 1) fail(HttpError, 400, 'A pinned positive Sarvam app version is required. Set SARVAM_APP_VERSION in backend/.env or enter it in Voice setup.', 'sarvam_config_invalid');
    const languages = Array.isArray(body.languages) && body.languages.length ? body.languages : defaults.languages;
    if (!Array.isArray(languages) || languages.length < 1 || languages.length > 16 || languages.some(language => typeof language !== 'string' || !/^[A-Za-z0-9_-]{2,24}$/.test(language))) {
      fail(HttpError, 400, 'Choose between 1 and 16 bounded language identifiers.', 'sarvam_config_invalid');
    }
    const telephonyConnectionId = body.telephonyConnectionId == null || body.telephonyConnectionId === '' ? null : body.telephonyConnectionId;
    if (telephonyConnectionId !== null && !idValid(telephonyConnectionId)) fail(HttpError, 400, 'Sarvam telephony connection ID is invalid.', 'sarvam_config_invalid');
    const agentPhoneNumber = body.agentPhoneNumber == null || body.agentPhoneNumber === '' ? null : body.agentPhoneNumber;
    if (agentPhoneNumber !== null && (typeof agentPhoneNumber !== 'string' || !/^\+[1-9][0-9]{7,14}$/.test(agentPhoneNumber))) fail(HttpError, 400, 'Agent phone number must use E.164.', 'sarvam_config_invalid');
    return {
      sarvamOrgId,
      workspaceId,
      appId,
      appVersion,
      voiceModel,
      languages: [...new Set(languages)],
      telephonyConnectionId,
      agentPhoneNumber,
      fixture: environment === 'simulation' && fixtureEnabled,
    };
  }

  function cookieHeader(token, request, maxAge = 600) {
    const secure = env.COOKIE_SECURE === 'true' || env.NODE_ENV === 'production' || Boolean(request.socket?.encrypted);
    return `${VOICE_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/api/sarvam-proxy; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }

  function clearVoiceCookie(request) { return cookieHeader('', request, 0); }

  function assertSameOrigin(request) {
    const origin = request.headers.origin;
    const expectedOrigin = expectedAppOrigin(request, env);
    if (origin) {
      let normalized;
      try { normalized = new URL(origin).origin; } catch { fail(HttpError, 403, 'Sarvam proxy requests must be same-origin.', 'sarvam_origin_blocked'); }
      if (!isAllowedAppOrigin(origin, env, request)) fail(HttpError, 403, 'Sarvam proxy requests must be same-origin.', 'sarvam_origin_blocked');
      return normalized;
    } else if (request.headers['sec-fetch-site'] !== 'same-origin') {
      fail(HttpError, 403, 'Sarvam proxy requests must prove same-origin browser context.', 'sarvam_origin_blocked');
    }
    if (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin') fail(HttpError, 403, 'Sarvam proxy requests must be same-origin.', 'sarvam_origin_blocked');
    return expectedOrigin;
  }

  function validateProxyTarget(value, allowFixture = false) {
    let target;
    try { target = new URL(value); } catch { fail(HttpError, 502, 'Sarvam returned an invalid temporary voice URL.', 'sarvam_proxy_response_invalid'); }
    const providerHost = target.hostname === 'sarvam.ai' || target.hostname.endsWith('.sarvam.ai');
    const fixtureHost = allowFixture && target.hostname === 'fixture.invalid';
    if (target.protocol !== 'wss:' || !(providerHost || fixtureHost) || target.username || target.password || target.port || target.hash || !target.pathname || target.pathname === '/') {
      fail(HttpError, 502, 'Sarvam returned a voice URL outside the secure provider allowlist.', 'sarvam_proxy_response_invalid');
    }
    return target.toString();
  }

  async function proxyUrl({ request, response, context, org, path }) {
    requireV2(context, org);
    const expectedOrigin = assertSameOrigin(request);
    const match = path.match(/^\/api\/sarvam-proxy\/orgs\/([^/]+)\/workspaces\/([^/]+)\/apps\/([^/]+)\/url$/);
    if (!match || match.slice(1).some(value => !idValid(value))) fail(HttpError, 404, 'Sarvam SDK proxy path is invalid.', 'sarvam_proxy_path_invalid');
    let requestUrl;
    try { requestUrl = new URL(request.url || '/', expectedOrigin); }
    catch { fail(HttpError, 400, 'Sarvam SDK request URL is invalid.', 'sarvam_proxy_path_invalid'); }
    let decodedPath;
    try { decodedPath = decodeURIComponent(requestUrl.pathname); }
    catch { fail(HttpError, 400, 'Sarvam SDK request path is invalid.', 'sarvam_proxy_path_invalid'); }
    if (requestUrl.origin !== expectedOrigin || decodedPath !== path) fail(HttpError, 403, 'Sarvam SDK request must use the authenticated same-origin path.', 'sarvam_origin_blocked');
    const allowedQuery = new Set(['interaction_type', 'version', 'user_identifier', 'user_identifier_type']);
    for (const key of requestUrl.searchParams.keys()) {
      if (!allowedQuery.has(key) || requestUrl.searchParams.getAll(key).length !== 1) fail(HttpError, 400, 'Sarvam SDK query contains an unsupported or repeated field.', 'sarvam_proxy_query_invalid');
    }
    const [sarvamOrgId, workspaceId, appId] = match.slice(1);
    const interactionType = requestUrl.searchParams.get('interaction_type');
    // SDK 0.0.42 serializes InteractionType.CALL as `call`; the provider runtime
    // request below is deliberately canonicalized to `CALL`.
    if (interactionType !== 'call' && interactionType !== 'CALL') fail(HttpError, 400, 'Sarvam SDK interaction_type must be CALL.', 'sarvam_proxy_query_invalid');
    const sessionToken = parseCookie(request.headers.cookie || '', VOICE_COOKIE);
    if (!sessionToken) fail(HttpError, 401, 'A current browser voice session is required.', 'voice_session_required');
    const session = await repository.findBrowserSessionByToken(org.id, context.user.id, digest(sessionToken));
    if (!session || session.state !== 'created' || Date.parse(session.expires_at) <= Date.parse(timestamp()) ||
        session.connection_status !== 'connected' || session.sarvam_org_id !== sarvamOrgId || session.workspace_id !== workspaceId || session.app_id !== appId) {
      fail(HttpError, 403, 'Sarvam SDK request does not match an active organization-owned voice session.', 'sarvam_proxy_binding_mismatch');
    }
    const appConfig = session.app_config || {};
    if (session.app_version !== Number(appConfig.appVersion) || session.config_hash !== digest(JSON.stringify(appConfig)) ||
        !session.connection_config || JSON.stringify(session.connection_config) !== JSON.stringify(appConfig) ||
        digest(JSON.stringify(session.connection_config)) !== session.config_hash) {
      fail(HttpError, 409, 'Stored Sarvam app binding changed after voice session creation.', 'sarvam_proxy_binding_mismatch');
    }
    const requestedVersion = requestUrl.searchParams.get('version');
    if (requestedVersion !== null && String(Number(requestedVersion)) !== String(session.app_version)) fail(HttpError, 400, 'Sarvam SDK version does not match the pinned app version.', 'sarvam_proxy_query_invalid');
    const requestedUserId = requestUrl.searchParams.get('user_identifier');
    if (requestedUserId !== null && requestedUserId !== context.user.id) fail(HttpError, 403, 'Sarvam SDK user identifier must match the authenticated user.', 'sarvam_proxy_query_invalid');
    const userIdentifierType = requestUrl.searchParams.get('user_identifier_type');
    if (userIdentifierType !== null && !/^[A-Za-z0-9_-]{1,40}$/.test(userIdentifierType)) fail(HttpError, 400, 'Sarvam SDK user identifier type is invalid.', 'sarvam_proxy_query_invalid');

    const claimed = await repository.claimBrowserProxyUrl(org.id, session.voice_session_id, context.user.id, timestamp());
    if (!claimed || claimed.changes !== 1 || claimed.session?.org_id !== org.id || claimed.session?.voice_session_id !== session.voice_session_id || claimed.session?.state !== 'resolving') {
      fail(HttpError, 409, 'This Sarvam browser session has already requested its one-use URL.', 'voice_session_replayed');
    }
    try {
      let payload;
      if (session.environment === 'simulation') {
        if (!fixtureEnabled || appConfig.fixture !== true) fail(HttpError, 503, 'Simulation connections accept only explicit local fixtures.', 'sarvam_fixture_required');
        // Deliberately non-routable deterministic fixture capability.
        payload = { url: `wss://fixture.invalid/one-use/${randomBytes(16).toString('hex')}`, reference_id: newId('fixture_reference') };
      } else {
        if (!truthy(env.SARVAM_LIVE_ENABLED) || typeof proxyTransport?.get !== 'function' || !liveCredentialResolver?.resolve) {
          fail(HttpError, 503, 'Live Sarvam browser voice requires an explicit enablement flag, encrypted credential resolver, and injected proxy transport.', 'sarvam_live_disabled');
        }
        const connection = await repository.findConnectionByOrgAndId(org.id, session.connection_id);
        if (!connection || connection.status !== 'connected' || connection.environment !== session.environment || connection.provider !== 'sarvam') {
          fail(HttpError, 503, 'Sarvam connection is not ready for browser voice.', 'sarvam_connection_unavailable');
        }
        const apiKey = await liveCredentialResolver.resolve({ orgId: org.id, connectionId: connection.id, providerAccountId: connection.provider_account_id, environment: connection.environment });
        if (typeof apiKey !== 'string' || apiKey.length < 8) fail(HttpError, 503, 'Encrypted Sarvam credentials are unavailable.', 'sarvam_credentials_unavailable');
        const target = new URL(`${API_RUNTIME_ORIGIN}${API_RUNTIME_PATH}/orgs/${encodeURIComponent(session.sarvam_org_id)}/workspaces/${encodeURIComponent(session.workspace_id)}/apps/${encodeURIComponent(session.app_id)}/url`);
        target.searchParams.set('interaction_type', 'CALL');
        target.searchParams.set('version', String(session.app_version));
        target.searchParams.set('user_identifier', context.user.id);
        if (userIdentifierType) target.searchParams.set('user_identifier_type', userIdentifierType);
        const response = await proxyTransport.get(target.toString(), { headers: { 'X-API-Key': apiKey, Accept: 'application/json' }, redirect: 'error' });
        if (!response || response.ok !== true) fail(HttpError, 502, 'Sarvam app runtime could not issue a temporary voice URL.', 'sarvam_proxy_upstream_failed');
        payload = typeof response.json === 'function' ? await response.json() : response.data;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.url !== 'string' || typeof payload.reference_id !== 'string' || !ID_PATTERN.test(payload.reference_id)) {
        fail(HttpError, 502, 'Sarvam app runtime response did not match its allowlisted contract.', 'sarvam_proxy_response_invalid');
      }
      const signedUrl = validateProxyTarget(payload.url, session.environment === 'simulation' && fixtureEnabled && appConfig.fixture === true);
      const completed = await repository.finishBrowserProxyUrl(org.id, session.voice_session_id, payload.reference_id, timestamp());
      if (!completed || completed.state !== 'url_issued') fail(HttpError, 409, 'Sarvam browser URL issuance lost its session fence.', 'voice_session_replayed');
      // This signed URL is a short-lived, single-use capability. Never log or persist it.
      return sendJson(response, 200, { url: signedUrl, reference_id: payload.reference_id }, { 'cache-control': 'no-store', 'set-cookie': clearVoiceCookie(request), pragma: 'no-cache' });
    } catch (error) {
      await repository.markBrowserProxyFailed(org.id, session.voice_session_id, timestamp()).catch(() => {});
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'Sarvam app runtime could not issue a temporary voice URL.', 'sarvam_proxy_upstream_failed');
    }
  }

  async function handleAuthenticated({ path, method, request, response, body = {}, context, org, user }) {
    if (path === '/api/sarvam-proxy' || path.startsWith('/api/sarvam-proxy/')) {
      if (method !== 'GET') fail(HttpError, 405, 'Sarvam SDK proxy accepts GET only.', 'method_not_allowed');
      return proxyUrl({ request, response, context, org, path });
    }
    if (!path.startsWith('/api/sarvam/v2/')) return false;
    if (typeof repository.purgeExpiredVoiceTranscripts === 'function') await repository.purgeExpiredVoiceTranscripts(timestamp(), org.id).catch(() => {});
    requireV2(context, org);
    if (['POST', 'PUT', 'PATCH'].includes(method) && (!body || typeof body !== 'object' || Array.isArray(body))) {
      fail(HttpError, 400, 'Sarvam request body must be a JSON object.', 'sarvam_request_invalid');
    }

    if (path === '/api/sarvam/v2/status' && method === 'GET') return sendJson(response, 200, capabilityStatus(org));
    if (path === '/api/sarvam/v2/connections' && method === 'GET') {
      const rows = await repository.listConnections(org.id);
      const defaults = serverAppConfigDefaults(env);
      return sendJson(response, 200, {
        connections: rows.map(publicConnection),
        serverAppConfig: {
          configured: defaults.configured,
          environment: defaults.environment,
          appVersion: defaults.appVersion,
          voiceModel: defaults.voiceModel,
          languages: defaults.languages,
          provided: defaults.provided,
        },
      });
    }
    if (path === '/api/sarvam/v2/connections' && method === 'POST') {
      const environment = body.environment || serverAppConfigDefaults(env).environment;
      if (!['simulation', 'staging', 'production'].includes(environment)) fail(HttpError, 400, 'Choose simulation, staging, or production environment.', 'sarvam_config_invalid');
      const config = makeConnectionConfig(body, environment);
      const connectionId = newId('sarvam_connection');
      const row = await repository.createConnection({ orgId: org.id, connectionId, providerAccountId: config.workspaceId, environment, config, createdAt: timestamp() });
      let connected = row;
      if (environment === 'simulation' && fixtureEnabled && config.fixture === true) {
        const activation = await repository.activateFixtureConnection(org.id, row.id, timestamp());
        if (activation?.changes === 1) connected = await repository.findConnectionByOrgAndId(org.id, row.id);
      } else if (environment !== 'simulation' && String(env.SARVAM_API_KEY || '').trim() && credentialService) {
        try {
          await credentialService.rotate({ orgId: org.id, connectionId: row.id, providerAccountId: config.workspaceId, environment, credential: String(env.SARVAM_API_KEY).trim() });
          connected = await repository.findConnectionByOrgAndId(org.id, row.id);
        } catch {
          fail(HttpError, 503, 'The server SARVAM_API_KEY could not be stored for this workspace. Check APP_MASTER_KEY and the connection setup.', 'sarvam_credentials_unavailable');
        }
      }
      return sendJson(response, 201, { connection: publicConnection(connected), simulated: environment === 'simulation' && fixtureEnabled });
    }
    const credentialRoute = path.match(/^\/api\/sarvam\/v2\/connections\/([^/]+)\/credentials$/);
    if (credentialRoute && method === 'POST') {
      const connection = await repository.findConnectionByOrgAndId(org.id, credentialRoute[1]);
      if (!connection) fail(HttpError, 404, 'Sarvam connection was not found.', 'sarvam_connection_not_found');
      if (!credentialService) fail(HttpError, 503, 'Encrypted integration credential storage is unavailable on this server.', 'sarvam_credentials_unavailable');
      try {
        await credentialService.rotate({ orgId: org.id, connectionId: connection.id, providerAccountId: connection.provider_account_id, environment: connection.environment, credential: body.apiKey });
      } catch {
        fail(HttpError, 400, 'Sarvam API key could not be stored. Check the value and server encryption setup.', 'sarvam_credentials_invalid');
      }
      const saved = await repository.findConnectionByOrgAndId(org.id, connection.id);
      return sendJson(response, 200, { connection: publicConnection(saved), credentialStored: true });
    }
    const disconnectRoute = path.match(/^\/api\/sarvam\/v2\/connections\/([^/]+)$/);
    if (disconnectRoute && method === 'DELETE') {
      const connection = await repository.findConnectionByOrgAndId(org.id, disconnectRoute[1]);
      if (!connection) fail(HttpError, 404, 'Sarvam connection was not found.', 'sarvam_connection_not_found');
      await repository.disconnectConnection(org.id, connection.id, timestamp());
      return sendJson(response, 200, { ok: true, connectionId: connection.id, status: 'revoked' });
    }
    if (path === '/api/sarvam/v2/sessions' && method === 'POST') {
      if (!fixtureEnabled && !truthy(env.SARVAM_LIVE_ENABLED)) fail(HttpError, 503, 'Sarvam browser voice is disabled until an explicit local fixture or live gate is enabled.', 'sarvam_live_disabled');
      const connection = await repository.findConnectionByOrgAndId(org.id, body.connectionId);
      if (!connection || connection.status !== 'connected' || connection.provider !== 'sarvam') fail(HttpError, 404, 'Connected Sarvam app binding was not found for this workspace.', 'sarvam_connection_not_found');
      const taskId = typeof body.taskId === 'string' && body.taskId.trim() ? body.taskId.trim() : null;
      const task = taskId ? await repository.findTaskByOrgAndId(org.id, taskId) : null;
      const onboarding = await repository.findOnboardingSessionByOrgAndId(org.id, body.onboardingSessionId);
      if ((taskId && (!task || ['completed', 'failed', 'cancelled'].includes(task.state))) || !onboarding || !['collecting', 'validating', 'blueprint_review'].includes(onboarding.state)) {
        fail(HttpError, 404, 'An active Chief onboarding session and, when supplied, an active workspace-owned task are required.', 'voice_session_binding_invalid');
      }
      const isFixture = connection.environment === 'simulation' && connection.config.fixture === true && fixtureEnabled;
      if (connection.environment === 'simulation' && !isFixture) fail(HttpError, 503, 'Simulation connections accept only explicit local fixtures.', 'sarvam_fixture_required');
      if (!isFixture && (!truthy(env.SARVAM_LIVE_ENABLED) || !connection.credential_ready)) fail(HttpError, 503, 'Sarvam connection is not enabled for live browser voice.', 'sarvam_live_disabled');
      if (!consentIsExplicit(body.transcriptConsent)) fail(HttpError, 403, 'Explicit consent is required before retaining or using voice transcript evidence.', 'voice_transcript_consent_required');
      const at = timestamp();
      const sessionId = newId('voice_session');
      const token = randomBytes(32).toString('base64url');
      const appConfig = connection.config;
      const created = await repository.createBrowserVoiceSession({
        id: sessionId, orgId: org.id, connectionId: connection.id, userId: user.id, taskId: task?.id || null, onboardingSessionId: onboarding.id,
        environment: connection.environment, sarvamOrgId: appConfig.sarvamOrgId, workspaceId: appConfig.workspaceId,
        appId: appConfig.appId, appVersion: Number(appConfig.appVersion), appConfig, configHash: digest(JSON.stringify(appConfig)),
        tokenHash: digest(token), transcriptConsent: { capturedAt: at, retentionUntil: new Date(Date.parse(at) + 30 * 24 * 60 * 60 * 1000).toISOString() },
        createdAt: at, expiresAt: new Date(Date.parse(at) + 10 * 60 * 1000).toISOString(),
      });
      return sendJson(response, 201, {
        voiceSessionId: sessionId,
        state: created.state,
        environment: created.environment,
        app: { orgId: created.sarvam_org_id, workspaceId: created.workspace_id, appId: created.app_id, version: created.app_version },
        sdk: { baseUrl: '/api/sarvam-proxy/', apiKey: '' },
        expiresAt: created.expires_at,
        simulated: isFixture,
      }, { 'cache-control': 'no-store', 'set-cookie': cookieHeader(token, request) });
    }
    const sessionRoute = path.match(/^\/api\/sarvam\/v2\/sessions\/([^/]+)$/);
    if (sessionRoute && method === 'GET') {
      const status = await repository.getVoiceSessionStatus(org.id, sessionRoute[1], user.id);
      if (!status) fail(HttpError, 404, 'Voice session was not found.', 'voice_session_not_found');
      return sendJson(response, 200, { ...status, transcriptConsent: Boolean((await repository.findVoiceSessionByOrgAndId(org.id, status.voice_session_id))?.transcript_consent_status === 'granted') });
    }
    if (sessionRoute && method === 'DELETE') {
      const result = await repository.endVoiceSession(org.id, sessionRoute[1], user.id, timestamp());
      if (Number(result?.changes || 0) !== 1) fail(HttpError, 404, 'Active voice session was not found.', 'voice_session_not_found');
      return sendJson(response, 200, { ok: true, voiceSessionId: sessionRoute[1], state: 'ended' }, { 'set-cookie': clearVoiceCookie(request) });
    }
    const transcriptRoute = path.match(/^\/api\/sarvam\/v2\/sessions\/([^/]+)\/transcript$/);
    if (transcriptRoute && method === 'POST') {
      if (!onboardingService) fail(HttpError, 503, 'Onboarding V2 transcript routing is unavailable.', 'onboarding_service_unavailable');
      const session = await repository.findVoiceSessionByOrgAndId(org.id, transcriptRoute[1]);
      if (!session || session.org_id !== org.id || session.user_id !== user.id || session.session_type !== 'browser' || session.state !== 'ended') fail(HttpError, 404, 'A completed browser voice session was not found.', 'voice_session_not_found');
      if (session.transcript_consent_status !== 'granted' || !session.transcript_consent_explicit || session.transcript_retention_until && Date.parse(session.transcript_retention_until) <= Date.parse(timestamp())) {
        fail(HttpError, 403, 'Transcript use is unavailable without current explicit consent.', 'voice_transcript_consent_required');
      }
      const turns = normalizeBrowserTurns(body.turns, HttpError);
      const result = await storeOnboardingTranscript({ orgId: org.id, onboardingSessionId: session.onboarding_session_id, voiceSessionId: session.voice_session_id, turns, HttpError });
      return sendJson(response, 200, result);
    }
    if (path === '/api/sarvam/v2/outbounds' && method === 'POST') {
      return fail(HttpError, 503, 'Outbound dialing is unavailable until a documented callback verifier or trusted private ingress and policy authorizer are configured.', 'voice_callback_verifier_required');
    }
    if (/^\/api\/sarvam\/v2\/(?:tools\/ask-chief|intents|approvals\/[^/]+\/confirm)$/.test(path)) {
      return fail(HttpError, 503, 'Voice tools remain unavailable until a trusted provider-side session capability can be bound to this organization and voice session.', 'voice_tool_binding_unavailable');
    }
    fail(HttpError, 404, 'Sarvam V2 route was not found.', 'route_not_found');
  }

  async function storeOnboardingTranscript({ orgId, onboardingSessionId, voiceSessionId, turns, HttpError: ErrorType }) {
    if (!onboardingSessionId) fail(ErrorType, 409, 'Voice session has no bound onboarding session.', 'voice_session_binding_invalid');
    const state = await onboardingService.get(orgId, onboardingSessionId);
    if (!state) fail(ErrorType, 404, 'Bound onboarding session is not available in this workspace.', 'onboarding_session_not_found');
    const contentHash = digest(JSON.stringify({ orgId, voiceSessionId, onboardingSessionId, turns }));
    const clientTurnId = `sarvam_${contentHash}`;
    const result = await onboardingService.turn({
      orgId,
      sessionId: onboardingSessionId,
      clientTurnId,
      expectedProfileVersion: Number(state.profile.version),
      text: transcriptForOnboarding(turns),
      documentIds: [],
      confirmedClaimIds: [],
    });
    return { source: 'sarvam_voice', clientTurnId, transcriptHash: contentHash, claims: result.claims || [], profileVersion: result.profileVersion ?? state.profile.version, managerConfirmationRequired: true, transcriptRolesPreserved: true };
  }

  async function handleCallback({ path, method, request, response, rawBody }) {
    if (method !== 'POST' || !['/api/webhooks/sarvam/outbound', '/api/local-fixtures/webhooks/sarvam/outbound'].includes(path)) return false;
    if (!Buffer.isBuffer(rawBody)) fail(HttpError, 400, 'Raw callback bytes are required.', 'voice_callback_raw_body_required');
    if (path === '/api/local-fixtures/webhooks/sarvam/outbound' && !fixtureEnabled) fail(HttpError, 404, 'Local Sarvam callback fixtures are disabled.', 'voice_fixture_disabled');
    if (path === '/api/webhooks/sarvam/outbound') {
      // Public provider callbacks do not have a documented Sarvam signature contract.
      // `processCallback` rejects here before parsing because no live verifier is injected.
      const result = await callbackService.processCallback({ headers: request.headers, rawBody });
      return sendJson(response, result.duplicate ? 200 : 202, result, { 'cache-control': 'no-store' });
    }
    const result = await fixtureCallbackService.processCallback({ headers: request.headers, rawBody });
    if (!result.duplicate && result.transcriptRetained && onboardingService) {
      const payload = JSON.parse(rawBody.toString('utf8')); // processCallback verified these exact bytes before returning.
      const normalized = normalizeSarvamCallback(payload, { retainTranscript: false });
      const attempt = await repository.findOutboundByAttemptId(normalized.attemptId);
      const session = attempt ? await repository.findVoiceSessionByOrgAndId(attempt.org_id, attempt.voice_session_id) : null;
      const turns = await repository.findVoiceCallbackTranscript(attempt?.org_id, attempt?.voice_session_id, normalized.callbackId, timestamp());
      if (turns?.length && session?.onboarding_session_id) {
        try { await storeOnboardingTranscript({ orgId: attempt.org_id, onboardingSessionId: session.onboarding_session_id, voiceSessionId: session.voice_session_id, turns, HttpError }); }
        catch { /* Callback transport status is durable even when onboarding needs a manager refresh. */ }
      }
    }
    return sendJson(response, result.duplicate ? 200 : 202, { ...result, simulated: true }, { 'cache-control': 'no-store' });
  }

  return Object.freeze({ handleAuthenticated, handleCallback, readiness: () => Object.freeze({ ...capabilityStatus({ id: '' }), outboundEnabled: callbackService.readiness.outboundEnabled, callbackVerifierInjected: callbackService.readiness.callbackVerifierInjected }) });
}

function defaultParseCookie(header, cookieName) {
  const pair = String(header || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`));
  if (!pair) return null;
  try { return decodeURIComponent(pair.slice(cookieName.length + 1)); } catch { return null; }
}
