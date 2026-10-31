# Sarvam voice integration

## Boundary and current readiness

CrewOS Chief remains the decision authority under ADR-11. Sarvam carries browser audio or a managed voice conversation. A spoken “yes” is only a proposal; authenticated manager confirmation must consume the matching existing `operation_approvals` row. This integration never executes a protected action or writes a confirmed onboarding claim.

The backend currently includes org-scoped voice persistence, manager-only connection/session routes, an authenticated app-runtime proxy for the verified SDK 0.0.42 contract, and a local-only signed fixture callback. The frontend call UI is not part of this slice. Live outbound dispatch and live callback persistence are unavailable because Sarvam’s published callback contract does not document an authenticity signature/header and no private trusted ingress verifier is configured. The API reports this setup requirement explicitly.

Default flags keep the integration disabled:

```dotenv
SARVAM_LIVE_ENABLED=false
SARVAM_LOCAL_FIXTURES=false
CREWOS_LOCAL_WEBHOOK_FIXTURES=false
```

`PILOT_MODE` also blocks the V2 routes. Local fixture use requires both `SARVAM_LOCAL_FIXTURES=true` and `CREWOS_LOCAL_WEBHOOK_FIXTURES=true`, a non-production runtime, and `CREWOS_ORG_ENGINE_V2=true` with the organization in `CREWOS_ORG_ENGINE_V2_ORGS`.

## Persistence and approval authority

Migration v25 adds `sarvam_voice_sessions`, `sarvam_voice_attempts`, `sarvam_voice_callbacks`, and `sarvam_voice_decision_intents`, with org-composite foreign keys and indexes. Browser and outbound sessions retain the provider/environment and pinned app configuration, task/onboarding/approval bindings, consent state, idempotency hashes, and retention deadlines. Recipient numbers are stored as hashes. Provider API keys remain in the existing encrypted `provider_connections.credential_ciphertext` lifecycle; they are not copied into voice config or responses. Callback transcripts are written only when the attempt’s stored consent is explicit, current, and recipient-matched, with a 30-day retention deadline.

`backend/src/repositories/sarvam-voice-repository.mjs` implements the voice service repository contract. Outbound reservation and recipient cooldown are transaction-fenced; the dialing CAS must change exactly one matching attempt/session before provider dispatch. Callback inbox rows are org/attempt scoped and deduplicated. Voice intents reference an existing immutable `operation_approvals` record; manager confirmation advances that existing row from `pending` to `approved`, while the existing action workflow remains the only consumer/executor. Expired callback transcript bodies are cleared by org-scoped requests and the backend’s hourly retention sweep while callback dedup rows remain as tombstones.

No supported live callback verifier is configured. The production callback route reads raw bytes, then the service rejects before parsing or persistence when its verifier is absent. Do not enable outbound dialing until Sarvam documents callback authentication or a private trusted ingress verifier is implemented and independently reviewed.

## Sarvam dashboard values to collect

Create/configure the Sarvam managed voice app and record these values in the manager-only CrewOS connection setup:

- Sarvam organization ID (`sarvamOrgId`)
- Sarvam workspace ID (`workspaceId`)
- Voice app ID (`appId`)
- Pinned app version (`appVersion`)
- Voice model (`voiceModel`)
- Enabled language identifiers (`languages`)
- Telephony connection ID (`telephonyConnectionId`) and E.164 agent phone (`agentPhoneNumber`) when the app is configured for telephony

The browser runtime route uses the org, workspace, app, and pinned version. Telephony connection and agent number are stored for the outbound configuration but do not enable dialing. CrewOS does not infer dashboard IDs or report a connection as provider-verified until its encrypted credential is saved.

For a separate Chief incident/permission voice agent, set `SARVAM_ESCALATION_APP_ID` and `SARVAM_ESCALATION_APP_VERSION` in the backend environment. The escalation app must belong to the same Sarvam organization and workspace as `SARVAM_ORG_ID` and `SARVAM_WORKSPACE_ID`; it reuses the existing encrypted `SARVAM_API_KEY` connection. `SARVAM_ESCALATION_VOICE_MODEL` and `SARVAM_ESCALATION_LANGUAGES` are optional and default to the general voice settings. Restart the backend after changing these values.

The Sarvam API key is entered through the authenticated manager credentials route and encrypted using the existing `APP_MASTER_KEY` storage lifecycle. It is never returned to the browser. A connection status of `connected` means CrewOS has stored the encrypted credential; this slice does not make a provider validation call or claim the Sarvam account was verified. The SDK must be constructed with `apiKey: ''`.

## Exact routes and URL templates

Set the existing public origin setting `APP_ORIGIN` to the canonical deployment origin, for example `https://voice.example.com`. No new public-origin environment variable is required. Local development can use `http://localhost:4173`; Sarvam outbound callbacks require a publicly reachable HTTPS origin, which remains unavailable until callback verification is supported.

### Same-origin browser SDK app-runtime proxy

Configure the official `sarvam-conv-ai-sdk@0.0.42` browser client with:

```js
new ConversationAgent({
  baseUrl: '/api/sarvam-proxy/',
  apiKey: '',
  // Supply the app and version using the pinned SDK 0.0.42 documented config.
});
```

The only accepted proxy request is:

```text
GET /api/sarvam-proxy/orgs/{sarvamOrgId}/workspaces/{workspaceId}/apps/{appId}/url
    ?interaction_type=CALL&version={pinnedVersion}
    &user_identifier={authenticatedCrewOSUserId}
```

Optional SDK query fields are limited to `user_identifier_type`; unknown or repeated fields are rejected. Path IDs, version, user identity, CrewOS org, connection, and app config must match the authenticated one-use browser session. Caller-supplied `X-API-Key` is ignored; the server injects the encrypted connection credential into the fixed Sarvam URL:

```text
GET https://apps.sarvam.ai/api/app-runtime/orgs/{org_id}/workspaces/{workspace_id}/apps/{app_id}/url
```

The proxy returns only `{ "url": "wss://…", "reference_id": "…" }`, with `Cache-Control: no-store`; it validates the provider WSS origin and does not proxy arbitrary URLs. The browser connects directly to the returned signed WebSocket URL. It is a short-lived, single-use capability. The SDK package may print that URL to the browser console; do not copy it into CrewOS logs, analytics, support tickets, or persistent client state. A new session is required after disconnection. Start microphone capture only from a user gesture and call `stop()` when the view unmounts.

Authenticated manager endpoints:

```text
GET    /api/sarvam/v2/status
GET    /api/sarvam/v2/connections
POST   /api/sarvam/v2/connections
POST   /api/sarvam/v2/connections/{connectionId}/credentials
DELETE /api/sarvam/v2/connections/{connectionId}
POST   /api/sarvam/v2/sessions
GET    /api/sarvam/v2/sessions/{voiceSessionId}
DELETE /api/sarvam/v2/sessions/{voiceSessionId}
POST   /api/sarvam/v2/sessions/{voiceSessionId}/transcript
```

Session creation requires a workspace-owned task, onboarding session, and explicit transcript consent. It returns the empty browser SDK key and sets a short-lived HttpOnly same-origin cookie used by the app-runtime proxy. Transcript turns are bounded, hashed into a stable `clientTurnId`, and passed to the existing Onboarding V2 turn service with speaker labels and no confirmed claim IDs. All extracted claims remain proposals for normal manager review.

### Per-call outbound webhook

If/when a per-call outbound is enabled, its endpoint template is:

```text
{APP_ORIGIN}/api/webhooks/sarvam/outbound
```

This is a webhook callback URL, not an OAuth redirect URI. Sarvam’s published callback payload documents statuses, attempt/interaction IDs, echoed metadata, and `interaction_transcript: [{ role: 'agent'|'user', en_text: string }]`; the cited docs do not establish a callback signature header or signing configuration. The production route therefore remains fail-closed and live outbound readiness remains false. Do not configure production dashboard callbacks or dial calls until a supported verifier/private ingress is available.

For local-only integration fixtures, the simulated route is:

```text
POST /api/local-fixtures/webhooks/sarvam/outbound
X-CrewOS-Fixture-Signature: hex(HMAC-SHA256(CREWOS_LOCAL_WEBHOOK_FIXTURE_SECRET, raw_body))
```

That header is a CrewOS fixture contract, not a Sarvam header. The fixture verifier accepts only a connected `simulation` connection marked `fixture: true`; it cannot verify a production Sarvam callback.

### Sarvam `fetch_call_context` tool

The browser session response includes a short-lived, read-only `contextCapability`. The Voice page passes it to the Sarvam agent as `crewos_voice_session_id` and `crewos_context_token`. To let the agent answer questions about the current onboarding and demo setup, configure a Sarvam custom tool named `fetch_call_context`:

```text
POST https://<public-backend-origin>/api/sarvam/v2/tools/fetch-call-context
Content-Type: application/json
```

Request JSON schema:

```json
{
  "type": "object",
  "required": ["voice_session_id", "context_token"],
  "properties": {
    "voice_session_id": { "type": "string", "description": "Use crewos_voice_session_id from the agent variables." },
    "context_token": { "type": "string", "description": "Use crewos_context_token from the agent variables." }
  }
}
```

The endpoint accepts the arguments directly or under `arguments` / `parameters`. It returns a bounded onboarding summary and the simulated Northstar employees, Shopify store, paid order, WhatsApp message, and Twilio state. The capability is bound to the org and active browser voice session, expires with that session, and is held in backend memory; a backend restart invalidates it, so start a new voice session. The tool is read-only and always reports `externalEffects: false`. Do not configure `ask-chief`, decision, or approval tools; those actions remain unavailable and require manager review.

## Verification handoff

The Voice page provides a browser interview and sends an explicitly consented transcript to Chief for review. A completed two-way interview opens the local CrewOS simulation dashboard. It creates no real employee, Shopify store, payment, WhatsApp message, SMS, or call. The `fetch_call_context` tool is read-only and scoped to the active voice session. Outbound voice and approval/action tools remain disabled; live provider callbacks still need a supported verifier or trusted private ingress. Browser proxy live requests require `SARVAM_LIVE_ENABLED=true`, V2 allowlisting, `PILOT_MODE=false`, a saved encrypted credential, and an explicitly injected transport.

Recommended Sonnet focused command:

```sh
node --test test/sarvam-voice.test.mjs test/sarvam-voice-persistence.test.mjs test/sarvam-voice-v2-controller.test.mjs test/db-migrations.test.mjs
```

Recommended full regression command:

```sh
npm test
```

Provider protocol references: [Sarvam web voice SDK](https://docs.sarvam.ai/voice-agents/deploy/sdks/web), [instant outbound create](https://docs.sarvam.ai/voice-agents/api/instant-outbound/create), and [outbound callback payload](https://docs.sarvam.ai/voice-agents/api/instant-outbound/webhook-payload). The app-runtime path and query contract above is pinned to the inspected MIT `sarvam-conv-ai-sdk@0.0.42` package source.
