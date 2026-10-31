import { createHash } from 'node:crypto';

export const SARVAM_OUTBOUND_ORIGIN = 'https://apps.sarvam.ai';
export const SARVAM_OUTBOUND_STATUSES = Object.freeze(['connected', 'no_answer', 'busy', 'failed']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const E164_PATTERN = /^\+[1-9][0-9]{7,14}$/;
const MAX_TRANSCRIPT_TURNS = 100;
const MAX_TRANSCRIPT_CHARS = 20_000;
const MAX_TRANSCRIPT_BYTES = 40_000;

export class SarvamVoiceError extends Error {
  constructor(message, code = 'sarvam_voice_invalid', status = 400) {
    super(message);
    this.name = 'SarvamVoiceError';
    this.code = code;
    this.status = status;
  }
}

function fail(message, code, status) { throw new SarvamVoiceError(message, code, status); }
function plainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function requiredId(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail(`${label} is missing or invalid.`, 'sarvam_binding_invalid');
  return value;
}

export function validateSarvamE164(phone) {
  if (typeof phone !== 'string' || !E164_PATTERN.test(phone)) fail('Recipient phone must be a valid E.164 number.', 'sarvam_phone_invalid');
  return phone;
}

function validateConsent(consent, recipientPhone, at) {
  if (!plainObject(consent) || consent.status !== 'granted' || consent.explicit !== true ||
      typeof consent.purpose !== 'string' || !consent.purpose.trim() || consent.recipientPhone !== recipientPhone ||
      typeof consent.capturedAt !== 'string' || !Number.isFinite(Date.parse(at)) ||
      !Number.isFinite(Date.parse(consent.capturedAt)) || Date.parse(consent.capturedAt) > Date.parse(at)) {
    fail('A current, explicit, recipient-bound outbound consent record is required.', 'sarvam_consent_required', 403);
  }
  return Object.freeze({ status: 'granted', explicit: true, purpose: consent.purpose.trim().slice(0, 240), recipientPhone, capturedAt: consent.capturedAt });
}

function safeMetadata(metadata) {
  if (!plainObject(metadata)) fail('Callback metadata is required for outbound correlation.', 'sarvam_binding_invalid');
  const allowed = ['voiceSessionId', 'taskId', 'approvalId'];
  const result = {};
  for (const key of allowed) {
    if (metadata[key] !== undefined) result[key] = requiredId(metadata[key], key);
  }
  if (!result.voiceSessionId || !result.taskId) fail('Callback metadata must bind a voice session and task.', 'sarvam_binding_invalid');
  return result;
}

/** Build only the documented, allowlisted Sarvam outbound request shape. */
export function buildSarvamOutboundRequest({ binding, recipientPhone, consent, metadata, webhookUrl, at = new Date().toISOString() }) {
  if (!plainObject(binding)) fail('Sarvam organization, workspace, and app binding are required.', 'sarvam_binding_invalid');
  const orgId = requiredId(binding.orgId, 'CrewOS organization');
  const sarvamOrgId = requiredId(binding.sarvamOrgId, 'Sarvam organization');
  const sarvamWorkspaceId = requiredId(binding.sarvamWorkspaceId, 'Sarvam workspace');
  const appId = requiredId(binding.appId, 'Sarvam app');
  const connectionId = requiredId(binding.connectionId, 'Sarvam telephony connection');
  const appVersion = Number(binding.appVersion);
  if (!Number.isSafeInteger(appVersion) || appVersion < 1) fail('A pinned positive Sarvam app version is required.', 'sarvam_binding_invalid');
  const phone = validateSarvamE164(recipientPhone);
  const acceptedConsent = validateConsent(consent, phone, at);
  const callbackMetadata = safeMetadata(metadata);
  let callback;
  try { callback = new URL(webhookUrl); } catch { fail('Sarvam callback URL must be an absolute HTTPS URL.', 'sarvam_webhook_url_invalid'); }
  if (callback.protocol !== 'https:' || callback.username || callback.password || callback.hash) fail('Sarvam callback URL must be an absolute HTTPS URL without credentials or fragments.', 'sarvam_webhook_url_invalid');
  const agentPhoneNumber = validateSarvamE164(binding.agentPhoneNumber);
  return Object.freeze({
    binding: Object.freeze({ orgId, sarvamOrgId, sarvamWorkspaceId, appId, appVersion, connectionId, agentPhoneNumber }),
    consent: acceptedConsent,
    url: `${SARVAM_OUTBOUND_ORIGIN}/api/outbounds/v1/orgs/${encodeURIComponent(sarvamOrgId)}/workspaces/${encodeURIComponent(sarvamWorkspaceId)}/outbounds`,
    method: 'POST',
    body: Object.freeze({
      app_config: Object.freeze({
        app_id: appId,
        app_version: appVersion,
        connection_config: Object.freeze({ connection_id: connectionId, agent_phone_number: agentPhoneNumber }),
      }),
      user_config: Object.freeze({ user_phone_number: phone }),
      webhook_config: Object.freeze({ url: callback.toString(), metadata: Object.freeze(callbackMetadata) }),
    }),
  });
}

function responseBody(response) {
  if (!plainObject(response)) return null;
  if (plainObject(response.data)) return response.data;
  if (plainObject(response.body)) return response.body;
  return response;
}

/** Normalize Sarvam acceptance as queued/dialing; an attempt_id is not a connected call. */
export function normalizeSarvamAcceptedResponse(response) {
  const data = responseBody(response);
  const attemptId = data?.attempt_id;
  if (typeof attemptId !== 'string' || !ID_PATTERN.test(attemptId)) fail('Sarvam did not return a valid accepted attempt identifier.', 'sarvam_response_invalid', 502);
  const status = Number(response.status ?? response.statusCode ?? 200);
  if (!Number.isFinite(status) || status < 200 || status >= 300) fail('Sarvam did not accept the outbound call.', 'sarvam_provider_rejected', 502);
  return Object.freeze({ accepted: true, status: 'dialing', attemptId });
}

/** Normalize documented callback fields. Transcript data is omitted unless retention consent is explicit. */
export function normalizeSarvamCallback(payload, { retainTranscript = false } = {}) {
  if (!plainObject(payload)) fail('Sarvam callback payload must be a JSON object.', 'sarvam_callback_invalid');
  const status = String(payload.status || '').toLowerCase();
  if (!SARVAM_OUTBOUND_STATUSES.includes(status)) fail('Sarvam callback status is not documented or supported.', 'sarvam_callback_status_invalid');
  const attemptId = requiredId(payload.attempt_id, 'Sarvam attempt ID');
  const interactionId = payload.interaction_id == null ? null : requiredId(payload.interaction_id, 'Sarvam interaction ID');
  const metadata = safeMetadata(payload.webhook_config?.metadata);
  const rawTranscript = payload.interaction_transcript;
  const transcriptPresent = rawTranscript !== null && rawTranscript !== undefined;
  let transcript = null;
  let transcriptMalformedTurns = 0;
  let transcriptTruncated = false;
  if (retainTranscript && transcriptPresent && Array.isArray(rawTranscript)) {
    transcript = [];
    let chars = 0;
    let bytes = 0;
    if (rawTranscript.length > MAX_TRANSCRIPT_TURNS) transcriptTruncated = true;
    for (const turn of rawTranscript.slice(0, MAX_TRANSCRIPT_TURNS)) {
      if (!plainObject(turn) || !['agent', 'user'].includes(turn.role) || typeof turn.en_text !== 'string') {
        transcriptMalformedTurns += 1;
        continue;
      }
      let text = '';
      let turnChars = 0;
      let turnBytes = 0;
      for (const character of turn.en_text) {
        const charCount = character.length;
        const byteCount = Buffer.byteLength(character, 'utf8');
        if (chars + turnChars + charCount > MAX_TRANSCRIPT_CHARS || bytes + turnBytes + byteCount > MAX_TRANSCRIPT_BYTES) {
          transcriptTruncated = true;
          break;
        }
        text += character;
        turnChars += charCount;
        turnBytes += byteCount;
      }
      if (text.length !== turn.en_text.length) transcriptTruncated = true;
      transcript.push(Object.freeze({ role: turn.role, en_text: text }));
      chars += turnChars;
      bytes += turnBytes;
      if (transcriptTruncated && (chars >= MAX_TRANSCRIPT_CHARS || bytes >= MAX_TRANSCRIPT_BYTES)) break;
    }
  } else if (retainTranscript && transcriptPresent) {
    transcriptMalformedTurns = 1;
  }
  return Object.freeze({
    status,
    attemptId,
    interactionId,
    metadata: Object.freeze(metadata),
    transcript,
    transcriptOmitted: transcriptPresent && transcript === null,
    transcriptMalformedTurns,
    transcriptTruncated,
    callbackId: createHash('sha256').update(`${attemptId}\0${interactionId || ''}\0${status}`).digest('hex'),
  });
}

/** Bounded, allowlisted log fields; no phone, transcript, API key, request body, or provider payload. */
export function sarvamLogRecord(event, { orgId, voiceSessionId, attemptId, status, code } = {}) {
  const fields = { event: String(event || 'voice.event').slice(0, 80) };
  for (const [key, value] of Object.entries({ orgId, voiceSessionId, attemptId, status, code })) {
    if (typeof value === 'string' && value.length <= 160) fields[key] = value;
  }
  return Object.freeze(fields);
}

/** Explicit adapter for production wiring. It is never constructed or called implicitly. */
export function createSarvamFetchTransport({ fetchImpl, timeoutMs = 15_000 } = {}) {
  if (typeof fetchImpl !== 'function') fail('An explicit fetch implementation is required for live Sarvam transport.', 'sarvam_transport_unavailable', 503);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) fail('Sarvam request timeout must be between 1 and 60 seconds.', 'sarvam_transport_invalid');
  return Object.freeze({
    mode: 'live',
    async post(url, { headers, body }) {
      if (!String(url).startsWith(`${SARVAM_OUTBOUND_ORIGIN}/api/outbounds/v1/orgs/`)) fail('Sarvam transport URL is outside the outbound API allowlist.', 'sarvam_url_blocked', 403);
      const response = await fetchImpl(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers,
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) return { status: response.status, data };
      return { status: response.status, data };
    },
  });
}

/** Local deterministic fixture transport; it never performs network I/O. */
export function createSarvamFixtureTransport({ response = SARVAM_FIXTURES.accepted } = {}) {
  const calls = [];
  return Object.freeze({
    mode: 'fixture',
    calls,
    async post(url, request) {
      if (!String(url).startsWith(`${SARVAM_OUTBOUND_ORIGIN}/api/outbounds/v1/orgs/`)) fail('Fixture rejected an unexpected provider URL.', 'sarvam_url_blocked', 403);
      const headers = { ...request.headers };
      if (headers['X-API-Key']) headers['X-API-Key'] = '[redacted]';
      calls.push(Object.freeze({ url, headers: Object.freeze(headers), body: structuredClone(request.body) }));
      return structuredClone(response);
    },
  });
}

export const SARVAM_FIXTURES = Object.freeze({
  accepted: Object.freeze({ status: 202, data: Object.freeze({ attempt_id: 'fixture-attempt-001' }) }),
  connected: Object.freeze({
    status: 'connected', attempt_id: 'fixture-attempt-001', interaction_id: 'fixture-interaction-001',
    interaction_transcript: Object.freeze([
      Object.freeze({ role: 'agent', en_text: 'Fixture greeting; never a real call.' }),
      Object.freeze({ role: 'user', en_text: 'Fixture response.' }),
    ]),
    webhook_config: Object.freeze({ metadata: Object.freeze({ voiceSessionId: 'fixture-voice-session', taskId: 'fixture-task' }) }),
  }),
  noAnswer: Object.freeze({
    status: 'no_answer', attempt_id: 'fixture-attempt-001', interaction_id: 'fixture-interaction-001',
    webhook_config: Object.freeze({ metadata: Object.freeze({ voiceSessionId: 'fixture-voice-session', taskId: 'fixture-task' }) }),
  }),
});

/** Provider adapter with explicit credentials and transport; there is no network default. */
export function createSarvamOutboundProvider({ transport, apiKey, webhookUrl } = {}) {
  if (!transport || typeof transport.post !== 'function' || !['live', 'fixture'].includes(transport.mode)) fail('An explicit live or fixture Sarvam transport is required.', 'sarvam_transport_unavailable', 503);
  if (transport.mode === 'live' && (typeof apiKey !== 'string' || apiKey.length < 8 || apiKey.length > 4_096)) fail('A server-injected Sarvam API key is required.', 'sarvam_credentials_missing', 503);
  if (typeof webhookUrl !== 'string') fail('An explicit Sarvam callback URL is required.', 'sarvam_webhook_url_invalid', 503);
  return Object.freeze({
    mode: transport.mode,
    async createOutbound({ binding, recipientPhone, consent, metadata, at }) {
      const request = buildSarvamOutboundRequest({ binding, recipientPhone, consent, metadata, webhookUrl, at });
      const response = await transport.post(request.url, {
        headers: Object.freeze({ ...(transport.mode === 'live' ? { 'X-API-Key': apiKey } : {}), 'Content-Type': 'application/json', Accept: 'application/json' }),
        body: request.body,
      });
      return Object.freeze({ ...normalizeSarvamAcceptedResponse(response), orgId: request.binding.orgId, consent: request.consent });
    },
  });
}
