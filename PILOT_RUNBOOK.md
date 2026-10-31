# CrewOS private pilot

The pilot supports a versioned support employee that creates verified Jira issues, accepts work through Slack, and produces auditable meeting follow-ups. Set `PILOT_MODE=true`. Production enables pilot mode by default. Browser/desktop tools, Jira deletion, external MCP actions, and real payments are outside this pilot. Refund tools remain explicitly simulated.

See [`FINAL_HANDOFF.md`](FINAL_HANDOFF.md) for the current release and mounted-browser evidence and the remaining live, configuration, viewport, and deployment gates.

## Production configuration

Use Node 22 and Python dependencies from `requirements.txt`. Configure a public HTTPS `APP_ORIGIN`, a matching Neon `DATABASE_URL` / `NEON_AUTH_BASE_URL` pair, `APP_MASTER_KEY`, an OpenRouter chat model, and a distinct evaluator model. Enable Neon email verification and trusted origins. Set Atlassian OAuth credentials and its redirect to `APP_ORIGIN/oauth/jira/callback`. Run `npm run doctor -- --production` against the intended release configuration; it checks statically without connecting to the database or providers and never prints credential values. The last recorded doctor at `51ecc6b` exited 1 for an invalid/non-public HTTPS origin, `COOKIE_SECURE=false`, no distinct evaluator, and an empty Jira callback. This is historical configuration evidence, not a check of current settings; rerun the doctor before deployment review.

Run `docker compose -f compose.production.yaml up --build -d`. Terminate TLS at the reverse proxy. The API binds to the host loopback interface; the worker runs separately against PostgreSQL. Local `compose.yaml` retains the development setup. For separate host processes, run `npm run build`, then `npm run start:api` and `npm run start:worker`.

`/api/health` is liveness. `/api/ready` requires a responsive database and a worker heartbeat within 15 seconds. Poll readiness from the deployment monitor. The Reports screen shows background jobs, retry counts, and delivery/indexing errors. Both processes drain for up to 30 seconds on SIGTERM; the container grace period is 40 seconds. An interrupted external write is reconciled rather than blindly repeated.

Database migrations run under the existing PostgreSQL migration lock. The current schema is migration 16; application data and graph checkpoints remain in PostgreSQL. Deploy API and worker from the same image. Do not roll back to a binary that cannot read the current migration history; use the matching previous database snapshot for a full rollback.

## Slack setup

1. Generate an app manifest with `APP_ORIGIN=https://your-app.example node backend/scripts/slack-manifest.mjs` and create a Slack app from that JSON.
2. Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET` on API and worker. The callback is `/oauth/slack/callback`; the command URL is `/api/slack/commands`. Required bot scopes are `commands` and `chat:write`.
3. As a workspace administrator, open Integrations → Slack app → Connect Slack. Each Slack team belongs to one CrewOS workspace.
4. Configure approved channel IDs in CrewOS and invite the bot to those channels. An empty list disables commands and notification delivery.
5. In an approved channel, run `/crewos link`, follow the private link, sign in, and click **Link my Slack account**. Linking requires membership in the installation's workspace. Task commands require current manager access.
6. Submit `/crewos run <employee-id> <goal>` or `/crewos status <task-id>`. Requests are signed, persisted, and deduplicated before acknowledgement. Model and Jira work run in the worker. Approvals open CrewOS; Slack does not approve actions.

Slack notifications contain task status, CrewOS links, and verified artifact links. They do not contain private briefs or uploaded source documents. Delivery uses a retrying outbox and honors rate-limit delays. Delivery retries can still produce duplicate Slack messages after an ambiguous network failure; external message delivery is not guaranteed exactly once. Review failed deliveries in Reports and retry after correcting bot permissions or reconnecting Slack.

## Jira and probation

Connect Jira through Integrations and choose the authorized project. Hire an employee from the SOP and grant `jira.create_issue`. Run **required probation** from the employee record. It uses the same ReAct graph with controlled adapters for success, approval, rejection, denial, and provider failure. It never creates live Jira issues. A configured model is required in pilot mode.

Deploy requires the latest required suite to pass for the current spec and policy revision. Pilot workflows record their spec/runtime and accepted deployment ID. Changing a spec or policy makes old pilot evidence stale: assignment, approval resume, worker execution, and tool effects remain blocked until required probation passes again and the employee is redeployed. Existing workflows pinned to the older deployment remain blocked after redeployment; submit fresh work. Restrictive current policies and current employee/manager authority are checked again before each effect. Full mode keeps its existing deployment contract. See [`docs/reviews/deployment-freshness.md`](docs/reviews/deployment-freshness.md) for focused regression evidence.

For a live task, Jira creation writes a stable operation label. Verification independently reads project, summary, description and operation label. Verified artifacts appear in the dashboard. A lost response or uncertain outcome enters **reconciliation required**. Use **Reconcile Jira** to search for and verify that operation. A manager may also POST an `issueKey` to `/api/workflows/:id/reconcile`; it must match the recorded operation and fields. If no matching issue is visible, the action remains blocked. Investigate or cancel; automatic retries do not create another issue.

API clients should send `Idempotency-Key` when submitting tasks. Approvals must include the current `approvalId`; HTTP and MCP use the same single-use approval record. Approval records expire after 24 hours. Cancelling does not undo a provider request already sent; inspect the external operation before assigning replacement work.

## Background operations and recovery

The dashboard submits document uploads, simulations and meeting operations with `Prefer: respond-async`; the API returns a job ID and a `/api/jobs/:id` location. The client polls that job. Job execution rechecks membership. Completed upload payloads are removed from job storage. Imports use stable document and passage IDs, and indexing/deletion run as separate durable jobs.

The Reports screen lists recent jobs. Failed jobs can be retried with their original immutable input. A conflicting idempotency key returns 409. Memory retains local embeddings and lexical retrieval if the vector service is unavailable; indexing failures remain visible and retry. Lexical candidates are searched across stored knowledge rather than only the newest records. Vector deletion uses a tombstone job and never rehydrates a deleted SQL record.

Meeting operations retain their existing leases and atomic completion/memory transaction. Linked workflow completion updates the action item. Recurring meeting execution is not included; `starts_at` records the intended time, and a manager starts the operation. Manager-defined task schedules exist in full mode and remain excluded from pilot mode. Full-mode occurrences enter the ordinary guarded workflow path. Missed intervals are coalesced, and a due occurrence is skipped while a prior task is unfinished; pilot workers record and skip due occurrences without dispatching tasks.

## Backup and restore

Run `sh backend/scripts/backup-postgres.sh /secure/path/crewos.dump` with `DATABASE_URL` supplied by the secret manager. Back up the encryption key separately; database backups alone cannot decrypt integration tokens. Use the hosting provider's point-in-time recovery as well.

For a recovery drill, create an empty PostgreSQL database or Neon branch, point `DATABASE_URL` at it, then run `sh backend/scripts/restore-postgres.sh --confirm-empty-database /secure/path/crewos.dump`. The script refuses a nonempty public schema. Configure the corresponding Neon Auth endpoint and verify membership, a task snapshot, and a memory query before redirecting traffic. Record restore duration and data-loss window in the deployment record.

## Release acceptance

Local automated checks cover graph recovery across a real process restart, hard tool limits, outcome verification, required Jira probation, immutable task submission, exact approval binding, stale pilot deployment rejection across assignment/approval/resume/execution, mocked Jira read-back/artifact projection, Slack signature/replay checks, command deduplication, job isolation, background imports, schedule recurrence and pilot-mode skip behavior, password-reset request flow, and the page-level render-error fallback.

## Local release gate commands

Run these against the same source snapshot you plan to release:

```sh
npm run doctor -- --production
npm run check:release
docker build -t crewos:completion .
npm run test:postgres
```

`check:release` checks imports, builds the workspaces and dashboard, runs Python and Node tests, and then runs `npm audit --audit-level=high`. The PostgreSQL harness uses the Node 22 image, a disposable PostgreSQL 17 container, an internal Docker network, and a controlled local model fixture; it makes no paid provider calls. See [`test-postgres/README.md`](test-postgres/README.md). A successful local harness does not prove live Neon behavior or release readiness by itself.

For code `3131e20`, an isolated Node `v22.23.4` / Python `3.12.15` image passed `npm run check:release`: 215 Node tests, 2 Python extraction tests, and npm audit with 0 vulnerabilities. The production image built but was not started. PostgreSQL 17 acceptance and isolated `/api/health`, `/api/ready`, and graceful-shutdown checks passed on image code `4967723` and carry forward because the backend/runtime are unchanged; they are not checks against the new image. Director's mounted-browser review at `3131e20` used the populated CrewOS Acceptance / Support QA session and verified existing probation evidence plus a bounded schedule create/pause/reopen/name-only-save flow. It did not rerun probation/deployment or demonstrate successful model execution. These local checks do not establish hosted CI, live Neon behavior, public TLS routing, production configuration, or deployment readiness. Mobile viewport and broader full-journey acceptance remain open.

Before inviting pilot teams, record these live staging results:

- Verified Neon owner and second-user invitation, sign-in, sign-out, role revocation and two-workspace isolation.
- Real Slack OAuth, channel permission failure, account linking, task submission, and notification delivery.
- Real Jira OAuth and project selection; create/read-back one marked test issue, then deliberately interrupt a worker after dispatch and reconcile the same operation.
- Rerun Solari browser and desktop acceptance with the current `stealth: false` client and saved profile. An earlier `FeatureRequiresPlan` response came from code requesting stealth mode and does not establish that a paid plan upgrade is needed. Verify browser launch, profile persistence, recording/replay, lifecycle controls, and an effective provider-side egress boundary before relying on these tools.
- Run two workers against the same PostgreSQL database and confirm exclusive claims and stale-worker fencing. The disposable PostgreSQL 17 harness passed these local checks on backend code `4967723`; repeat if backend/runtime code changes and verify separately against the target Neon/staging configuration.
- Complete hire → probation → deployment → Slack task → Jira artifact → meeting follow-up in a browser. The current populated review inspected an existing deployed employee and evidence but did not hire, rerun probation/deployment, or demonstrate a successful model-backed task.
- Pass production readiness monitoring, controlled shutdown, database restore, and rollback drills.

Local mocks and successful builds do not establish these live gates. The bounded browser pass does not complete the end-to-end manager journey, verify successful model-backed tasks, or test mobile/accessibility behavior. Browser/desktop provider acceptance, external MCP verifiers, the remaining full-mode schedule lifecycle, and public SaaS onboarding remain separately tracked work. Pilot mode excludes recurring schedules; do not describe them as unavailable product functionality in full mode.

## Local validation record

The earlier 141-test and browser checks below are historical evidence, not certification of the current source snapshot. Current release and PostgreSQL evidence is recorded in [`docs/reviews/qa.md`](docs/reviews/qa.md) and [`docs/reviews/progress.md`](docs/reviews/progress.md).

A disposable PostgreSQL 17 container passed all 16 application migrations, durable job deduplication/execution, memory retrieval, concurrent schedule polling, and PostgreSQL-backed approval checkpoint resume. Two worker containers completed 13 simulated tasks with exactly 13 tool runs and 13 simulated refunds, with zero duplicate effects. Backup/restore recovered all 13 workflows, 13 refunds, and one schedule run; a second restore into the populated target was refused. The current rerun is recorded in [`docs/reviews/postgres-acceptance.md`](docs/reviews/postgres-acceptance.md). These are local PostgreSQL results, not managed Neon or live-provider acceptance.
