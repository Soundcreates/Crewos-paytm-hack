import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(String(value)).digest('hex');
const recipientDigest = (orgId, phone) => digest(`${orgId}\0${phone}`);
const parseJson = (value, fallback = {}) => { try { return JSON.parse(value || '{}'); } catch { return fallback; } };
const changes = result => Number(result?.changes ?? result?.rowCount ?? result?.meta?.changes ?? 0);

/** Org-fenced persistence for Sarvam transport state. Existing operation approvals remain authoritative. */
export function createSarvamVoiceRepository({ all, get, run, transaction, newId, databaseDialect = 'sqlite' }) {
  if (![all, get, run, transaction, newId].every(value => typeof value === 'function')) throw new Error('Sarvam voice repository requires SQL and transaction functions.');

  async function connectionRow(orgId, connectionId) {
    const row = await get(`SELECT id,org_id,provider,provider_account_id,environment,status,granted_scopes,config,
      CASE WHEN credential_ciphertext IS NOT NULL AND revoked_at IS NULL THEN 1 ELSE 0 END AS credential_ready,
      credential_version,credential_expires_at,revoked_at,created_at,updated_at
      FROM provider_connections WHERE org_id=? AND id=? AND provider='sarvam'`, orgId, connectionId);
    return row ? { ...row, config: parseJson(row.config) } : null;
  }

  async function outboundConnection(orgId, telephonyConnectionId) {
    // `connection_id` in the provider request is Sarvam's telephony ID; session FKs
    // use the independent CrewOS provider_connections primary key.
    const configMatch = databaseDialect === 'postgres'
      ? "(config::jsonb->>'telephonyConnectionId')=?"
      : "json_extract(config,'$.telephonyConnectionId')=?";
    const row = await get(`SELECT id,org_id,provider_account_id,environment,status,config,
      CASE WHEN credential_ciphertext IS NOT NULL AND revoked_at IS NULL THEN 1 ELSE 0 END AS credential_ready,
      credential_version,credential_expires_at,revoked_at FROM provider_connections
      WHERE org_id=? AND provider='sarvam' AND status='connected' AND ${configMatch} ORDER BY created_at DESC LIMIT 1`, orgId, telephonyConnectionId);
    return row ? { ...row, config: parseJson(row.config) } : null;
  }

  async function callbackRow(orgId, attemptId, callbackId) {
    return get(`SELECT id,org_id,session_id,attempt_row_id,attempt_id,callback_id,interaction_id,status,
      transcript_consent_applied,transcript_retention_until,received_at
      FROM sarvam_voice_callbacks WHERE org_id=? AND attempt_id=? AND callback_id=?`, orgId, attemptId, callbackId);
  }

  async function findVoiceSessionByOrgAndId(orgId, sessionId) {
    return (await get(`SELECT id AS voice_session_id,org_id,connection_id,user_id,task_id,onboarding_session_id,approval_id,session_type,environment,state,
      sarvam_org_id,workspace_id,app_id,app_version,app_config_json,config_hash,interaction_type,browser_token_hash,reference_id,
      idempotency_key,request_hash,recipient_phone_hash AS recipient_phone,consent_status,consent_explicit,consent_purpose,consent_captured_at,
      transcript_consent_status,transcript_consent_explicit,transcript_consent_recipient_hash,transcript_consent_captured_at,transcript_retention_until,
      created_at,updated_at,expires_at,ended_at FROM sarvam_voice_sessions WHERE org_id=? AND id=?`, orgId, sessionId)) ?? null;
  }

  return {
    async createConnection({ orgId, connectionId, providerAccountId, environment, config, createdAt }) {
      await run(`INSERT INTO provider_connections(id,org_id,provider,provider_account_id,environment,status,granted_scopes,config,created_at,updated_at)
        VALUES(?,?,'sarvam',?,?,'setup_required','[]',?,?,?) ON CONFLICT(org_id,provider,provider_account_id,environment) DO NOTHING`,
      connectionId, orgId, providerAccountId, environment, JSON.stringify(config), createdAt, createdAt);
      const row = await get("SELECT id,org_id,provider_account_id,environment,config,status FROM provider_connections WHERE org_id=? AND provider='sarvam' AND provider_account_id=? AND environment=?", orgId, providerAccountId, environment);
      if (!row || row.config !== JSON.stringify(config)) throw Object.assign(new Error('A Sarvam app binding already exists for this workspace/environment; disconnect it before changing app settings.'), { code: 'sarvam_connection_conflict' });
      return { ...row, config: parseJson(row.config) };
    },
    async activateFixtureConnection(orgId, connectionId, at) {
      const connection = await connectionRow(orgId, connectionId);
      if (!connection || connection.environment !== 'simulation' || connection.config.fixture !== true || connection.credential_ready) return { changes: 0 };
      return run("UPDATE provider_connections SET status='connected',updated_at=? WHERE org_id=? AND id=? AND provider='sarvam' AND environment='simulation' AND credential_ciphertext IS NULL AND revoked_at IS NULL", at, orgId, connectionId);
    },
    findConnectionByOrgAndId: connectionRow,
    async listConnections(orgId) {
      const rows = await all(`SELECT id,org_id,provider,provider_account_id,environment,status,config,
        CASE WHEN credential_ciphertext IS NOT NULL AND revoked_at IS NULL THEN 1 ELSE 0 END AS credential_ready,
        credential_version,credential_expires_at,revoked_at,created_at,updated_at
        FROM provider_connections WHERE org_id=? AND provider='sarvam' ORDER BY created_at DESC`, orgId);
      return rows.map(row => ({ ...row, config: parseJson(row.config) }));
    },
    async disconnectConnection(orgId, connectionId, at) {
      return transaction(async () => {
        await run("UPDATE sarvam_voice_sessions SET state='ended',ended_at=?,updated_at=? WHERE org_id=? AND connection_id=? AND state NOT IN ('ended','expired')", at, at, orgId, connectionId);
        return run("UPDATE provider_connections SET status='revoked',credential_ciphertext=NULL,credential_key_id=NULL,revoked_at=?,granted_scopes='[]',updated_at=? WHERE org_id=? AND id=? AND provider='sarvam'", at, at, orgId, connectionId);
      });
    },
    findConnectionSecret: (orgId, connectionId) => get(`SELECT id,org_id,provider,provider_account_id,environment,status,credential_ciphertext,
      credential_key_id,credential_version,credential_expires_at,revoked_at FROM provider_connections WHERE org_id=? AND id=? AND provider='sarvam'`, orgId, connectionId),
    saveConnectionSecret: (ciphertext, keyId, expiresAt, at, orgId, connectionId, accountId, environment) => run(`UPDATE provider_connections SET credential_ciphertext=?,credential_key_id=?,credential_version=credential_version+1,
      credential_expires_at=?,revoked_at=NULL,status='connected',updated_at=? WHERE org_id=? AND id=? AND provider='sarvam' AND provider_account_id=? AND environment=?`,
    ciphertext, keyId, expiresAt, at, orgId, connectionId, accountId, environment),
    revokeConnectionSecret: (revokedAt, updatedAt, orgId, connectionId) => run(`UPDATE provider_connections SET credential_ciphertext=NULL,credential_key_id=NULL,revoked_at=?,status='revoked',updated_at=? WHERE org_id=? AND id=? AND provider='sarvam'`, revokedAt, updatedAt, orgId, connectionId),

    async findTaskByOrgAndId(orgId, taskId) {
      return get('SELECT id,org_id,state FROM crew_tasks WHERE org_id=? AND id=?', orgId, taskId);
    },
    async findOnboardingSessionByOrgAndId(orgId, sessionId) {
      return get('SELECT id,org_id,state,current_profile_version FROM onboarding_sessions WHERE org_id=? AND id=?', orgId, sessionId);
    },
    async createBrowserVoiceSession(input) {
      const result = await run(`INSERT INTO sarvam_voice_sessions(id,org_id,connection_id,user_id,task_id,onboarding_session_id,provider,environment,session_type,state,
        sarvam_org_id,workspace_id,app_id,app_version,app_config_json,config_hash,interaction_type,browser_token_hash,
        transcript_consent_status,transcript_consent_explicit,transcript_consent_captured_at,transcript_retention_until,created_at,updated_at,expires_at)
        SELECT ?,?,?,?,?,?,'sarvam',?,'browser','created',?,?,?,?,?,?,'CALL',?,?,?,?,?,?,?,?
        WHERE EXISTS(SELECT 1 FROM provider_connections WHERE org_id=? AND id=? AND provider='sarvam' AND status='connected' AND environment=? AND config=?)`,
      input.id, input.orgId, input.connectionId, input.userId, input.taskId, input.onboardingSessionId || null,
      input.environment, input.sarvamOrgId, input.workspaceId, input.appId, input.appVersion, JSON.stringify(input.appConfig), input.configHash,
      input.tokenHash, input.transcriptConsent ? 'granted' : null, input.transcriptConsent ? 1 : 0,
      input.transcriptConsent?.capturedAt || null, input.transcriptConsent?.retentionUntil || null,
      input.createdAt, input.createdAt, input.expiresAt,
      input.orgId, input.connectionId, input.environment, JSON.stringify(input.connectionConfig || input.appConfig));
      if (changes(result) !== 1) throw Object.assign(new Error('Sarvam connection or organization binding is not available.'), { code: 'sarvam_connection_unavailable' });
      return findVoiceSessionByOrgAndId(input.orgId, input.id);
    },
    async findBrowserSessionByToken(orgId, userId, tokenHash) {
      const row = await get(`SELECT s.id AS voice_session_id,s.org_id,s.connection_id,s.user_id,s.task_id,s.onboarding_session_id,s.approval_id,s.state,s.environment,
        s.sarvam_org_id,s.workspace_id,s.app_id,s.app_version,s.app_config_json,s.config_hash,s.interaction_type,s.expires_at,
        c.provider_account_id,c.status AS connection_status,c.config AS connection_config,
        CASE WHEN c.credential_ciphertext IS NOT NULL AND c.revoked_at IS NULL THEN 1 ELSE 0 END AS credential_ready
        FROM sarvam_voice_sessions s JOIN provider_connections c ON c.org_id=s.org_id AND c.id=s.connection_id AND c.provider='sarvam'
        WHERE s.org_id=? AND s.user_id=? AND s.browser_token_hash=? AND s.session_type='browser'`, orgId, userId, tokenHash);
      return row ? { ...row, app_config: parseJson(row.app_config_json), connection_config: parseJson(row.connection_config) } : null;
    },
    async claimBrowserProxyUrl(orgId, sessionId, userId, at) {
      const result = await run(`UPDATE sarvam_voice_sessions SET state='resolving',updated_at=? WHERE org_id=? AND id=? AND user_id=? AND session_type='browser' AND state='created' AND expires_at>?`, at, orgId, sessionId, userId, at);
      return { changes: changes(result), session: changes(result) === 1 ? await findVoiceSessionByOrgAndId(orgId, sessionId) : null };
    },
    async finishBrowserProxyUrl(orgId, sessionId, referenceId, at) {
      const result = await run("UPDATE sarvam_voice_sessions SET state='url_issued',reference_id=?,updated_at=? WHERE org_id=? AND id=? AND session_type='browser' AND state='resolving'", referenceId, at, orgId, sessionId);
      return changes(result) === 1 ? findVoiceSessionByOrgAndId(orgId, sessionId) : null;
    },
    markBrowserProxyFailed: (orgId, sessionId, at) => run("UPDATE sarvam_voice_sessions SET state='failed',last_status='proxy_setup_failed',updated_at=? WHERE org_id=? AND id=? AND session_type='browser' AND state='resolving'", at, orgId, sessionId),
    async getVoiceSessionStatus(orgId, sessionId, userId) {
      return get(`SELECT id AS voice_session_id,org_id,connection_id,user_id,task_id,onboarding_session_id,session_type,environment,state,
        app_version,interaction_type,last_status,created_at,updated_at,expires_at,ended_at FROM sarvam_voice_sessions WHERE org_id=? AND id=? AND user_id=?`, orgId, sessionId, userId);
    },
    async endVoiceSession(orgId, sessionId, userId, at) {
      return run("UPDATE sarvam_voice_sessions SET state='ended',ended_at=?,updated_at=? WHERE org_id=? AND id=? AND user_id=? AND state NOT IN ('ended','expired')", at, at, orgId, sessionId, userId);
    },
    findVoiceSessionByOrgAndId,

    async findOutboundByIdempotency(orgId, key) {
      return get(`SELECT s.org_id,s.id AS voice_session_id,s.task_id,s.request_hash,a.attempt_id,a.state,a.created_at,s.recipient_phone_hash AS recipient_phone
        FROM sarvam_voice_sessions s JOIN sarvam_voice_attempts a ON a.org_id=s.org_id AND a.session_id=s.id
        WHERE s.org_id=? AND s.idempotency_key=?`, orgId, key);
    },
    async findLatestOutboundForRecipient(orgId, phone, since) {
      return get(`SELECT s.org_id,s.id AS voice_session_id,s.task_id,s.request_hash,a.attempt_id,a.state,a.created_at,s.recipient_phone_hash AS recipient_phone
        FROM sarvam_voice_sessions s JOIN sarvam_voice_attempts a ON a.org_id=s.org_id AND a.session_id=s.id
        WHERE s.org_id=? AND s.recipient_phone_hash=? AND a.created_at>=? ORDER BY a.created_at DESC LIMIT 1`, orgId, recipientDigest(orgId, phone), since);
    },
    async reserveOutbound({ orgId, idempotencyKey, requestHash, cooldownSince, record }) {
      return transaction(async () => {
        const phoneHash = recipientDigest(orgId, record.recipientPhone);
        if (databaseDialect === 'postgres') await get('SELECT pg_advisory_xact_lock(hashtext(?))', `sarvam:${orgId}:${phoneHash}`);
        const prior = await this.findOutboundByIdempotency(orgId, idempotencyKey);
        if (prior) return { created: false, record: prior };
        const recent = await this.findLatestOutboundForRecipient(orgId, record.recipientPhone, cooldownSince);
        if (recent) throw Object.assign(new Error('A recent outbound call is inside the recipient cooldown window.'), { code: 'voice_cooldown_active', status: 429 });

        const connection = await outboundConnection(orgId, record.binding.connectionId);
        const config = connection?.config;
        if (!connection || !['simulation', 'staging', 'production'].includes(connection.environment) ||
            config.sarvamOrgId !== record.binding.sarvamOrgId || config.workspaceId !== record.binding.sarvamWorkspaceId ||
            config.appId !== record.binding.appId || Number(config.appVersion) !== Number(record.binding.appVersion)) {
          throw Object.assign(new Error('Sarvam outbound connection or app binding is unavailable.'), { code: 'sarvam_connection_unavailable', status: 503 });
        }
        const sessionId = record.voiceSessionId;
        const appConfigJson = JSON.stringify(config);
        const configHash = digest(appConfigJson);
        const transcriptConsentValid = record.transcriptConsent?.status === 'granted' && record.transcriptConsent?.explicit === true &&
          record.transcriptConsent?.recipientPhone === record.recipientPhone && Number.isFinite(Date.parse(record.transcriptConsent?.capturedAt || '')) &&
          Date.parse(record.transcriptConsent.capturedAt) <= Date.parse(record.createdAt);
        const transcriptRetentionUntil = transcriptConsentValid
          ? new Date(Date.parse(record.createdAt) + 30 * 24 * 60 * 60 * 1000).toISOString() : null;
        const sessionResult = await run(`INSERT INTO sarvam_voice_sessions(id,org_id,connection_id,user_id,task_id,approval_id,provider,environment,session_type,state,
          sarvam_org_id,workspace_id,app_id,app_version,app_config_json,config_hash,interaction_type,idempotency_key,request_hash,recipient_phone_hash,
          consent_status,consent_explicit,consent_purpose,consent_captured_at,transcript_consent_status,transcript_consent_explicit,transcript_consent_recipient_hash,transcript_consent_captured_at,transcript_retention_until,
          created_at,updated_at)
          SELECT ?,?,?,?,?,?,'sarvam',?,'outbound','queued',?,?,?,?,?,?,'CALL',?,?,?,?,?,?,?,?,?,?,?,?,?,?
          WHERE EXISTS(SELECT 1 FROM provider_connections WHERE org_id=? AND id=? AND provider='sarvam' AND status='connected' AND environment=?)
          ON CONFLICT(org_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
        sessionId, orgId, connection.id, record.actorId, record.taskId, record.approvalId || null,
        connection.environment, config.sarvamOrgId, config.workspaceId, config.appId, config.appVersion,
        appConfigJson, configHash, idempotencyKey, requestHash, phoneHash,
        record.consent.status, record.consent.explicit ? 1 : 0, String(record.consent.purpose || '').slice(0, 240), record.consent.capturedAt,
        transcriptConsentValid ? 'granted' : null, transcriptConsentValid ? 1 : 0, transcriptConsentValid ? phoneHash : null,
        transcriptConsentValid ? record.transcriptConsent.capturedAt : null, transcriptRetentionUntil, record.createdAt, record.createdAt,
        orgId, connection.id, connection.environment);
        if (changes(sessionResult) !== 1) {
          const raced = await this.findOutboundByIdempotency(orgId, idempotencyKey);
          if (raced) return { created: false, record: raced };
          throw Object.assign(new Error('Outbound request reservation lost its provider connection binding.'), { code: 'voice_tenant_mismatch', status: 403 });
        }

        const attemptId = newId('sarvam_attempt');
        const attemptResult = await run(`INSERT INTO sarvam_voice_attempts(id,org_id,session_id,connection_id,task_id,environment,idempotency_key,request_hash,state,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,'queued',?,?) ON CONFLICT(org_id,connection_id,environment,idempotency_key) DO NOTHING`,
        attemptId, orgId, sessionId, connection.id, record.taskId, connection.environment, idempotencyKey, requestHash, record.createdAt, record.createdAt);
        if (changes(attemptResult) !== 1) {
          const raced = await this.findOutboundByIdempotency(orgId, idempotencyKey);
          if (raced) return { created: false, record: raced };
          throw Object.assign(new Error('Outbound attempt reservation did not persist.'), { code: 'voice_reservation_conflict', status: 409 });
        }
        return { created: true, record: await this.findOutboundByIdempotency(orgId, idempotencyKey) };
      });
    },
    async markOutboundDialing(orgId, voiceSessionId, at) {
      return transaction(async () => {
        const attempt = await run(`UPDATE sarvam_voice_attempts SET state='dialing',updated_at=? WHERE org_id=? AND session_id=? AND state='queued'
          AND EXISTS(SELECT 1 FROM sarvam_voice_sessions s WHERE s.org_id=? AND s.id=? AND s.state='queued')`, at, orgId, voiceSessionId, orgId, voiceSessionId);
        if (changes(attempt) !== 1) return { changes: 0, org_id: orgId, voice_session_id: voiceSessionId, state: 'not_claimed' };
        const session = await run("UPDATE sarvam_voice_sessions SET state='dialing',updated_at=? WHERE org_id=? AND id=? AND state='queued'", at, orgId, voiceSessionId);
        if (changes(session) !== 1) throw Object.assign(new Error('Outbound session state changed while claiming dispatch.'), { code: 'voice_dispatch_claim_lost', status: 409 });
        // Required proof for the service boundary: exactly one attempt row and its
        // matching org/session are now atomically in dialing state.
        return { changes: 1, org_id: orgId, voice_session_id: voiceSessionId, state: 'dialing' };
      });
    },
    async markOutboundAccepted(orgId, voiceSessionId, attemptId, at) {
      const result = await run(`UPDATE sarvam_voice_attempts SET attempt_id=?,state='dialing',accepted_at=?,updated_at=? WHERE org_id=? AND session_id=? AND state='dialing' AND attempt_id IS NULL
        AND EXISTS(SELECT 1 FROM sarvam_voice_sessions s WHERE s.org_id=? AND s.id=? AND s.state='dialing')`, attemptId, at, at, orgId, voiceSessionId, orgId, voiceSessionId);
      if (changes(result) !== 1) return null;
      return get(`SELECT s.org_id,s.id AS voice_session_id,s.task_id,a.attempt_id,a.state FROM sarvam_voice_sessions s JOIN sarvam_voice_attempts a ON a.org_id=s.org_id AND a.session_id=s.id WHERE s.org_id=? AND s.id=?`, orgId, voiceSessionId);
    },
    async markOutboundReconciliationRequired(orgId, voiceSessionId, code, at) {
      return transaction(async () => {
        await run("UPDATE sarvam_voice_attempts SET state='reconciliation_required',reason_code=?,updated_at=? WHERE org_id=? AND session_id=? AND state IN ('queued','dialing')", String(code).replace(/[^a-z0-9_-]/gi, '_').slice(0, 80), at, orgId, voiceSessionId);
        return run("UPDATE sarvam_voice_sessions SET state='reconciliation_required',last_status='provider_outcome_uncertain',updated_at=? WHERE org_id=? AND id=? AND session_type='outbound' AND state IN ('queued','dialing')", at, orgId, voiceSessionId);
      });
    },
    async findOutboundByAttemptId(attemptId) {
      return get(`SELECT s.org_id,s.id AS voice_session_id,s.connection_id,s.task_id,s.environment,a.attempt_id,a.id AS attempt_row_id,
        s.recipient_phone_hash AS recipient_phone,s.transcript_consent_status,s.transcript_consent_explicit,
        s.transcript_consent_recipient_hash AS transcript_consent_recipient_phone,s.transcript_consent_captured_at,s.transcript_retention_until
        FROM sarvam_voice_attempts a JOIN sarvam_voice_sessions s ON s.org_id=a.org_id AND s.id=a.session_id
        WHERE a.attempt_id=?`, attemptId);
    },
    async claimSarvamCallback({ orgId, attemptId, callbackId, interactionId, status, receivedAt }) {
      return transaction(async () => {
        const attempt = await get('SELECT id,session_id,state FROM sarvam_voice_attempts WHERE org_id=? AND attempt_id=?', orgId, attemptId);
        if (!attempt) return null;
        const existing = await callbackRow(orgId, attemptId, callbackId);
        if (existing?.attempt_row_id === attempt.id && existing.session_id === attempt.session_id) return { duplicate: true, org_id: orgId };
        if (attempt.state !== 'dialing') return null;
        const result = await run(`INSERT INTO sarvam_voice_callbacks(id,org_id,session_id,attempt_row_id,attempt_id,callback_id,interaction_id,status,received_at)
          SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM sarvam_voice_attempts WHERE org_id=? AND id=? AND session_id=? AND attempt_id=? AND state='dialing')
          ON CONFLICT(org_id,attempt_row_id,callback_id) DO NOTHING`, newId('sarvam_callback'), orgId, attempt.session_id, attempt.id, attemptId, callbackId, interactionId, status, receivedAt, orgId, attempt.id, attempt.session_id, attemptId);
        const claimed = changes(result);
        if (claimed === 1) return { duplicate: false, org_id: orgId };
        if (claimed !== 0) return null;
        const replay = await callbackRow(orgId, attemptId, callbackId);
        return replay?.attempt_row_id === attempt.id && replay.session_id === attempt.session_id ? { duplicate: true, org_id: orgId } : null;
      });
    },
    async recordSarvamOutcome(outcome) {
      const row = await callbackRow(outcome.orgId, outcome.attemptId, outcome.callbackId);
      if (!row || row.session_id !== outcome.voiceSessionId) return null;
      const transcriptRow = outcome.transcriptConsentApplied === true && Array.isArray(outcome.transcript) ? outcome.transcript : null;
      const session = transcriptRow ? await findVoiceSessionByOrgAndId(outcome.orgId, outcome.voiceSessionId) : null;
      const requestedUntil = transcriptRow ? new Date(Date.parse(outcome.receivedAt) + 30 * 24 * 60 * 60 * 1000).toISOString() : null;
      const recipientConsentMatches = session?.transcript_consent_status === 'granted' &&
        (session.transcript_consent_explicit === true || session.transcript_consent_explicit === 1) &&
        session.transcript_consent_recipient_hash === session.recipient_phone &&
        Number.isFinite(Date.parse(session.transcript_consent_captured_at || '')) &&
        Date.parse(session.transcript_consent_captured_at) <= Date.parse(outcome.receivedAt);
      const retentionUntil = transcriptRow && recipientConsentMatches && session?.transcript_retention_until && Date.parse(session.transcript_retention_until) > Date.parse(outcome.receivedAt)
        ? (Date.parse(session.transcript_retention_until) < Date.parse(requestedUntil) ? session.transcript_retention_until : requestedUntil) : null;
      await transaction(async () => {
        const callbackChanged = await run(`UPDATE sarvam_voice_callbacks SET transcript_json=?,transcript_consent_applied=?,transcript_retention_until=?
          WHERE org_id=? AND id=? AND session_id=? AND callback_id=?`, retentionUntil ? JSON.stringify(transcriptRow) : null, retentionUntil ? 1 : 0, retentionUntil, outcome.orgId, row.id, outcome.voiceSessionId, outcome.callbackId);
        if (changes(callbackChanged) !== 1) throw Object.assign(new Error('Sarvam callback inbox claim changed before persistence.'), { code: 'voice_callback_replay', status: 409 });
        await run(`UPDATE sarvam_voice_attempts SET state=?,interaction_id=?,updated_at=? WHERE org_id=? AND id=? AND attempt_id=? AND state IN ('queued','dialing')`, outcome.status, outcome.interactionId, outcome.receivedAt, outcome.orgId, row.attempt_row_id, outcome.attemptId);
        await run(`UPDATE sarvam_voice_sessions SET state=?,last_status=?,updated_at=? WHERE org_id=? AND id=? AND session_type='outbound' AND state IN ('queued','dialing','reconciliation_required')`, outcome.status, outcome.status, outcome.receivedAt, outcome.orgId, outcome.voiceSessionId);
      });
      return { org_id: outcome.orgId, voice_session_id: outcome.voiceSessionId };
    },
    async findVoiceCallbackTranscript(orgId, voiceSessionId, callbackId, at) {
      const row = await get(`SELECT transcript_json FROM sarvam_voice_callbacks WHERE org_id=? AND session_id=? AND callback_id=?
        AND transcript_consent_applied=1 AND transcript_retention_until>?`, orgId, voiceSessionId, callbackId, at);
      return row ? parseJson(row.transcript_json, null) : null;
    },
    async purgeExpiredVoiceTranscripts(at, orgId = null) {
      if (orgId) {
        return run(`UPDATE sarvam_voice_callbacks SET transcript_json=NULL WHERE org_id=? AND transcript_json IS NOT NULL AND transcript_retention_until IS NOT NULL AND transcript_retention_until<=?`, orgId, at);
      }
      const organizations = await all('SELECT id FROM organizations');
      let purged = 0;
      for (const organization of organizations) {
        purged += changes(await run(`UPDATE sarvam_voice_callbacks SET transcript_json=NULL WHERE org_id=? AND transcript_json IS NOT NULL AND transcript_retention_until IS NOT NULL AND transcript_retention_until<=?`, organization.id, at));
      }
      return { changes: purged };
    },

    async findPendingVoiceApproval(orgId, approvalId) {
      return get(`SELECT a.id,a.org_id,a.task_id,a.input_hash AS action_hash,a.signer_user_id AS manager_user_id,a.expires_at,a.nonce,a.policy_revision,
        'approve' AS allowed_decision,a.state,a.connection_id,a.environment,a.action,a.artifact_hash,a.credential_version,
        op.input_hash AS current_input_hash,op.policy_revision AS current_policy_revision,op.state AS operation_state
        FROM operation_approvals a JOIN external_operations op ON op.org_id=a.org_id AND op.id=a.operation_id
        JOIN provider_connections pc ON pc.org_id=a.org_id AND pc.id=a.connection_id
        WHERE a.org_id=? AND a.id=? AND a.state='pending' AND op.state IN ('pending','awaiting_approval')
          AND op.connection_id=a.connection_id AND op.environment=a.environment AND op.task_id=a.task_id AND op.action=a.action
          AND op.input_hash=a.input_hash AND op.policy_revision=a.policy_revision
          AND pc.status='connected' AND pc.revoked_at IS NULL AND pc.credential_version=a.credential_version
          AND (pc.credential_expires_at IS NULL OR pc.credential_expires_at>?)
          AND a.artifact_hash=(SELECT art.revision_hash FROM operation_artifacts art WHERE art.org_id=a.org_id AND art.operation_id=a.operation_id ORDER BY art.created_at DESC,art.id DESC LIMIT 1)`, orgId, approvalId, new Date().toISOString());
    },
    async findVoiceIntentByIdempotency(orgId, key) {
      return get('SELECT id,org_id,session_id AS voice_session_id,approval_id,intent,request_hash,intent_hash,idempotency_key FROM sarvam_voice_decision_intents WHERE org_id=? AND idempotency_key=?', orgId, key);
    },
    async recordVoiceIntent(input) {
      const result = await run(`INSERT INTO sarvam_voice_decision_intents(id,org_id,session_id,approval_id,task_id,idempotency_key,request_hash,intent_hash,intent,transcript_ref,created_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM operation_approvals a JOIN external_operations op ON op.org_id=a.org_id AND op.id=a.operation_id
          JOIN provider_connections pc ON pc.org_id=a.org_id AND pc.id=a.connection_id
          WHERE a.org_id=? AND a.id=? AND a.state='pending' AND a.task_id=? AND a.input_hash=? AND a.nonce=? AND a.policy_revision=? AND a.expires_at>?
            AND op.connection_id=a.connection_id AND op.environment=a.environment AND op.task_id=a.task_id AND op.action=a.action
            AND op.input_hash=a.input_hash AND op.policy_revision=a.policy_revision
            AND pc.status='connected' AND pc.revoked_at IS NULL AND pc.credential_version=a.credential_version
            AND (pc.credential_expires_at IS NULL OR pc.credential_expires_at>?)
            AND a.artifact_hash=(SELECT art.revision_hash FROM operation_artifacts art WHERE art.org_id=a.org_id AND art.operation_id=a.operation_id ORDER BY art.created_at DESC,art.id DESC LIMIT 1))
          AND EXISTS(SELECT 1 FROM sarvam_voice_sessions s WHERE s.org_id=? AND s.id=? AND s.task_id=? AND s.approval_id=? AND s.environment IN ('simulation','staging','production'))
        ON CONFLICT(org_id,idempotency_key) DO NOTHING`, input.id, input.orgId, input.voiceSessionId, input.approvalId, input.taskId, input.idempotencyKey,
      input.requestHash, input.intentHash, input.intent, input.transcriptRef, input.createdAt, input.orgId, input.approvalId, input.taskId, input.binding.actionHash,
      input.binding.nonce, input.binding.policyRevision, input.createdAt, input.createdAt, input.orgId, input.voiceSessionId, input.taskId, input.approvalId);
      const saved = await this.findVoiceIntentByIdempotency(input.orgId, input.idempotencyKey);
      if (!saved || saved.request_hash !== input.requestHash || saved.org_id !== input.orgId || saved.approval_id !== input.approvalId || saved.voice_session_id !== input.voiceSessionId) return null;
      return saved;
    },
    async findLatestVoiceIntentForApproval(orgId, voiceSessionId, approvalId) {
      return get(`SELECT id,org_id,session_id AS voice_session_id,approval_id,intent,intent_hash,created_at FROM sarvam_voice_decision_intents
        WHERE org_id=? AND session_id=? AND approval_id=? ORDER BY created_at DESC,id DESC LIMIT 1`, orgId, voiceSessionId, approvalId);
    },
    async consumePendingApproval({ orgId, approvalId, userId, voiceSessionId, expectedBinding, consumedAt }) {
      // Manager confirmation advances the existing operation_approvals row pending→approved.
      // The existing action workflow alone later consumes approved→consumed and executes it.
      const result = await run(`UPDATE operation_approvals SET state='approved',approved_by_user_id=?,approved_at=? WHERE org_id=? AND id=?
        AND signer_user_id=? AND state='pending' AND expires_at>? AND task_id=? AND input_hash=? AND policy_revision=? AND nonce=?
        AND EXISTS(SELECT 1 FROM external_operations op WHERE op.org_id=operation_approvals.org_id AND op.id=operation_approvals.operation_id
          AND op.connection_id=operation_approvals.connection_id AND op.environment=operation_approvals.environment AND op.task_id=operation_approvals.task_id
          AND op.action=operation_approvals.action AND op.input_hash=operation_approvals.input_hash AND op.policy_revision=operation_approvals.policy_revision
          AND op.state IN ('pending','awaiting_approval'))
        AND EXISTS(SELECT 1 FROM provider_connections pc WHERE pc.org_id=operation_approvals.org_id AND pc.id=operation_approvals.connection_id
          AND pc.status='connected' AND pc.revoked_at IS NULL AND pc.credential_version=operation_approvals.credential_version
          AND (pc.credential_expires_at IS NULL OR pc.credential_expires_at>?))
        AND operation_approvals.artifact_hash=(SELECT art.revision_hash FROM operation_artifacts art WHERE art.org_id=operation_approvals.org_id AND art.operation_id=operation_approvals.operation_id ORDER BY art.created_at DESC,art.id DESC LIMIT 1)
        AND EXISTS(SELECT 1 FROM sarvam_voice_sessions s WHERE s.org_id=operation_approvals.org_id AND s.id=? AND s.task_id=operation_approvals.task_id AND s.approval_id=operation_approvals.id)`,
      userId, consumedAt, orgId, approvalId, userId, consumedAt, expectedBinding.taskId, expectedBinding.actionHash, expectedBinding.policyRevision, expectedBinding.nonce, consumedAt, voiceSessionId);
      return { changes: changes(result), org_id: orgId };
    },
    async lockOrganization(orgId) {
      const sql = databaseDialect === 'postgres' ? 'SELECT id FROM organizations WHERE id=? FOR UPDATE' : 'SELECT id FROM organizations WHERE id=?';
      return Boolean(await get(sql, orgId));
    },
  };
}
