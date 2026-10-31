# Private pilot implementation update

The current pilot implementation supersedes historical prototype architecture and test-count claims below. Scope: support → Jira, native Slack task submission/status/notifications, and approvals inside CrewOS.

## Current branch ledger (2026-10-25)

The latest verified product code snapshot is `4967723`; later branch commits through `8379e3a` update documentation only. Full mode includes manager-defined calendar/interval schedules. Pilot mode hides schedule navigation and rejects schedule management; the worker advances a due cursor and records it skipped without dispatching. The focused schedule suite passes 8/8, including pilot toggling and worker defaults. Pilot assignment, approval resume, worker execution, and tool effects require current spec/runtime/policy probation evidence and the matching latest deployment; workflows pinned to older deployments remain blocked after redeployment, so managers must submit fresh work. This is bounded scheduled task submission, not persistent goals or event-triggered planning.

For code snapshot `4967723`, an isolated CI-style container on Node `v22.23.4` / Python `3.12.15` passed source/build checks, 215 Node tests, Python extraction tests (2/2), and npm audit (0 vulnerabilities). The production image built; disposable PostgreSQL 17 acceptance passed 16 migrations, two workers, 13 verified workflows/effects, zero duplicates, approval resume, and backup/restore. The image also passed isolated local `/api/health`, `/api/ready`, and graceful-shutdown checks with a disposable PostgreSQL database. These are local container checks, not hosted CI or deployment evidence. The last recorded static doctor at `51ecc6b` failed production configuration checks; current configuration was not rechecked. Exact commands, evidence, and remaining gates are in [`docs/reviews/progress.md`](docs/reviews/progress.md).

- [x] Correct root checkpoint lookup and validate approval recovery across a real process restart.
- [x] Fix undefined planner variables and the Solari session validator import; add JavaScript undefined-symbol checking.
- [x] Enforce tool-call limits and require verified action evidence before task completion.
- [x] Bind approvals to immutable actions; share consumption between HTTP and MCP.
- [x] Pin workflow spec/deployment versions, recheck authority, fence workflow/action writes, serialize employee claims, and expire approvals.
- [x] Add required pilot probation through the same graph with controlled adapters and policy-revision-bound deployment evidence.
- [x] Add Jira operation correlation, field read-back, reconciliation and dashboard artifact projection.
- [x] Add native Slack OAuth, explicit account linking, channel restrictions, signed/deduplicated commands and a retrying notification outbox.
- [x] Add separate API/worker entrypoints and durable dashboard jobs for uploads, simulations and meetings.
- [x] Add memory index/delete jobs, local-vector retention and whole-corpus lexical candidate lookup.
- [x] Reconcile meeting-action status and make runtime provisioning reservations recoverable.
- [x] Add production Compose, readiness checks, bounded shutdown, CI, backup/restore tools and a pilot runbook.
- [x] Validate disposable PostgreSQL migrations/jobs/memory/checkpoints, two worker processes, 13 workflows/effects with zero duplicates, approval resume, and backup/restore including overwrite refusal.
- [x] Build the production image and verify isolated local health/readiness, database/worker readiness, and graceful shutdown.
- [x] Run the release checks in an isolated Node 22/Python 3.12 container for code snapshot `4967723` (215 Node tests, 2 Python tests, audit 0).
- [ ] Complete live staging acceptance in PILOT_RUNBOOK.md: verified Neon identities/tenancy, real Slack/Jira OAuth and reconciliation, exact-revision populated browser journey, restore/rollback drills, and rollout. Local PostgreSQL multi-worker acceptance is complete; Neon and hosted recovery remain open.

Historical nine-phase scope follows. Local implementation is not evidence of passing live release gates.

# Report implementation checklist

Source: `deep-research-report (3).md`. Keep the full nine-phase scope active until every phase has implementation evidence.

## Active execution

- [x] Reconcile dashboard state after WebSocket reconnect (`b205194`).
- [x] Add manager-reviewed agent delegation with evidence and a normal guarded workflow (`f1bd278`).
- [x] Show verified task success rates per employee and cover the API/UI path.
- [x] Finish local report-scope audit; local build/tests pass, the core npm package passes `npm pack --dry-run`, and the remaining code/runtime gaps are documented below.
- [x] Move policy API data operations into a compiled TypeScript route module; preserve the existing HTTP/auth boundary and cover GET/create/update/invalid requests through the no-listener API test.
- [x] Move employee directory reads and per-employee task outcome aggregation into a compiled TypeScript route module; existing no-listener coverage verifies org scoping and success-rate values.
- [x] Move workspace overview aggregation and recent activity reads into a compiled TypeScript route module; the end-to-end request-handler check covers aggregate task outcomes.
- [x] Move Neon auth/session and secure-cookie helpers into compiled TypeScript while preserving the existing module imports; Neon URL/session and cookie tests pass through the compatibility shims.
- [x] Move OpenRouter planning, embedding, image-description, and transcription adapters into compiled TypeScript with typed response boundaries and a mocked-provider regression.
- [x] Move Jira OAuth and Jira Cloud API adapters into compiled TypeScript behind the existing module path; mocked OAuth coverage checks callback scopes, token exchange, and granted-site filtering.
- [x] Move the trusted MCP postcondition verifier loader into compiled TypeScript; existing checks cover named/default exports, invalid modules, and disabled configuration.
- [x] Move Solari browser-session validation and public-host DNS checks into compiled TypeScript; existing checks cover endpoint identity, unsafe destinations, and private IP ranges.
- [x] Move the SQLite/PostgreSQL SQL dialect translator into compiled TypeScript; focused checks cover placeholder conversion, quoted question marks, conflict handling, and identifier quoting.
- [x] Move AES-GCM integration-secret storage into compiled TypeScript behind the existing import; round-trip and authentication-tag tampering checks pass.
- [x] Move the CLI SDK HTTP client into compiled TypeScript behind its existing import; current checks cover Neon sign-in, cookie lifecycle, and Secure-cookie transport.
- [x] Move the manager-only recent-refund query into a typed API route helper; preserve the dispatcher RBAC check and cover results through the existing hire/meeting API flow.
- [x] Move Solari provider-usage session aggregation into a typed helper; keep org-scoped SQL reads in the dispatcher and cover source deduplication, timestamp ordering, and invalid IDs.
- [x] Move the MCP transport/discovery adapter (endpoint DNS pinning, JSON-RPC/SSE client, tools/list discovery, and Tasks-extension polling) into compiled TypeScript behind the existing import; the existing `mcp.test.mjs` and `mcp-transport-coverage.test.mjs` suites pass unchanged against the compiled module.
- [in_progress] Continue the broader backend TypeScript migration; the main API dispatcher, database persistence/migration layer, and Solari SDK execution adapter remain JavaScript ESM.
- [ ] Validate remaining service-backed behavior and finish the report's live demo/deployment gates.

## Current item: live service acceptance

- [x] Confirm Neon uses standard PostgreSQL URLs, branch-specific Managed Better Auth endpoints, and server-managed httpOnly session cookies.
- [x] Wire production PostgreSQL and app sessions to Neon while preserving local SQLite development and workspace RBAC; use transaction-scoped migration locks for Neon’s pooled connection and keep all `crewos_` app cookies out of Neon Auth requests.
- [x] Require both Neon URLs together and reject connection/Auth URLs that point to different Neon branches or databases.
- [x] Default app session and Jira OAuth cookies to `Secure` in production, while retaining local HTTP development support.
- [~] Validate sign-up, sign-in, session restore, invitations, sign-out, and protected API access against a live Neon branch. `npm run test:live` now exercises this against the configured live Neon branch: Postgres connectivity, a real `sign-up/email`, cookie-based session restore, the email-verification gate correctly blocking workspace creation and protected routes pre-verification, and sign-out clearing the session. Finishing a verified sign-in, invitations, and multi-workspace isolation against live Neon needs a real inbox to click the verification link Neon Auth sends (not scriptable) and is left for manual testing. Found and fixed along the way: `dev`/`start` never loaded `.env` at all (no `--env-file`), so no live credential took effect regardless of `.env` contents; and Neon Auth's trusted-origins check rejects `http://127.0.0.1:4173` but accepts `http://localhost:4173`, so local testing must use `localhost`, not `127.0.0.1`.

## Remaining acceptance gates

- [~] Neon: local PostgreSQL 17 migrations, worker concurrency, checkpoint restart, and restore pass in the disposable harness. Live Neon migrations/Auth/session/invitation flow and tenant isolation remain open; invitation and isolation require a verified second account with a real inbox.
- [~] Solari/Jira/OpenRouter/Pinecone: live browser and desktop actions, snapshot/pause/resume behavior, <2s launch/replay, source/retrieval quality, and provider usage/grade checks. Earlier live evidence reports an OpenRouter planner/embedding call, a Pinecone upsert/query, and a Solari sandbox launch/`echo` round trip; these were not rerun in this handoff. The earlier browser `FeatureRequiresPlan` failure came from a code version that requested `stealth: true`. Current Solari browser code sets `stealth: false` and the profile-context selection fix is committed (`fe41d4a`), so that old failure does not establish that a plan upgrade is required. The mounted-browser review at `5ebe584` saw only empty states and did not establish the served asset revision; final exact-assets/routes/populated-fixture acceptance remains open. Solari-side egress pinning or a proxy remains unresolved; sandbox command output still has no provider recording/replay evidence. Jira OAuth still requires interactive account consent and an authorized test project. The last recorded doctor at `51ecc6b` reported an empty Jira redirect; current configuration was not checked.
- [ ] External MCP: configure a trusted operator verifier module and validate postconditions against a live HTTPS server; outbound dispatch intentionally stays blocked until then.
- [ ] Runtime: broader live multi-host stress/recovery, final browser interaction review with populated fixtures, hire-to-meeting demo, and production deployment. The disposable PostgreSQL multi-worker/checkpoint/restore gate and isolated health/readiness/shutdown probe pass locally.

## Additional scope gaps found in report audit

- [x] Add manager-only, workspace-scoped snapshots, pause/resume, and restore for Solari sandbox and desktop environments. Snapshot references live with the environment metadata; local API coverage passes, while live provider acceptance remains open. The installed SDK exposes these lifecycle methods in the [TypeScript sandbox documentation](https://docs.getsolari.com/sdk/typescript/sandboxes).
- [ ] Sandbox command actions do not have provider recording/replay evidence: `solari.sandbox.echo` destroys its ephemeral environment after one command, and replay currently retains only input/output evidence.
- [ ] Reconcile the report's broad Solari isolation claim with execution: Jira API calls and outbound MCP requests currently run from the backend control plane, while browser, desktop, and sandbox tools run in Solari.
- [x] Clarify the "runs continuously" trigger contract. Full mode supports bounded manager-defined recurring task schedules through the normal guarded workflow path; pilot mode disables schedule navigation/management and skips due work. There is no persistent goal engine or event-triggered planner.

## Commit cadence

- [x] Inspect repository history; this worktree had no commits and all project files were untracked.
- [x] Commit local database, build output, and secret-file ignore rules (`aaf8281`).
- [x] Commit the research report, architecture, scope checklist, README, and demo guide (`0acf0dc`).
- [x] Commit the initial application baseline (Node API, React/Vite dashboard, TypeScript modules, and tests) as a focused code change.
- [x] Build the React/Vite dashboard; the full local test command also passes through the TypeScript and Vite production builds (31 Node tests).
- [x] Commit the policy and memory TypeScript migrations in the app baseline and commit the MCP guard and Jira/coworker UI follow-ups separately.
- [x] Update the architecture and README with the root-level Vite config, React entry point, and generated bundle path.
- [x] Maintain the requested atomic commit cadence; recent provenance, policy, browser, memory, and UI fixes are committed separately. Local SQLite data is ignored, and no environment file is tracked.

- [x] Read the report and inspect the starting worktree.
- [~] Phase 1: local auth, organizations, owner/admin/manager/member roles, ownership transfer, persistent entities, employee specs with manager-only soft archive, and the asynchronous PostgreSQL adapter are implemented. No-listener API flows cover signup, invitation roles, EmployeeSpec creation, role enforcement, and two-workspace data isolation; disposable PostgreSQL acceptance passes locally, while live Neon identity, tenancy, and hosted database acceptance remain open.
- [~] Phase 2: Solari browser open/read/interact, headless sandbox echo with exact requested-output and exit-code verification, desktop commands, profiles, policy tools, live view, browser replay, desktop recording replay, and manager-only sandbox/desktop snapshot, pause, resume, and restore flows are implemented. Failed browser interactions resolve replay to the nearest prior completed browser-open session in the same workflow. Browser URLs reject embedded credentials and non-HTTP schemes; navigation checks HTTP success; interaction verification requires a visible-text assertion after the final mutation. The provider re-resolves DNS after the local public-IP preflight, so browser egress pinning still needs a Solari-side control or proxy. Sandbox command replay and live provider behavior, interaction, and <2s launch/replay acceptance remain open.
- [~] Phase 3: planner, policy checks, executor, verifier, inbound/outbound audit events, external MCP connection registry/discovery, encrypted bearer tokens, schema validation, approval-first policies, simulated refund, Jira Cloud OAuth create/delete, database leases, bounded safe retries, per-step result persistence, reconciliation, adaptive browser replanning, and Jira UI read-back are implemented. Policy conditions reject malformed comparators and fail closed on unparseable thresholds; inbound `tasks/update` validates and forwards external tool input before resuming its workflow. A trusted operator ESM verifier can be configured for MCP dispatch; external tool calls and task input updates remain blocked in this worktree because no verifier module is configured. Browser/Jira, external MCP, and live policy acceptance remain open.
- [~] Phase 4: Pinecone retrieval, org namespaces, SQL ID/provenance lookup, all-record re-embedding backfill, durable indexing retries, typed source verification, authority ranking, org-scoped coworker relationship storage/UI, synchronized L5 coworker profiles, and success/failure episodic workflow outcomes are implemented. Workflow memories must match the stored goal/evidence and meeting memories must match the recorded agenda, decisions, actions, and transcript. Offline coverage verifies completed workflow outcomes are retrievable and meeting memory appears in a later participant brief; live retrieval quality remains open.
- [~] Implement multimodal memory with image descriptions/OCR and audio transcripts converted to source-labeled, searchable text through the existing document provenance and retrieval pipeline. Images/audio originals are not retained; video and Solari replay ingestion remain out of scope because the report does not define them. No-listener tests cover validation, missing credentials, mocked extraction, indexing, and deletion; provider accuracy still needs live acceptance.
- [~] Phase 5: PDF/DOCX extraction, LLM spec drafting, field-level source citations with excerpt and field-support validation, manager-edit provenance before first save, immutable versions, field-level edit diff, and evidence-backed ungranted tool recommendations exist. Edited draft fields lose stale citations and are labeled as manager input; save-time checks bind remaining document citations to same-workspace stored text and reject citations that do not support their assigned field. The editor shows field provenance before save and version diffs include manager, avatar, profile, and coworker fields. No-listener end-to-end coverage uploads a PDF job description and TXT SOP, compiles one spec from both, edits a responsibility, and verifies immutable version history; focused extraction checks cover PDF text and DOCX table ordering. Live LLM source quality and browser-level UI/version-history acceptance remain open.
- [~] Phase 6: single- and multi-action suite create/edit, policy scoring, AI scenario drafts, planner-driven execution for simulated refunds and Solari tools, policy-only external integration scoring for DENY/REQUIRE_APPROVAL, fresh Solari execution with a shared browser session, applied initial state/events, deterministic rubric checks, immutable suite snapshots, and scoped deterministic tool-failure injection are implemented. A no-listener regression checks ordered multi-action scoring, state-patch effects on policy input, and immutable v1/v2 run snapshots. Unsupported ALLOW actions are rejected and no ALLOW action passes without verified execution or an explicitly observed injected failure. A no-listener API flow runs the $1,000 refund vs $500 approval scenario and deploys only after a pass; external MCP execution and Solari evidence/replay acceptance remain open.
- [~] Phase 7: office layout, coworker directory, live activity states, desktop viewing/replay, meeting-room view, participant movement, activity animations, manager room/desk assignment, aggregate and per-employee task success-rate display exist; WebSocket reconnect now refreshes the active view to recover missed invalidations. The mounted review observed the empty shell and Office tabs only; populated browser behavior remains unverified. The separate local service health/readiness/shutdown probe passed.
- [~] Phase 8: scheduling, private briefs sent only to each participant's independent model request, source-grounded pre-meeting agent discussion, typed agent messages and delegation requests, manager-reviewed task creation through the normal policy gate, persisted in-meeting state, structured positions, decisions, action items, bounded meeting context in follow-up goals, and memory exist. Per-operation leases recover stale preparing/discussing/in-meeting states after a crash. The meeting memory row commits atomically with completion and follow-up actions under a stable meeting-derived ID; vector embedding/indexing runs afterward as best effort. A no-listener fault-injection check confirms a failed memory insert rolls back completion and leaves the meeting retryable. Member reads omit private briefs and searchable memory includes bounded in-meeting turns; live provider-driven cross-agent execution remains open.
- [~] Phase 9: tool/token analytics, configurable model cost estimates, internal Solari call/session/launch proxies, manager-visible provider-billed Solari session usage, a Node SDK/CLI, and optional distinct-model grading exist. Automated skill retraining is optional in the report and deferred. The report specifies cost optimization as Solari usage stats, covered by the usage dashboard and cost visibility. No-listener workflow coverage verifies the grader uses a different model and receives the verified tool evidence; live provider usage/grade, broader hosted stress, demo, and deployment evidence remain open.

## Report technology alignment

- [~] LLM-independent EmployeeSpec, policy evaluation, simulation, meeting, memory-helper, tool-validation, and workflow-progress modules are in the standalone `solari-crew-core` npm workspace under `lib/`; frontend and backend import that package by name. The dashboard overview/employee directory, policy API data operations, Solari usage session aggregation, Neon auth/cookie helpers, OpenRouter and Jira adapters, MCP verifier loader and transport/discovery adapter, Solari browser-session and DNS guards, SQL dialect translator, encrypted integration-secret storage, CLI SDK client, memory engine, and policy engine are also compiled TypeScript modules under `backend/src/`; the main API dispatcher, database persistence/migration layer, and Solari SDK execution adapter remain JavaScript ESM.
- [~] PostgreSQL support exists and is now required for production; SQLite remains the local-development default. The report's structured-data path is PostgreSQL; disposable PostgreSQL schema, two-worker, checkpoint restart, and restore acceptance pass locally, while live Neon tenancy and hosted concurrency acceptance remain open.
- [~] The leased database queue supplies durable workflow behavior in place of Temporal, as allowed by the plan's “Temporal or similar” wording. PostgreSQL worker restart/concurrency acceptance passes locally; browser session reattachment and live restart acceptance remain open.
- [~] Dashboard uses React in a standard Vite workspace under `frontend/`; production build passes, while browser interaction acceptance remains to be verified.
- [~] Office view now renders through native Canvas 2D, with manager drag/resize/edit, reduced-motion handling, live movement, and keyboard/screen-reader directory controls; browser-level interaction acceptance remains open.

These are implementation-scope items, not just documentation differences. Keep them open until the corresponding architecture is implemented and verified.
- [x] Add local launch and scope documentation in `README.md`.
- [x] Implement manager-only, read-only live desktop viewing.
- [x] Show a read-only, refreshed screenshot of an active workflow browser to same-workspace managers; retain the recorded replay after task completion.
- [x] Derive office avatar activity from active workflows, approvals, and prepared meetings.
- [x] Render prepared meetings in the office and move participants into the configured meeting/review room.
- [x] Generate pre-meeting agent messages from each participant’s own brief, with evidence filtering and per-participant idempotency.
- [x] Turn meeting actions assigned to active employees into policy-gated workflows and link those workflows back to the action items.
- [x] Generate one-tool policy scenario drafts from an employee’s granted tools; let managers review and edit the draft before saving.
- [x] Show field-level before/after changes while a manager edits an employee spec.
- [x] Animate office avatars by activity and glide them between desks and meeting rooms on live refresh.
- [x] Connect Jira Cloud through CSRF-bound OAuth, encrypt and rotate refresh tokens, select an authorized project, and route issue create/delete through the policy-gated executor and verifier.
- [x] Populate Jira settings from authorized sites/projects and let managers edit/delete human coworker profiles; deletion is org-scoped, preserves AI-linked profiles, and cascades coworker relationships.
- [x] Execute allowed Solari simulation actions in a fresh browser, sandbox, or desktop; expose browser replay through manager-only evidence links.
- [x] Have the employee planner propose each scenario action before scoring it; record planner mode, exact input match, and unexpected extra actions.
- [x] Index every memory type in Pinecone by organization namespace with employee filtering, durable retries, SQL/local fallback, indexed-state visibility, and an all-record re-embedding backfill.
- [x] Run JavaScript syntax checks on the server, library modules, and browser app.
- [x] Claim workflow execution with database leases, bounded worker concurrency, heartbeats, and stale-lease recovery; preserve step-level reconciliation to prevent replaying uncertain external actions.
- [x] Let only the current workspace owner transfer ownership to another member; atomically demote the previous owner to admin and record the transfer.
- [x] Convert all database callers to async while keeping SQLite support and adding PostgreSQL schema/pool support.
- [x] Review cross-dialect SQL, transaction boundaries, async callbacks, and error handling; disposable PostgreSQL 17 runtime acceptance now passes locally, while live Neon acceptance remains open.
- [x] Add bounded, delayed recovery for read-only retryable workflow steps while keeping uncertain side effects behind reconciliation; runtime recovery evidence remains open.
- [x] Enforce a single workspace owner in the database and make invitation acceptance and concurrent ownership transfer atomic; reviewed and syntax-checked, with runtime concurrency acceptance pending.
- [x] Add the report’s employee/task success percentage to the overview dashboard; implementation is syntax-checked, with runtime acceptance pending.
- [x] Complete manager-only add/edit/delete, drag, and resize controls for office rooms and desks; implementation is syntax-checked, with runtime acceptance pending.
- [x] Close the simulation code gaps for applied initial state/events, deterministic rubric scoring, and reproducible suite versions.
- [x] Extract probation rubric decision matching into a typed helper and fail closed on negated criteria such as “not ALLOW”; tests cover the $1,000 refund escalation at the $500 approval limit.
- [x] Add memory source verification and authority-aware retrieval ranking; typed document/workflow/meeting claims are checked against org-scoped records.
- [x] Add org-scoped coworker relationship persistence with manager-only CRUD and directory display.
- [x] Include L5 coworker profiles and relationship summaries in task context lookup; retrieval quality still needs runtime validation.
- [x] Synchronize an AI coworker’s name, role, expertise, and mission/responsibilities summary whenever its EmployeeSpec is versioned.
- [x] Add manager-only soft archive for employees, preserving immutable spec/history and preventing new simulation, deployment, or live-task use.
- [x] Suggest catalog-valid tools from cited source excerpts without granting them; manager-selected EmployeeSpec grants remain authoritative.
- [x] Feed browser observations into bounded continuation planning, revalidate tool grants, and keep policy/approval checks on every generated action.
- [x] Verify Jira issue creation through the browser by reading back the visible issue key through the authorized Jira API.
- [x] Reuse and close one browser context per simulation run so browser interactions can follow browser opens; accept replay links from open and interact evidence.
- [x] Persist desktop recording URLs server-side and expose manager-only stopped-session replay redirects without returning signed URLs in the environment list.
- [x] Persist an `in_meeting` state while the moderator runs, recover failed meetings to briefing, and pass bounded, explicit agenda/position/decision context to queued follow-up tasks.
- [x] Add per-operation meeting leases and stale-state recovery so a process crash does not leave a meeting permanently unclaimable; migration and no-listener API flow cover all three in-progress meeting states.
- [x] Assign office desks to employees through manager UI and show their assigned positions when idle; meeting position takes priority.
- [x] Report Solari call, session, and launch timing proxies as internal usage, separate from provider-billed cost.
- [x] Keep document memory passages within the exact text stored for their source, including the 500,000-character ingestion cap.
- [~] Register public HTTPS MCP servers per workspace, encrypt optional bearer tokens, discover and validate schemas, pin discovery/cancellation requests to checked public DNS results, and default new tools to manager approval. Trusted operator ESM verifier loading and per-action preflight/postcondition hooks are implemented; dispatch stays blocked before network access until a verifier module is configured and externally validated.
- [~] Reject malformed or unsupported external MCP argument schemas; manager input validation and verifier-gated task input updates are implemented, but live external task acceptance remains open.
- [x] Bound retrieved memory in planning and meeting contexts, label procedural memories for planning, and give external tool schemas a compact planner representation; runtime retrieval quality remains open.
- [x] Measure Solari launch timing at environment/browser/sandbox creation instead of including later page or command execution.
- [x] Add a configured Solari browser-interaction exercise alongside the existing Jira API tool to the demo guide; execution still needs Solari/Jira setup.
- [x] Persist verified workflow step results alongside the resume cursor so a recovered worker preserves prior evidence in the completed result.
- [x] Add focused policy, transaction, refund-precision, memory provenance, workflow recovery, meeting assignment, Solari usage response, external MCP schema/DNS-guard/dispatch-blocking, simulation rubric, sample EmployeeSpec draft/provenance, and EmployeeSpec contract tests.
- [x] Exercise multi-action simulation scoring, applied `state.patch` policy context, and immutable suite/run snapshots through the no-listener request handler.
- [x] Exercise signup, manager/member invitations, role-gated EmployeeSpec creation, logout, protected API access, and Solari provider-usage tenant scoping through the request handler without listening on a port or starting the app.
- [x] Exercise offline text-document upload, source-grounded EmployeeSpec compilation, $1,000/$500 probation, deployment, two-agent meeting preparation/discussion, persisted decisions, two concurrent manager-assigned follow-up workflows, and two-workspace read isolation through the request handler without listening on a port or starting the app.
- [~] Local no-listener request-handler end-to-end coverage passes; hosted service and concurrency acceptance remain open.
- [x] Add and pass a no-listener concurrent-workflow check using only the internal simulated refund tool; the live multi-process concurrency run has not been performed.
- [x] Require the guarded stress runner to observe at least two simultaneously working workflows before reporting concurrency acceptance; its live run remains open.
- [x] Refresh the active dashboard view when its live WebSocket reconnects, so changes missed during a disconnect are reconciled from the API.
- [x] Show each employee’s completed-task percentage and resolved-task count in the team directory; count only completed/failed workflows and keep the metric blank when no task has resolved.
- [x] Add typed agent messages and delegation requests with evidence IDs; managers can decline a request or create a normal policy-gated workflow for its deployed recipient. Offline request-handler coverage verifies evidence persistence, workflow linkage, duplicate-response rejection, and a verified delegated refund.
- [x] Add a reproducible hire-through-meeting manual demo guide; the source report references an MVP demo section but does not define its scenario.
- [x] Document the as-built architecture and identify where the implementation differs from the report's proposed stack.
- [x] Move final normalized EmployeeSpec construction into a typed TypeScript runtime module and add a focused contract/build check; broader backend TypeScript migration remains open.
- [x] Store failed workflow outcomes and attempted tool/status summaries as episodic memories; validate failure source against the org-scoped failed workflow and recorded reason.
- [x] Give the independent evaluator a separate bounded memory reference slice; memories can clarify terminology but cannot serve as proof.
- [x] Let managers reassign unstarted meeting actions from inactive employees to a deployed employee before creating follow-up workflows.
- [x] Let managers add an explicit follow-up action to a completed meeting when the generated discussion has no action items; assign only active employees with an EmployeeSpec.
- [x] Document the recorded Solari desktop command demo and the provider limit on headless sandbox playback.
- [x] Allow simulations to include connected external integrations for DENY/REQUIRE_APPROVAL policy-only scoring; reject external ALLOW actions, require execution evidence before an ALLOW pass, and never invoke external MCP side effects during probation.
- [x] Restrict probation ALLOW execution to simulated refunds, bounded sandbox echo, public browser reads, and read-only browser assertions; simulation browser contexts block non-GET/HEAD requests and desktop commands.
- [x] Verify simulation planner parsing with a mocked valid tool plan and a mocked out-of-grant plan; invalid planner output fails closed without invoking Solari.
- [x] Add a focused PDF extraction regression test alongside the DOCX table-order test.
- [x] Exercise the Phase 5 gate with both a PDF job description and TXT SOP, manager responsibility edit, provenance, and saved version history.
- [x] Exercise the independent evaluator through a queued workflow; assert the distinct grader model receives verified tool evidence and returns a persisted score.
- [x] Run the Python PDF/DOCX extraction regressions as part of `npm test` and declare their parser dependencies in `requirements.txt`.
- [x] Document every direct runtime environment variable in `.env.example`, including the required same-branch Neon database/Auth pair and optional provider settings.
- [x] Confirm the standalone `solari-crew-core` package contents with `npm pack --workspace solari-crew-core --dry-run`; compiled ESM and declarations are included and no archive was published.
- [x] Document the guarded multi-workflow stress runner and expose its concurrency/polling parameters in `.env.example`.
- [x] Retrieve provider-billed Solari usage only for browser session IDs recorded in the requesting workspace, using the per-session usage endpoint; tests prove two workspaces cannot query each other's sessions.
- [x] Bound and test parsing of Solari provider usage responses while preserving the vendor payload.
- [x] Keep provider-billed Solari usage scoped to workspace-owned per-session IDs and bound each dashboard lookup to 25 sessions.
- [x] Verify Neon Auth proxy requests strip all app-owned `crewos_` cookies, including Jira OAuth state.
- [x] Verify failed browser interactions replay the recorded session from the latest earlier browser-open step in their own workflow.
- [x] Verify sandbox echo requires both a successful exit code and the requested output, and that edited EmployeeSpec draft fields receive manager-input provenance before save.
- [x] Create a fresh deterministic probation suite when an existing EmployeeSpec changes mission, responsibilities, capabilities, tool grants, policies, or evaluation policy; no-listener coverage runs the new suite against the edited spec version.
- [~] Historical local report check: 120 Node tests, TypeScript/Vite production build, and two Python extraction tests passed on an earlier snapshot. This count and the old Solari stealth-plan explanation are superseded by the current ledger above. `npm run test:live` remains opt-in and account-dependent; no live provider call was made in this handoff.
- [~] Audit report scope against local implementation and build evidence. Live runtime evidence remains open for Neon, Solari/Jira, Pinecone, external MCP verification, multi-process concurrency, the hosted demo, and deployment.

Historical live-test notes: earlier runs report Neon sign-up/session-restore/sign-out and the pre-verification gate, OpenRouter planner/embedding, Pinecone upsert/query, and Solari sandbox launch/command. They are not current-run evidence. Open acceptance includes verified Neon sign-in, invitation and tenant isolation; Solari browser/desktop and egress control; Jira consent and issue read-back; external MCP postconditions; retrieval quality; complete browser demo; and hosted rollout/recovery. The current Solari client no longer requests stealth mode, so repeat browser acceptance before assigning an account-plan blocker. See `test-live/README.md` for the opt-in checks and [the current progress handoff](docs/reviews/progress.md) for this branch's local results.
