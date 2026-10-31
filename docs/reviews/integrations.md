# CrewOS integration contracts and live acceptance

**Reviewed:** 2026-10-25
**Scope:** Neon Managed Better Auth email OTP, Solari browser/profile/sandbox/desktop, Slack OAuth and slash commands, Jira Cloud OAuth and REST.
**Evidence:** source review of the current branch plus installed SDK versions; official provider documentation linked below. No provider API calls, account changes, paid calls, or external test writes were made. Configuration findings use the nonsecret metadata supplied for this review; secret values were not read or printed.

## Findings

| Integration | Current contract | Required action or live gate |
| --- | --- | --- |
| Neon Managed Better Auth | The password-reset UI calls `POST /email-otp/request-password-reset` with `{email}` and `POST /email-otp/reset-password` with `{email, otp, password}`. These match the current Better Auth Email OTP routes. The same-origin proxy forwards the method, JSON body, auth cookies, and upstream response. | No endpoint rename is indicated. A live branch must still prove that its Managed Auth endpoint accepts these routes and delivers the OTP. The EMAIL_NOT_VERIFIED response is retained as a structured error by the frontend. |
| Solari browser and profiles | Installed `@solarisdk/browser` is 0.1.5. Sessions are created with recording enabled and `stealth: false`; optional profile IDs are passed through. | Correct profile-backed browser flows to use Solari’s seeded default context. Current workflow code selects `browser.contexts()[0]`, which Solari says is not guaranteed to be the context seeded from the profile. Prove login persistence with a test account. |
| Solari network boundary | The app checks each browser request hostname with its own DNS lookup, then lets remote Chromium resolve and connect. That is useful filtering, but it does not pin the provider’s DNS result or enforce a provider-side egress policy. | Do not describe this as a complete egress allowlist or SSRF boundary. Solari’s provider allowlist requires Enterprise, `stealth: true`, and the raw REST or Browserbase-compatible surfaces; direct-IP connections are explicitly outside that control. This app uses the TypeScript SDK and `stealth: false`. |
| Solari sandbox and desktop | Installed SDKs are `@solarisdk/sandbox` 0.1.4 and `@solarisdk/desktop` 0.1.3. Sandbox creation uses the documented `base` template. Desktop creation uses the supported built-in `workstation` template with recording enabled. | The desktop request is compatible with Solari’s documented legacy desktop API; no recording flag correction is needed for this built-in template. Solari recommends its unified sandbox API for new integrations. Confirm plan entitlement, credit, stream access, replay availability, pause/stop, and actual spend behavior in the live account. |
| Slack | The app requests bot scopes `commands,chat:write`, exchanges an OAuth code at `oauth.v2.access`, checks the granted scopes, validates signed slash-command requests, and posts notifications with `chat.postMessage`. | No endpoint/scope correction found. Production setup is blocked until `APP_ORIGIN`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET` are configured and the matching HTTPS callback and command URL are registered. A Slack admin must consent. |
| Jira Cloud | The app uses Atlassian 3LO, checks `accessible-resources`, calls through `api.atlassian.com/ex/jira/{cloudId}/rest/api/3`, and requests `read:jira-work`, `write:jira-work`, and `offline_access`. Refresh replaces the stored rotating refresh token. | The flow and named REST paths match current Atlassian docs. Production setup is blocked until Jira OAuth client credentials and the exact HTTPS callback are configured and registered. The consenting account’s Jira permissions still limit all actions; use a least-privilege account and disposable project for acceptance. |

## Neon Managed Better Auth

The reset screen uses the current Email OTP request and reset paths and request shapes. Better Auth marks the older `/forget-password/email-otp` path deprecated. Neon’s current Managed Better Auth material lists OTP support and documents OTP email delivery, so these paths are appropriate for the managed product contract. The repository proxy mounts them below `/api/auth/neon/` and appends them to the configured branch Auth URL ending in `/auth`.

Static code and unit tests do not establish that the configured branch has usable email delivery, its trusted-origin settings accept the production site, or that a real OTP can be used once and then rejected. Verify the branch-matched `DATABASE_URL` and Auth URL, the trusted app origin, email/password and verification settings, and the mail provider before declaring Neon live acceptance complete. The test fixture for `EMAIL_NOT_VERIFIED` confirms error mapping only; it is not Neon evidence.

The latest Neon pricing page includes Managed Better Auth in Free and Launch. Free currently lists up to 60,000 monthly active users per project, 100 compute-hours per project, and 1 GB storage. Auth is included in plan pricing, while PostgreSQL compute and storage can still generate usage charges.

## Solari browser, profile, recording, and egress

The installed SDK versions and current source agree on browser session creation and profile management. Solari profiles retain cookies and local storage; Solari warns that profiles act like passwords because anyone with the API key can attach them. The product UI should limit profile management and replay access to the appropriate workspace roles.

There is a concrete profile-context concern in `backend/lib/solari.mjs`: profile-backed sessions are launched with `profileId`, then the code picks `browser.contexts()[0]` and creates a new page there. Solari’s current profile guide says its launch wrapper seeds a default context and specifically says not to assume `browser.contexts()[0]` is the seeded context. Use the documented default context exposed by the installed SDK and verify a harmless authenticated “who am I” page before accepting saved-login work.

Browser workflows set `recording: true`. Solari says recordings capture input values by default, which can include passwords, reset codes, or other sensitive form entries. Its current replay retention is plan-dependent (1 day Free, 7 days Starter, 30 days Professional, 90 days Enterprise). Treat replay links as sensitive, test who can retrieve them, and decide whether recording should be disabled or excluded for sensitive flows.

The request router in `backend/lib/solari.mjs` checks URL scheme, credentials, read-only method policy, and hostname resolution from CrewOS’s backend. The remote browser does its own later resolution, so this remains a check-then-connect gap. Solari’s provider egress allowlist can reduce host access, but the provider docs require Enterprise and `stealth: true`, expose the option through REST/compatibility rather than the TypeScript SDK, and say direct-IP traffic is not covered. Since CrewOS intentionally launches with `stealth: false`, no stealth upgrade is required for the current behavior, and the allowlist is not available to this code path as configured. Keep this limitation explicit in security claims and test redirect/private-host cases.

## Solari sandbox and desktop

The sandbox smoke tool creates a `base` sandbox, runs one bounded `echo`, and kills it in `finally`. The interactive sandbox path does not request recording; Solari documents recording as desktop-only because a headless sandbox has no display.

The employee desktop path creates a `workstation` desktop with recording. Solari documents `workstation` as a built-in desktop template and supports recording on the legacy `POST /desktops` path. Its separate unified sandbox endpoint rejects recording for restore boots/custom templates, so do not apply that caveat to this existing built-in desktop request. Solari currently labels `/desktops` legacy and recommends `POST /sandboxes` with `kind: "desktop"` for new integrations; the existing SDK surface remains documented.

Desktop creation starts billable runtime immediately. The API reference says desktop creation requires desktop plan entitlement and may return insufficient-credit/concurrency errors. Public pricing lists browser hourly rates, VM CPU/memory rates, a live-screen surcharge, and snapshot storage. Check actual account plan and credits before live tests; the supplied configuration metadata does not establish the plan or remaining balance.

## Cost and licensing snapshot

Published prices are USD and can change; actual spend depends on account plan, runtime, resource size, and region.

| Provider | Current published baseline | Licensing and cost note |
| --- | --- | --- |
| Neon | Free is $0 and includes Managed Better Auth, 100 CU-hours/project, 1 GB/project, and up to 60k auth MAU. Launch is usage-based at $0.106/CU-hour and $0.35/GB-month. | Managed Auth is included; database compute/storage still meter by plan. |
| Solari | Free includes $3 monthly credits; browser runtime is $0.15/hour Free, $0.10 Starter, $0.07 Professional. VM runtime is per vCPU-hour and GB-hour, plus $0.02/hour for a live screen. Snapshot storage is $0.05/GB-month after the first 10 GB/org. Starter is $20/month and Professional $200/month. | Browser SDK 0.1.5, desktop SDK 0.1.3, and sandbox SDK 0.1.4 declare Apache-2.0. Hosted usage is separate and credit-billed. The current integration launches billable environments; no live usage budget was confirmed. |
| Slack | Free is $0; the published Free plan allows up to 10 app integrations. Pro and higher plans are per-seat subscriptions. | No API-call fee was identified in the reviewed OAuth/messaging docs. Workspace plan, installation policy, and admin approval remain account-specific. |
| Jira Cloud | Free is available for up to 10 users with 2 GB storage; Standard/Premium are paid per user. | No REST-call fee was identified in the reviewed 3LO/REST docs. The Jira subscription and the authorizing user's project permissions govern access. |

## Slack and Jira OAuth

**Slack.** Slack’s v2 installation flow requires a user to approve requested scopes, then the backend exchanges a temporary code using the app client secret. The implementation stores one installation per CrewOS workspace, verifies slash-command signatures and timestamps, limits commands to configured channels and linked CrewOS managers, and queues later work. The current bot scopes match its behavior: `commands` for `/crewos`, `chat:write` for outbound status/notification messages. Register exactly `https://<APP_ORIGIN>/oauth/slack/callback` and `https://<APP_ORIGIN>/api/slack/commands`; the generated manifest uses the same paths. The bot must be invited to each approved channel. The current metadata says production `APP_ORIGIN` and Slack OAuth/signing credentials are absent.

Slack messages expose the command text to Slack and outbound task state/artifact links to configured channels. The runbook says notifications exclude private briefs and uploaded source documents. Verify channel selection, bot membership, account linking, and delivery from an isolated test workspace/channel. The current code does not implement Slack token rotation; the generated manifest explicitly disables it, so leave that app setting aligned unless rotation support is added.

**Jira.** Atlassian’s 3LO contract requires a redirect URI, code exchange at `https://auth.atlassian.com/oauth/token`, and `offline_access` to obtain refresh tokens. Those refresh tokens rotate: each refresh returns a replacement and invalidates the token just used. The code writes the new pair after refresh and serializes concurrent refreshes with a database lease. Jira REST v3 requests correctly use the `api.atlassian.com/ex/jira/{cloudId}/...` form. The current project search/create issue calls use the documented resource paths and classic `read:jira-work` / `write:jira-work` scopes. Atlassian scopes do not replace the authorizing user’s project permissions. Atlassian also says apps should be a single distributable 3LO app; avoid a flow that asks each CrewOS customer to collect API tokens or create their own one-off OAuth app.

Register exactly `https://<APP_ORIGIN>/oauth/jira/callback` and set the same value in the server configuration. Current metadata indicates the Jira OAuth client values and callback are absent. The 3LO consent belongs to the connecting Atlassian user; use a dedicated test account with only the test project permissions. Lost/revoked consent, token expiry, changed scopes, and a failed rotating-token persistence write can require a fresh OAuth connection; make that recovery visible in Settings.

## Minimal live acceptance checklist

Run these only in a non-production environment with the relevant account owner’s consent. Stop if the UI reports missing configuration or if a provider call would spend credits beyond the approved test budget.

1. **Neon:** Confirm the database/Auth pair and trusted HTTPS origin. Request a reset for a dedicated test account; receive the OTP; reset to a temporary password; sign in with it; confirm the previous password fails. Capture HTTP status/code and cookie/session behavior without recording secrets or OTPs.
2. **Solari browser:** Use one test profile and a test site that reveals only the signed-in test identity. Launch a profile-backed browser workflow, prove the saved login is active in the seeded context, then close it and verify the replay is reachable only to authorized CrewOS users and within expected retention. Test a private-IP URL and a redirect to a private host. Record that CrewOS’s DNS check is not a provider egress guarantee. Do not use a real account or enter secrets into recorded sessions.
3. **Solari sandbox and desktop:** Run the harmless echo and verify the sandbox is killed. If the current plan explicitly permits a desktop test, create one `workstation` desktop, verify its VNC stream and recording URL/replay, then pause or stop it and check the session is no longer running. Record actual plan/credit and cleanup results. Do not run if the required desktop entitlement or spend ceiling is unclear.
4. **Slack:** Configure the HTTPS app URLs and credentials, install the app into a dedicated test workspace with only `commands` and `chat:write`, link one CrewOS manager, approve one test channel, and issue `/crewos status <known-test-task>`. Verify the signed request is accepted, a forged/stale request is rejected, and the intended channel gets only the status/link. Remove the test channel grant or disconnect the test installation afterward.
5. **Jira:** Configure the callback and OAuth app, connect a least-privilege test account, select one disposable project, create one clearly marked test issue through the CrewOS flow, and verify the issue by reading it back from Jira. Refresh once with an expired/near-expiry token fixture or controlled test harness, verify the replacement refresh token is persisted, then reconnect after a deliberate test revocation. Delete the test issue only if the test owner has explicitly approved cleanup.
6. **Stitched path:** After the individual checks pass, submit one manager-authored test task via Slack that creates one test Jira issue, verify the CrewOS artifact matches Jira’s read-back, and verify the Slack notification contains only the approved result and link. Keep it out of production and do not use private company documents.

Until those checks run against the configured accounts, all provider-facing acceptance remains unverified. Local mocks, route tests, and a successful build are not live-provider evidence.

## Primary references

All links below are official provider/product documentation, accessed 2026-10-25.

- Neon [Authentication flow](https://neon.com/docs/auth/authentication-flow), [Customize emails](https://neon.com/docs/auth/guides/customize-emails), and [pricing](https://neon.com/pricing).
- Better Auth [Email OTP plugin routes](https://better-auth.com/docs/plugins/email-otp).
- Solari [Profiles](https://docs.getsolari.com/profiles), [Session recording](https://docs.getsolari.com/recording), [Network Access](https://docs.getsolari.com/network-access), [VM API](https://docs.getsolari.com/api-reference/desktops), [SDK feature matrix](https://docs.getsolari.com/sdk-capabilities), and [pricing](https://docs.getsolari.com/pricing).
- Slack [OAuth installation](https://docs.slack.dev/authentication/installing-with-oauth/), [request signing verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/), [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage), and [pricing](https://slack.com/pricing).
- Atlassian [OAuth 2.0 3LO](https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/), [rotating refresh tokens](https://developer.atlassian.com/cloud/oauth/getting-started/refresh-tokens/), [Jira REST v3 projects](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-projects/), [Jira REST v3 issues](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/), and [Jira licensing](https://www.atlassian.com/licensing/jira).
