import { createHash, randomUUID } from 'node:crypto';
import { SarvamVoiceError, normalizeSarvamCallback, sarvamLogRecord, validateSarvamE164 } from '../integrations/sarvam-voice.mjs';

const INTENTS = new Set(['approve', 'reject', 'more_information', 'unclear']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MAX_CALLBACK_BYTES = 1024 * 1024;

function fail(message, code = 'voice_request_invalid', status = 400) { throw new SarvamVoiceError(message, code, status); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function id(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail(`${label} is missing or invalid.`, 'voice_binding_invalid');
  return value;
}
function iso(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function sha256(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function method(target, name) { return target && typeof target[name] === 'function'; }
function safeReason(error) { return String(error?.code || 'provider_error').slice(0, 80); }

function approvalBinding(approval) {
  const result = {
    approvalId: approval?.id,
    orgId: approval?.org_id,
    taskId: approval?.task_id,
    actionHash: approval?.action_hash,
    managerUserId: approval?.manager_user_id,
    expiresAt: approval?.expires_at,
    nonce: approval?.nonce,
    policyRevision: approval?.policy_revision,
    allowedDecision: approval?.allowed_decision,
    state: approval?.state,
  };
  for (const [key, value] of Object.entries(result)) {
    if (typeof value !== 'string' || !value) fail(`Pending approval is missing immutable field ${key}.`, 'voice_approval_invalid', 409);
  }
  if (result.state !== 'pending' || !iso(result.expiresAt)) fail('Pending approval is expired or no longer awaiting a decision.', 'voice_approval_stale', 409);
  return Object.freeze(result);
}

function ensureRepository(repository) {
  const required = [
    'findOutboundByIdempotency', 'findLatestOutboundForRecipient', 'reserveOutbound', 'markOutboundDialing',
    'markOutboundAccepted', 'markOutboundReconciliationRequired', 'findOutboundByAttemptId',
    'claimSarvamCallback', 'recordSarvamOutcome', 'findVoiceSessionByOrgAndId',
    'findPendingVoiceApproval', 'recordVoiceIntent', 'findVoiceIntentByIdempotency',
    'findLatestVoiceIntentForApproval', 'consumePendingApproval',
  ];
  const missing = required.filter(name => !method(repository, name));
  if (missing.length) fail(`Sarvam repository is missing required persistence hooks: ${missing.join(', ')}.`, 'voice_repository_unavailable', 503);
}

/**
 * Service boundary for voice call scheduling, callback persistence, proposal capture,
 * and manager confirmation. Repository methods must enforce org-scoped uniqueness/CAS.
 * No provider call is enabled unless liveEnabled or fixtureEnabled is explicitly true.
 */
export function createSarvamVoiceSessionService({
  repository,
  provider,
  authorizer,
  verifyCallback,
  transaction,
  lockOrganization,
  liveEnabled = false,
  fixtureEnabled = false,
  newId = prefix => `${prefix}-${randomUUID()}`,
  timestamp = () => new Date().toISOString(),
  logger = () => {},
}) {
  ensureRepository(repository);
  if (!method(authorizer, 'authorizeOutbound') || !method(authorizer, 'authorizeVoiceIntent') || !method(authorizer, 'authorizeManagerConfirmation')) fail('Explicit outbound, voice-intent, and manager authorization interfaces are required.', 'voice_authorization_unavailable', 503);
  if (typeof logger !== 'function' || typeof timestamp !== 'function' || typeof newId !== 'function') fail('Voice service clock, ID generator, and logger must be injected functions.', 'voice_configuration_invalid', 503);
  if (typeof liveEnabled !== 'boolean' || typeof fixtureEnabled !== 'boolean') fail('Voice enablement flags must be explicit booleans.', 'voice_configuration_invalid', 503);

  const callbackReady = typeof verifyCallback === 'function';
  const providerEnabled = provider?.mode === 'live'
    ? liveEnabled && callbackReady && typeof transaction === 'function' && typeof lockOrganization === 'function'
    : provider?.mode === 'fixture' ? fixtureEnabled : false;
  const emitLog = record => { try { logger(record); } catch { /* Logging must not change provider or approval state. */ } };

  async function authorizeBinding(input) {
    const binding = input.binding;
    if (!object(binding) || binding.orgId !== input.orgId) fail('Sarvam app binding does not belong to the requested CrewOS organization.', 'voice_tenant_mismatch', 403);
    const result = await authorizer.authorizeOutbound({
      orgId: input.orgId, taskId: input.taskId, actorId: input.actorId,
      sarvamOrgId: binding.sarvamOrgId, sarvamWorkspaceId: binding.sarvamWorkspaceId,
      appId: binding.appId, appVersion: binding.appVersion, connectionId: binding.connectionId,
    });
    if (!object(result) || result.allowed !== true || result.orgId !== input.orgId ||
        result.sarvamOrgId !== binding.sarvamOrgId || result.sarvamWorkspaceId !== binding.sarvamWorkspaceId ||
        result.appId !== binding.appId || result.connectionId !== binding.connectionId) {
      fail('Current organization, workspace, app, task, or actor authorization does not match the call.', 'voice_authorization_denied', 403);
    }
  }

  return Object.freeze({
    get readiness() {
      return Object.freeze({ outboundEnabled: providerEnabled, callbackVerifierInjected: callbackReady, providerMode: provider?.mode || 'none' });
    },

    async requestOutbound(input) {
      if (!providerEnabled || !provider || typeof provider.createOutbound !== 'function') fail('Sarvam outbound calling is disabled until an explicit provider and enablement gate are configured.', 'voice_outbound_disabled', 503);
      if (!object(input)) fail('Outbound call request is required.');
      const orgId = id(input.orgId, 'Organization ID');
      const taskId = id(input.taskId, 'Task ID');
      const actorId = id(input.actorId, 'Authenticated actor ID');
      const incidentId = id(input.incidentId, 'Incident ID');
      const voiceSessionId = id(input.voiceSessionId || newId('voice'), 'Voice session ID');
      const idempotencyKey = id(input.idempotencyKey, 'Outbound idempotency key');
      const policyVersion = id(input.policyVersion, 'Alert policy version');
      const approvalId = input.approvalId ? id(input.approvalId, 'Approval ID') : null;
      const allowedRisk = new Set(['low', 'medium', 'high', 'critical']);
      if (!allowedRisk.has(input.risk) || !allowedRisk.has(input.severity)) fail('Outbound risk and severity must use supported policy values.', 'voice_risk_invalid');
      if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1_000) fail('A bounded call reason is required.', 'voice_reason_invalid');
      if (typeof input.recipientPreference !== 'string' || !input.recipientPreference.trim() || input.recipientPreference.length > 160) fail('A resolved recipient preference is required.', 'voice_recipient_invalid');
      validateSarvamE164(input.recipientPhone);
      if (!object(input.consent) || input.consent.status !== 'granted' || input.consent.explicit !== true ||
          typeof input.consent.purpose !== 'string' || !input.consent.purpose.trim() || input.consent.recipientPhone !== input.recipientPhone || !iso(input.consent.capturedAt) || Date.parse(input.consent.capturedAt) > Date.parse(timestamp())) {
        fail('Explicit, current consent for this exact recipient is required before an outbound call.', 'voice_consent_required', 403);
      }
      const cooldownMs = Number(input.cooldownMs);
      if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 1_000 || cooldownMs > 30 * 24 * 60 * 60 * 1000) fail('An explicit cooldown from 1 second to 30 days is required.', 'voice_cooldown_invalid');
      await authorizeBinding({ ...input, orgId, taskId, actorId });

      const requestHash = sha256({ orgId, taskId, incidentId, recipientPreference: input.recipientPreference.trim(), recipientPhone: input.recipientPhone, severity: input.severity, risk: input.risk, reason: input.reason.trim(), policyVersion, approvalId, binding: input.binding, consent: input.consent });
      const prior = await repository.findOutboundByIdempotency(orgId, idempotencyKey);
      if (prior) {
        if (prior.org_id !== orgId || prior.request_hash !== requestHash) fail('Outbound idempotency key is already bound to a different request.', 'voice_idempotency_conflict', 409);
        return Object.freeze({ duplicate: true, state: prior.state, attemptId: prior.attempt_id || null, voiceSessionId: prior.voice_session_id });
      }

      const at = timestamp();
      const recent = await repository.findLatestOutboundForRecipient(orgId, input.recipientPhone, new Date(Date.parse(at) - cooldownMs).toISOString());
      if (recent && recent.org_id === orgId && Number.isFinite(Date.parse(recent.created_at)) && Date.parse(recent.created_at) > Date.parse(at) - cooldownMs) {
        fail('A recent outbound call is inside the recipient cooldown window.', 'voice_cooldown_active', 429);
      }

      const transcriptConsent = object(input.transcriptConsent) && input.transcriptConsent.status === 'granted' && input.transcriptConsent.explicit === true &&
        input.transcriptConsent.recipientPhone === input.recipientPhone && iso(input.transcriptConsent.capturedAt) && Date.parse(input.transcriptConsent.capturedAt) <= Date.parse(at)
        ? Object.freeze({ status: 'granted', explicit: true, recipientPhone: input.recipientPhone, capturedAt: input.transcriptConsent.capturedAt }) : null;
      const record = Object.freeze({
        orgId, voiceSessionId, taskId, incidentId, actorId, recipientPhone: input.recipientPhone,
        recipientPreference: input.recipientPreference.trim(), risk: String(input.risk || '').slice(0, 32),
        severity: input.severity, reason: input.reason.trim().slice(0, 1_000), approvalId,
        policyVersion, idempotencyKey, requestHash, state: 'queued', createdAt: at,
        binding: Object.freeze({ orgId, sarvamOrgId: input.binding.sarvamOrgId, sarvamWorkspaceId: input.binding.sarvamWorkspaceId, appId: input.binding.appId, appVersion: input.binding.appVersion, connectionId: input.binding.connectionId }),
        consent: Object.freeze({ status: 'granted', explicit: true, purpose: input.consent.purpose.slice(0, 240), capturedAt: input.consent.capturedAt }),
        transcriptConsent,
      });
      // Must atomically enforce org/idempotency uniqueness and cooldown against concurrent workers.
      const reserved = await repository.reserveOutbound({ orgId, idempotencyKey, requestHash, cooldownSince: new Date(Date.parse(at) - cooldownMs).toISOString(), record });
      const saved = reserved?.record;
      if (!saved || saved.org_id !== orgId || saved.request_hash !== requestHash) fail('Outbound request could not be reserved with the exact organization and request binding.', 'voice_reservation_conflict', 409);
      if (reserved.created !== true) return Object.freeze({ duplicate: true, state: saved.state, attemptId: saved.attempt_id || null, voiceSessionId: saved.voice_session_id });

      const claim = await repository.markOutboundDialing(orgId, saved.voice_session_id, timestamp());
      if (!claim || claim.changes !== 1 || claim.org_id !== orgId || claim.voice_session_id !== saved.voice_session_id || claim.state !== 'dialing') {
        fail('Outbound dispatch claim was lost; no provider call was made.', 'voice_dispatch_claim_lost', 409);
      }
      try {
        const accepted = await provider.createOutbound({
          binding: { ...input.binding, orgId }, recipientPhone: input.recipientPhone, consent: input.consent,
          metadata: { voiceSessionId, taskId, ...(approvalId ? { approvalId } : {}) }, at,
        });
        if (accepted?.accepted !== true || accepted.status !== 'dialing' || accepted.orgId !== orgId || typeof accepted.attemptId !== 'string') fail('Provider acceptance did not preserve the request binding.', 'voice_provider_response_invalid', 502);
        const updated = await repository.markOutboundAccepted(orgId, voiceSessionId, accepted.attemptId, timestamp());
        if (!updated || updated.org_id !== orgId || updated.attempt_id !== accepted.attemptId || updated.state !== 'dialing') fail('Accepted outbound attempt could not be recorded under its organization as dialing.', 'voice_persistence_failed', 500);
        emitLog(sarvamLogRecord('voice.outbound.accepted', { orgId, voiceSessionId, attemptId: accepted.attemptId }));
        return Object.freeze({ duplicate: false, accepted: true, state: 'dialing', attemptId: accepted.attemptId, voiceSessionId });
      } catch (error) {
        await repository.markOutboundReconciliationRequired(orgId, voiceSessionId, safeReason(error), timestamp()).catch(() => {});
        emitLog(sarvamLogRecord('voice.outbound.reconciliation_required', { orgId, voiceSessionId, code: safeReason(error) }));
        throw error;
      }
    },

    async processCallback({ headers, rawBody }) {
      if (!callbackReady) fail('Sarvam callbacks are rejected until a provider authenticity verifier is injected.', 'voice_callback_verifier_required', 503);
      if (!Buffer.isBuffer(rawBody) || rawBody.length > MAX_CALLBACK_BYTES) fail('Sarvam callback body is missing or exceeds 1 MiB.', 'voice_callback_size_invalid', 413);
      let verified = false;
      try { verified = await verifyCallback({ headers, rawBody }) === true; }
      catch { verified = false; }
      if (!verified) fail('Sarvam callback authenticity could not be verified.', 'voice_callback_unverified', 401);
      if (typeof transaction !== 'function') fail('Callback inbox claim and outcome persistence require one database transaction.', 'voice_callback_persistence_unavailable', 503);
      let signedPayload;
      try { signedPayload = JSON.parse(rawBody.toString('utf8')); }
      catch { fail('Verified Sarvam callback body is not valid JSON.', 'voice_callback_invalid'); }
      return transaction(async () => {
        // Always normalize the signed bytes, not a separately supplied parsed object.
        const normalized = normalizeSarvamCallback(signedPayload, { retainTranscript: false });
        const row = await repository.findOutboundByAttemptId(normalized.attemptId);
        if (!row || !row.org_id || row.attempt_id !== normalized.attemptId || row.voice_session_id !== normalized.metadata.voiceSessionId || row.task_id !== normalized.metadata.taskId) {
          fail('Sarvam callback does not match a stored organization-owned attempt and session.', 'voice_callback_binding_mismatch', 403);
        }
        const at = timestamp();
        const retainTranscript = row.transcript_consent_status === 'granted' && (row.transcript_consent_explicit === true || row.transcript_consent_explicit === 1) &&
          row.transcript_consent_recipient_phone === row.recipient_phone && iso(row.transcript_consent_captured_at) &&
          Date.parse(row.transcript_consent_captured_at) <= Date.parse(at);
        const outcome = normalizeSarvamCallback(signedPayload, { retainTranscript });
        const claim = await repository.claimSarvamCallback({ orgId: row.org_id, attemptId: outcome.attemptId, callbackId: outcome.callbackId, interactionId: outcome.interactionId, status: outcome.status, receivedAt: at });
        if (!claim || claim.org_id !== row.org_id) fail('Callback inbox rejected the organization binding.', 'voice_callback_binding_mismatch', 403);
        if (claim.duplicate === true) return Object.freeze({ duplicate: true, status: outcome.status, voiceSessionId: row.voice_session_id });
        const persisted = await repository.recordSarvamOutcome({
          orgId: row.org_id, voiceSessionId: row.voice_session_id, attemptId: outcome.attemptId,
          callbackId: outcome.callbackId, interactionId: outcome.interactionId, status: outcome.status,
          transcript: outcome.transcript, transcriptOmitted: outcome.transcriptOmitted,
          transcriptMalformedTurns: outcome.transcriptMalformedTurns, transcriptTruncated: outcome.transcriptTruncated,
          transcriptConsentApplied: retainTranscript, receivedAt: at,
        });
        if (!persisted || persisted.org_id !== row.org_id || persisted.voice_session_id !== row.voice_session_id) fail('Callback outcome could not be recorded under its organization.', 'voice_persistence_failed', 500);
        emitLog(sarvamLogRecord('voice.callback.recorded', { orgId: row.org_id, voiceSessionId: row.voice_session_id, attemptId: outcome.attemptId, status: outcome.status }));
        // This records transport outcome only. It does not resume a task or execute an action.
        return Object.freeze({ duplicate: false, status: outcome.status, voiceSessionId: row.voice_session_id, transcriptRetained: outcome.transcript !== null });
      });
    },

    async submitVoiceIntent(input) {
      if (!object(input)) fail('Voice decision intent is required.');
      const orgId = id(input.orgId, 'Organization ID');
      const voiceSessionId = id(input.voiceSessionId, 'Voice session ID');
      const approvalId = id(input.approvalId, 'Approval ID');
      const idempotencyKey = id(input.idempotencyKey, 'Intent idempotency key');
      if (!INTENTS.has(input.intent)) fail('Voice intent must be approve, reject, more_information, or unclear.', 'voice_intent_invalid');
      const voiceAuth = await authorizer.authorizeVoiceIntent({ orgId, voiceSessionId, approvalId });
      if (!object(voiceAuth) || voiceAuth.allowed !== true || voiceAuth.orgId !== orgId || voiceAuth.voiceSessionId !== voiceSessionId || voiceAuth.approvalId !== approvalId) {
        fail('Voice tool caller is not authorized for this exact organization, session, and approval.', 'voice_intent_unauthorized', 403);
      }
      const session = await repository.findVoiceSessionByOrgAndId(orgId, voiceSessionId);
      const approval = await repository.findPendingVoiceApproval(orgId, approvalId);
      if (!session || session.org_id !== orgId || session.task_id !== approval?.task_id || session.approval_id !== approvalId) fail('Voice session and approval do not share the same organization, task, and approval binding.', 'voice_approval_binding_mismatch', 403);
      const binding = approvalBinding(approval);
      if (binding.orgId !== orgId || Date.parse(binding.expiresAt) <= Date.parse(timestamp())) fail('Pending approval has expired or belongs to a different organization.', 'voice_approval_stale', 409);
      if (input.intent === 'approve' && binding.allowedDecision !== 'approve') fail('This pending approval does not allow an approval intent.', 'voice_decision_not_allowed', 409);
      const requestHash = sha256({ orgId, voiceSessionId, binding, intent: input.intent, transcriptRef: typeof input.transcriptRef === 'string' ? input.transcriptRef.slice(0, 160) : null });
      const prior = await repository.findVoiceIntentByIdempotency(orgId, idempotencyKey);
      if (prior) {
        if (prior.request_hash !== requestHash || prior.org_id !== orgId || prior.approval_id !== approvalId) fail('Voice intent idempotency key is bound to a different pending approval or intent.', 'voice_idempotency_conflict', 409);
        return Object.freeze({ duplicate: true, intent: prior.intent, approvalId, proposalOnly: true });
      }
      const result = await repository.recordVoiceIntent({
        id: newId('voice-intent'), orgId, voiceSessionId, approvalId, taskId: binding.taskId,
        intent: input.intent, intentHash: sha256(binding), binding, requestHash,
        transcriptRef: typeof input.transcriptRef === 'string' ? input.transcriptRef.slice(0, 160) : null,
        idempotencyKey, createdAt: timestamp(), proposalOnly: true,
      });
      if (!result || result.org_id !== orgId || result.approval_id !== approvalId) fail('Voice intent could not be durably bound to its pending approval.', 'voice_persistence_failed', 500);
      // An 'approve' utterance remains a proposal. This method cannot consume approval or dispatch work.
      return Object.freeze({ duplicate: false, intent: input.intent, approvalId, proposalOnly: true });
    },

    async confirmManagerApproval(input) {
      if (!object(input)) fail('Authenticated manager confirmation is required.');
      const orgId = id(input.orgId, 'Organization ID');
      const voiceSessionId = id(input.voiceSessionId, 'Voice session ID');
      const approvalId = id(input.approvalId, 'Approval ID');
      const userId = id(input.authenticatedUserId, 'Authenticated manager ID');
      if (input.decision !== 'approve') fail('Only an explicit authenticated manager approval can consume this pending approval.', 'voice_manager_confirmation_required', 403);
      if (typeof transaction !== 'function' || typeof lockOrganization !== 'function') fail('Manager confirmation requires transaction-backed organization fencing.', 'voice_confirmation_unavailable', 503);
      if (!await authorizer.authorizeManagerConfirmation({ orgId, userId, approvalId, voiceSessionId })) fail('Authenticated user is not currently authorized to confirm this approval.', 'voice_manager_unauthorized', 403);
      return transaction(async () => {
        if (!await lockOrganization(orgId)) fail('Approval organization is unavailable.', 'voice_tenant_mismatch', 403);
        const session = await repository.findVoiceSessionByOrgAndId(orgId, voiceSessionId);
        const approval = await repository.findPendingVoiceApproval(orgId, approvalId);
        if (!session || session.org_id !== orgId || session.task_id !== approval?.task_id || session.approval_id !== approvalId) fail('Voice session and pending approval binding changed.', 'voice_approval_binding_mismatch', 409);
        const binding = approvalBinding(approval);
        if (binding.orgId !== orgId || binding.allowedDecision !== 'approve') fail('Approval belongs to another organization or disallows approval.', 'voice_approval_binding_mismatch', 403);
        if (Date.parse(binding.expiresAt) <= Date.parse(timestamp())) fail('Pending approval has expired.', 'voice_approval_stale', 409);
        if (binding.managerUserId !== userId) fail('Approval is assigned to a different manager.', 'voice_manager_unauthorized', 403);
        const intent = await repository.findLatestVoiceIntentForApproval(orgId, voiceSessionId, approvalId);
        if (!intent || intent.org_id !== orgId || intent.approval_id !== approvalId || intent.voice_session_id !== voiceSessionId || intent.intent !== 'approve' || intent.intent_hash !== sha256(binding)) {
          fail('There is no current approve proposal bound to this exact immutable approval.', 'voice_intent_missing', 409);
        }
        // Recheck current manager role/grants inside the same transaction as the one-time CAS.
        if (!await authorizer.authorizeManagerConfirmation({ orgId, userId, approvalId, voiceSessionId, binding })) fail('Manager authorization changed before approval consumption.', 'voice_manager_unauthorized', 403);
        const consumed = await repository.consumePendingApproval({ orgId, approvalId, userId, voiceSessionId, expectedBinding: binding, consumedAt: timestamp() });
        if (!consumed || consumed.changes !== 1 || consumed.org_id && consumed.org_id !== orgId) fail('Approval is stale, replayed, or no longer matches its immutable binding.', 'voice_approval_replay', 409);
        emitLog(sarvamLogRecord('voice.approval.manager_confirmed', { orgId, voiceSessionId, status: 'consumed' }));
        // Consumption authorizes the existing action workflow; this service never executes the action.
        return Object.freeze({ consumed: true, approvalId, voiceSessionId, actionHash: binding.actionHash });
      });
    },
  });
}
