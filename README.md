# CrewOS

AI employee workspace for versioned roles, policy-gated tasks, probation, memory, and meetings. The private pilot adds native Slack task submission and verified Jira artifacts.

See [PILOT_RUNBOOK.md](PILOT_RUNBOOK.md) for production configuration, Slack installation, required probation, recovery, and live release gates. Production runs separate API and worker processes with PostgreSQL and enables the restricted pilot tool set by default.

See [FINAL_HANDOFF.md](FINAL_HANDOFF.md) for the current verified release/browser evidence, run and check commands, and remaining configuration, live-service, accessibility, and deployment gates.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the as-built stack and its differences from the research proposal.

## Run with Docker

With Docker Compose installed, start the app and its persistent local PostgreSQL database with:

```sh
docker compose up --build
```

Open `http://127.0.0.1:4173`. Compose builds the Vite frontend and serves it from the Node backend. The default local stack uses a named PostgreSQL volume and local password authentication; Compose waits for `pg_isready` before starting the app, and the app healthcheck waits for database plus combined API/worker readiness. The development-only database URL and password are internal to the Compose network and the database port is not published. `docker compose down` keeps data; `docker compose down -v` deletes it. For the simpler SQLite path, use `docker compose -f compose.sqlite.yaml up --build`; it persists data in its own named volume. Direct `npm start` also keeps SQLite as its default.

Development PostgreSQL without Neon Auth is accepted only when `NODE_ENV=development` and the database hostname is on CrewOS's local-host allowlist (`postgres` for Compose). Production still requires a branch-matched Neon `DATABASE_URL` and `NEON_AUTH_BASE_URL`; any non-Neon or public Postgres URL without that pair is rejected. Copy `.env.example` to `.env` for local overrides. Redis/Kafka/Temporal are not used. Pinecone remains optional external memory infrastructure; local SQL and lexical retrieval work without it. Artifacts in this tranche are immutable local records in the database; there is no object-store service or S3 endpoint to configure. Keep V2 and signed local webhook fixtures disabled unless explicitly enabled for a named test organization.

## Optional Shopify store connection

Shopify authorization stays unavailable unless the server has `APP_MASTER_KEY` (at least 24 characters), `SHOPIFY_API_KEY` or `SHOPIFY_CLIENT_ID`, `SHOPIFY_API_SECRET` or `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_OAUTH_CALLBACK_URL`, and a supported quarterly `SHOPIFY_ADMIN_API_VERSION`. Register the exact public HTTPS callback URL `https://<your-app-host>/api/commerce/v2/shopify/oauth/callback` in the Shopify app. A manager can connect an exact `*.myshopify.com` store; CrewOS requests the app's configured product, inventory, order, location, publication, and theme scopes, verifies the store through an Admin API read-back, and stores the credential through its org-scoped encrypted connection service. The Shopify authorization endpoints remain blocked when any required server setting is missing. Do not put Shopify credentials in browser variables. Live catalog writes, theme publishing, and provider webhooks remain unavailable pending their separate operation, approval, and reconciliation gates. Theme changes may require a Shopify exemption.

The Node OAuth helpers use Shopify's official `@shopify/shopify-api` package, while catalog GraphQL transport remains on `@shopify/admin-api-client`. The Shopify API package supports Node 22+, matching this project's runtime. CrewOS retains ownership of manager authorization, organization/store/environment bindings, and credential persistence; the SDK's session object is used only for the verified OAuth exchange and identity read-back. Outside `PILOT_MODE`, a manager in an explicitly V2-enabled organization can read a bounded, paginated product catalog from a ready verified connection; the server resolves its encrypted credential per request and independently checks the returned store identity. Live writes remain unavailable.

## Run locally

- Node.js 22.5 or newer
- Python 3 for PDF and DOCX extraction
- OpenRouter key for model features; Solari key only for live browser/desktop/sandbox sessions
- An Atlassian OAuth 2.0 (3LO) app for Jira issue actions

The project has three npm workspaces: `frontend/` contains the React/Vite app, `backend/` contains the Node service and its database/provider adapters, and `lib/` is the reusable core package. The frontend follows Vite's standard `index.html`, `src/`, and `public/` layout. For hot reload, run `npm run dev:backend` and `npm run dev:frontend` in separate terminals; Vite listens on port 5173 and proxies API and WebSocket traffic to the backend on port 4173. `npm run build` builds all three workspaces, and the backend serves the production assets from `frontend/dist/`. The report allows React or Next.js, so this project uses React with Vite.

`lib/` is the standalone `solari-crew-core` workspace package. It contains LLM-independent EmployeeSpec, policy evaluation, simulation scoring and verification, meeting context, memory and media helpers, MCP/browser input validation, and workflow progress logic. It has no runtime dependencies and makes no database, network, or model calls. The frontend and backend already import it by package name; after publishing, another project can use `import { evaluatePolicy } from 'solari-crew-core'`. Package source and build instructions are in [lib/README.md](lib/README.md).

```sh
npm install
export APP_MASTER_KEY="$(openssl rand -base64 32)"
npm start
```

## Backend request tracing

The backend writes structured JSON log lines to stdout by default. Each HTTP response includes an `x-request-id` header that matches its logs. The trace records route dispatch, auth and cookie-presence checks, body size and parsing, database operation/table and duration, provider calls, and employee workflow steps. It does not log request bodies, cookie values, credentials, or provider responses. For Docker, follow the app logs with `docker compose logs -f app`. Set `REQUEST_TRACE=false` to turn off the detailed trace events.

Open `http://127.0.0.1:4173`. Local development uses `./data/crewos.sqlite` and local password auth by default; set `DATABASE_FILE` to choose another SQLite file. For production, create a Neon project, enable Managed Better Auth on the database branch, then set `DATABASE_URL` to that branch's pooled PostgreSQL connection string and `NEON_AUTH_BASE_URL` to its full Auth endpoint (ending in `/auth`). Production startup requires both values. To use Neon locally, set the same branch-matched pair while keeping `NODE_ENV=development`; leaving both blank uses SQLite and local password auth. The database adapter supports Neon’s transaction-mode pooler, including migrations. `DATABASE_POOL_MAX` sets the PostgreSQL pool size (default 10). Leave `APP_ORIGIN` blank for local use; set it to the deployed app origin behind a reverse proxy. Session cookies use `Secure` automatically in production and on direct HTTPS; set `COOKIE_SECURE=true` behind a TLS-terminating proxy when running outside production. Add each app origin to Neon Auth's trusted domains and configure its email verification and delivery settings. The app proxies auth requests through its own origin, forwards Neon Auth cookies without the app session cookie, validates Neon Auth sessions server-side, then maps the verified identity to the app's workspace memberships and roles. See [.env.example](.env.example) for the variable names. Live Neon database and auth acceptance still needs a configured branch. Integration keys saved in the app require `APP_MASTER_KEY` (at least 24 characters) to encrypt them. For production, alternatively set `SOLARI_API_KEY` and `OPENROUTER_API_KEY` in the server environment. Development LLM calls use `DEV_LLM_API_KEY` as described below. Solari SDK packages are installed by `npm install`.

All model requests go through [`backend/lib/llm-provider.mjs`](backend/lib/llm-provider.mjs). During development (`NODE_ENV=development`), the client routes chat, tool calling, embeddings, image understanding, transcription, and evaluator requests to the OpenAI-compatible local endpoint using `DEV_LLM_API_KEY`; it never sends those requests to OpenRouter. When running Node directly on the host, `DEV_LLM_BASE_URL` defaults to `http://127.0.0.1:8317/v1`. Docker Compose sets the container's URL to `http://host.docker.internal:8317/v1`, because the container's `127.0.0.1` is its own loopback; set `DEV_LLM_CONTAINER_BASE_URL` to override that URL. Use the `DEV_LLM_*_MODEL` variables for IDs supported by the local endpoint. Production and test environments keep using OpenRouter through `OPENROUTER_API_KEY` or the encrypted workspace integration, with model IDs configured by `OPENROUTER_*_MODEL`. Solari is a separate integration: `SOLARI_API_KEY` is needed only for live Solari browser, desktop, and sandbox sessions. Existing encrypted OpenAI keys are preserved but marked for replacement; add an OpenRouter key in Settings for production use. Replace `OPENAI_API_KEY` in an existing production `.env` with `OPENROUTER_API_KEY`.

Direct public search tasks use the TinyFish Search API through `TINY_FISH_API_KEY`. Grant `tinyfish.search` to employees that need public web, news, or paper search. An existing `solari.browser.open` grant also exposes TinyFish search as a narrower compatibility grant; read-only research workflows only receive TinyFish tools. Tasks that need sustained website UI work or an authenticated site use Solari's workflow-scoped browser session and the employee's saved Solari profile; the session is reused across tool calls and is released when the workflow finishes. Managers can click **Setup** on an employee record to create that employee's saved browser profile and assigned desktop VM. After setup, sign in to required sites through the Solari profile editor so later browser tasks can reuse the saved login state. See the [TinyFish Search API](https://docs.tinyfish.ai/search-api) and [Solari Sessions](https://docs.getsolari.com/sessions) documentation.

See [MVP_DEMO_GUIDE.md](MVP_DEMO_GUIDE.md) for the local hire-through-meeting flow and optional recorded Solari desktop/browser exercises.

Install the Python parsers to extract uploaded PDF and DOCX files:

```sh
python3 -m pip install -r requirements.txt
```

`npm test` runs both Python document-extraction checks and the Node suite; it builds TypeScript and the dashboard first and does not start the app server.

## Release checks

Run `npm run doctor -- --production` to check production configuration before a release. It performs static checks only: no database connection or provider request is made, and output reports status without exposing credential values. It reads `.env` when that file exists, so use the normal secret-safe environment handling for that file.

Run `npm run check:release` on Node 22 to validate source imports, build the workspaces and dashboard, run Python and Node tests, and check npm advisories with `npm audit --audit-level=high`. This command does not include the PostgreSQL acceptance harness.

For the isolated PostgreSQL check, first build the Node 22 image with `docker build -t crewos:completion .`, then run `npm run test:postgres`. The harness creates a disposable PostgreSQL 17 container on an internal Docker network, uses a controlled local model fixture, and removes its containers and network when finished. See [`test-postgres/README.md`](test-postgres/README.md) for prerequisites, outputs, and limits. Passing local checks does not establish live Neon or provider acceptance.

The latest release suite and production image build use product code `3131e20`: an isolated CI-style container on Node `v22.23.4` and Python `3.12.15` passed `npm run check:release` (215 Node tests, 2 Python tests, audit 0). The new production image was built but not started. PostgreSQL 17 and isolated health/readiness/graceful-shutdown checks passed on image code `4967723` and carry forward because backend/runtime files are unchanged at `3131e20`; they are not a runtime probe of the new image. The populated Browser review verified a limited employee/schedule flow and Settings routes, not the complete manager journey or successful model-backed execution. These results are local evidence, not hosted CI or deployment. Current production configuration, live Neon and provider checks, trusted MCP verification, viewport/accessibility, and deployment readiness remain open; see [`FINAL_HANDOFF.md`](FINAL_HANDOFF.md) for exact scope.

The server binds to `127.0.0.1:4173` by default. Set `HOST`, `PORT`, and `APP_ORIGIN` when placing it behind a reverse proxy. Set `DATABASE_FILE` if the default local database path is unsuitable. `NEON_AUTH_BASE_URL` is branch-specific, so point each preview or staging deployment at the Auth endpoint paired with its `DATABASE_URL`.

## Scope

For Jira Cloud, configure an Atlassian OAuth 2.0 (3LO) integration and set `ATLASSIAN_OAUTH_CLIENT_ID`, `ATLASSIAN_OAUTH_CLIENT_SECRET`, and `ATLASSIAN_OAUTH_REDIRECT_URI` on the server. The callback URL must end in `/oauth/jira/callback`; request the `read:jira-work`, `write:jira-work`, and `offline_access` scopes. Workspace admins then connect Atlassian and choose a project in Settings. Jira issue deletion remains policy-gated.

Workspace admins can register external MCP servers in Settings. Endpoints must use HTTPS and resolve only to public addresses; optional bearer tokens are encrypted with `APP_MASTER_KEY`. Discovered tools become employee grant options and receive a manager-approval policy by default. External MCP calls and task input updates stay blocked before dispatch unless the server operator sets `MCP_VERIFIER_MODULE` to a trusted ESM file exporting `canVerifyMcpPostcondition(context)` and `verifyMcpPostcondition(context)`. The first function must return `true` only for tools with a configured verifier, before any request is sent. The second receives the org, connection, tool, input, result, goal, and expectation; it must independently check the external postcondition and return `{ verified: true, evidence }` only when the read-back matches. The module runs as trusted server code and may receive the connection bearer token; never point it at workspace-supplied code. A missing, failed, or negative verifier keeps the workflow unverified, and remote read-only hints do not count. Task cancellation remains available for already-running tasks. MCP protocol requests and responses are recorded in the workspace event log.

The optional concurrency check is `node backend/scripts/stress-workflows.mjs --confirm-simulated-workflows`. Against a running test service, it creates up to `STRESS_WORKFLOW_COUNT` one-dollar simulated refund workflows, polls at `STRESS_POLL_INTERVAL_MS`, and requires observing at least two workflows in `working` state at once; it does not call a payment processor. Set `CREWOS_URL`, `CREWOS_EMAIL`, and `CREWOS_PASSWORD`, and review the created audit records afterward.

For complete vector memory search, set `PINECONE_INDEX_HOST` and `PINECONE_API_KEY` to a Pinecone dense index configured with cosine similarity and the same dimensions as the configured embedding model (the default `text-embedding-3-small` uses 1536). Each organization is stored in its own Pinecone namespace. `npm run memory:migrate` queues every existing memory for re-embedding and indexing; keep `DATABASE_FILE` pointed at the SQLite database being migrated and run a worker to process the queue. SQL remains canonical, with lexical/local-vector retrieval available while Pinecone or the embedding provider is unavailable. See [Pinecone index targeting](https://docs.pinecone.io/guides/manage-data/target-an-index) and its [production guidance for tenant namespaces](https://docs.pinecone.io/guides/operations/moving-to-production).

Managers can also index supported images and audio through the existing document flow. OpenRouter converts images to descriptions/OCR text and audio to transcripts; only that source-labeled text and its MIME type are retained and indexed. Original media is not stored. Video and Solari replay ingestion are not supported.

The Reports dashboard estimates OpenRouter token cost when `PROVIDER_PRICING_JSON` is set to a JSON object keyed by `provider/model`, with `inputUsdPerMillion` and `outputUsdPerMillion` rates. Example: `{"openrouter/openai/gpt-4o-mini":{"inputUsdPerMillion":0,"outputUsdPerMillion":0},"openrouter/openai/text-embedding-3-small":{"inputUsdPerMillion":0,"outputUsdPerMillion":0}}`. Replace zeroes with the rates for your provider account. These estimates apply the configured rates to recorded token usage and mark models without configured rates; they are not invoice totals. Managers can view Solari-reported usage for up to 25 recent browser sessions recorded in their workspace, separately from OpenRouter estimates.

The Node SDK is exported from `backend/lib/client.mjs`; `CrewOSClient` provides authenticated methods for organization identity, employee creation/listing, simulation runs, and workflows. The `crewos` CLI uses the same API. Set `CREWOS_URL`, `CREWOS_EMAIL`, and `CREWOS_PASSWORD`, then run `node ./backend/bin/crewos.mjs me` (or install the package to use the `crewos` executable). The SDK detects local or Neon Auth, keeps the provider and workspace session cookies for the request, then signs out and closes the session after each CLI invocation. In Neon mode, use a verified Neon Auth account that already belongs to a workspace.

To exercise bounded workflow concurrency against a running CrewOS service, deploy at least two test employees whose only granted tool is the simulated `payments.refund` tool, then set `CREWOS_URL`, `CREWOS_EMAIL`, `CREWOS_PASSWORD`, and optionally `STRESS_WORKFLOW_COUNT` (2–64). Run `node ./backend/scripts/stress-workflows.mjs --confirm-simulated-workflows`. It creates $1 simulated refund tasks, requires observed overlap between at least two working workflows, waits for terminal states, and emits a JSON evidence summary; no payment provider is called. The check writes simulated refund and audit records to that workspace.

To independently grade verified workflow outcomes, set `DEV_LLM_EVALUATOR_MODEL` in development or `OPENROUTER_EVALUATOR_MODEL` in production to a model distinct from the configured chat model. Grades use the task goal, role metrics, and verifier evidence; they are recorded with workflow results and do not replace deterministic policy or execution verification. Evaluator failures do not change task completion.

The EmployeeSpec compiler stores provenance by field. Model citations are kept only when the source name belongs to the selected notes/documents and the quoted excerpt occurs in that source; uncited draft fields are marked as unattributed, and manager edits replace stale citations for the fields changed.

`payments.refund` is a policy-gated simulated tool for exercising the workflow path against a stub ledger. It records an org-scoped simulated refund, verifies the stored amount and case, and never calls a payment processor or moves funds. Managers can review entries through `GET /api/refunds` or the SDK/CLI (`client.refunds()` / `crewos refunds list`).

This is a local MVP. It polls a database-backed workflow queue with bounded concurrency, expiring worker leases, and crash recovery. Meeting preparation, discussion, and orchestration also use expiring leases and recover stale states after a process crash. SQLite leases coordinate processes sharing one file and remain a single-host option; the disposable PostgreSQL 17 harness verifies two workers and recovery locally, while live Neon and multi-host acceptance remain open. Evaluation runs ask the employee planner to propose scenario actions. ALLOW actions execute only through the simulated refund ledger, bounded sandbox echo, public browser reads, or read-only browser assertions, and must have verified evidence; unsupported ALLOW actions are rejected. Simulation browser requests allow only GET/HEAD traffic, and Jira/MCP actions are policy-only during probation. Live validation of simulation evidence and replays remains open. Managers can open a read-only live view of running desktop sessions and refreshed screenshots of active workflow browsers. Full mode includes bounded recurring task schedules; pilot mode excludes them. Schedules submit ordinary guarded workflows and do not implement an open-ended goal engine or event-triggered planner. The current mounted-browser evidence covers Settings routes and a bounded populated employee/schedule flow, but not the full manager journey or successful model-backed tasks. Pinecone retrieval quality, Solari usage statistics, live integrations, production configuration, mobile/accessibility, and deployment gates also remain to be verified. Do not expose the prototype directly to the public internet.

## Private pilot interfaces

- `POST /api/employees/:id/probation` runs the required ReAct suite with controlled adapters; pilot deployment requires a current passing run.
- `POST /api/workflows` accepts `Idempotency-Key`. Each task pins its deployment/spec version.
- `POST /api/workflows/:id/approve` requires the pending `approvalId`; MCP `tasks/update` accepts the same ID.
- `POST /api/workflows/:id/reconcile` verifies an uncertain Jira operation before resuming.
- Long operations accept `Prefer: respond-async` and return `jobId`; poll `GET /api/jobs/:id`. Reports exposes failed jobs and retries.
- Native Slack installation is under `/api/slack`; signed slash commands arrive at `/api/slack/commands` and OAuth returns to `/oauth/slack/callback`.
- `GET /api/health` reports liveness; `GET /api/ready` checks the database and worker heartbeat.

`npm run check:source` catches undefined JavaScript symbols alongside the TypeScript build. CI runs source checks, production builds, Python/Node tests, and a Docker build. Provider-backed staging acceptance remains required before onboarding real teams.
