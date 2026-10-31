# CrewOS final handoff

- **Status date:** 2026-10-25
- **Branch:** `crewos/product-completion`
- **Product code checked:** `3131e20`
- **Documentation evidence current at handoff start:** `96314cb`

This handoff records verified local release and browser evidence without claiming full acceptance or production readiness. Detailed reports: [final verification](docs/reviews/final-verification.md), [populated browser acceptance](docs/reviews/populated-browser-acceptance.md), [UX review](docs/reviews/ux.md), [PostgreSQL acceptance](docs/reviews/postgres-acceptance.md), and [current progress](docs/reviews/progress.md).

## What the system does

**For managers:** CrewOS provides a React/Vite workspace to manage versioned AI employees, grant tools, run probation, deploy employees, assign and schedule tasks, approve guarded actions, inspect task evidence, manage knowledge, and hold meetings. Slack can submit and report task status when configured. Full mode supports manager-defined recurring schedules; pilot mode hides schedule management and skips due occurrences. Refund actions use a simulated ledger.

**Inside the service:** The Node API validates workspace authority and persists task/workflow state. Workers claim work with expiring leases and generation fences, run the LangGraph route, authorization, execution, and verification path, and persist attempts, checkpoints, approvals, and evidence. Tool effects recheck current grants and policy. PostgreSQL is the production database; SQLite with local password auth supports local development. Solari runs browser, desktop, and sandbox work. Jira and external MCP calls are handled through backend integrations. External MCP dispatch is deliberately blocked until a trusted operator verifier can independently check postconditions. Full-mode schedule occurrences enter the ordinary guarded workflow; missed intervals are coalesced and unfinished work is not overlapped.

## Setup, run, and checks

Use Node 22 for release checks and Python 3 for document extraction.

```sh
npm install
python3 -m pip install -r requirements.txt
npm run dev:backend
```

In another terminal run `npm run dev:frontend`. The API listens on port 4173; Vite listens on 5173 and proxies API/WebSocket traffic. Open `http://127.0.0.1:4173` for the API-served app or use Vite during development. See [README.md](README.md) for environment variables and provider setup.

The repository's documented release commands are:

```sh
npm run doctor -- --production
npm run check:release
docker build -t crewos:completion .
npm run test:postgres
```

The doctor is a static production-configuration check, not a provider or database probe. The PostgreSQL harness uses a disposable PostgreSQL 17 instance on an internal Docker network and a controlled local model fixture. It does not call paid providers. See [PILOT_RUNBOOK.md](PILOT_RUNBOOK.md) and [`test-postgres/README.md`](test-postgres/README.md) before production operations.

## Verified acceptance

| Area | Evidence | Scope |
| --- | --- | --- |
| Release checks at `3131e20` | `npm run check:release` passed in a clean archive inside Node `v22.23.4` / Python `3.12.15`: source validation, TypeScript/Vite builds, 215 Node tests, 2 Python extraction tests, and npm audit with 0 vulnerabilities. | Local CI-runtime container, not a hosted CI workflow. |
| Production image at `3131e20` | Built successfully from the exact code archive; image ID `sha256:f9979442402e8a08f165a1685a150323092b13ec47eddff15309a5e7573fff27`. | Image was not started or deployed. |
| PostgreSQL and service runtime | The PostgreSQL 17 harness and isolated `/api/health` 200, `/api/ready` 200, and graceful stop exit 0 passed on the production image built from `4967723`. It covered 16 migrations, two workers, 13 effects with no duplicates, approval resume after restart, and backup/restore. | Carried forward for `3131e20` because its backend, PostgreSQL harness, Dockerfile, and runtime configuration are unchanged. The new `3131e20` image itself was not runtime-probed. These results do not prove Neon or hosted recovery. |
| Settings and initial UX | Mounted Browser loaded final QA assets for source `3131e20`; direct Settings routes, keyboard activation, Back, and Forward worked. The DesignLead session also observed the signed-in shell, setup actions, skip link, Office tabs, employee wizard, and theme switching. | The DesignLead observation used a separate Personal-only session; it is not evidence that Director's Acceptance workspace lacked data. See [UX review](docs/reviews/ux.md). |
| Populated manager checks | Director's mounted Browser session showed CrewOS Acceptance / Support QA and an already deployed employee with existing 100% passing simulated probation evidence. The evidence dialog showed expected and observed `REQUIRE_APPROVAL` for the simulated refund scenario. Existing 60-minute schedule history showed six failed runs; edit prefilled its values, and cancel preserved the record. Opening the latest task showed assigned/failed activity and an explicit missing-OpenRouter-configuration message. A separate weekday 14:30 Asia/Calcutta schedule was created, paused, reopened, and saved after a name-only edit; cadence, timezone, and paused state persisted. | This was a bounded review, not a full manager journey. Probation/deployment were not rerun, the existing schedule and employee were left unchanged, and the new schedule remains paused. The task failure is not successful model execution. No actual payment or external provider call occurred. |

Exact evidence and observations are attributed in [`docs/reviews/populated-browser-acceptance.md`](docs/reviews/populated-browser-acceptance.md); do not broaden those checks into claims of successful model execution or full journey acceptance.

## Remaining work before a release decision

- **Production configuration:** The last recorded static doctor at `51ecc6b` failed on the public HTTPS origin, secure-cookie setting, distinct evaluator, and Jira callback. Current settings were not rechecked. Rerun the doctor using the intended release configuration.
- **Complete manager journey:** Verify workspace and invitation flows, source upload, employee compile/edit, fresh probation and deployment, successful provider-backed task, approval, verified evidence, and meeting follow-up. The browser pass inspected existing probation evidence and a provider-disabled task only.
- **Live identity and integrations:** Verify Neon Auth email/recovery, roles, and tenant boundaries; real Slack/Jira OAuth and actions; Solari browser/desktop lifecycle and replay plus effective provider-side egress control; and model/vector relevance and failure recovery.
- **External MCP:** Keep dispatch blocked until a trusted operator verifier and non-production read-back path are configured and independently validated.
- **Browser accessibility and viewport:** Check 320/375/768px layouts, overflow, touch targets, mobile dialogs, reduced motion, forced colors, rendered contrast, and populated-data screen-reader behavior. The mounted Browser had no viewport control.
- **Hosted operations:** Verify public TLS and health/readiness, hosted recovery duration, rollback, and deployment readiness. Local image/build checks do not establish these.

The earlier `FeatureRequiresPlan` result came from a client requesting stealth mode and does not establish a current plan requirement. No full production-ready claim is supported. Publishing, deployment, paid provider calls, and external test messages/issues require authorization.

## Recent coherent commits

- `96314cb` `docs: record populated browser acceptance`
- `bec6f53` `docs: close settings browser acceptance`
- `3131e20` `fix: keep settings navigation within sidebar viewport`
- `7a90909` `fix: resolve settings hash in every mode`
- `1d8d0ad` `docs: record final runtime release check`
- `4967723` `test: cover freshness and recovery lifecycle gates`
- `3202285` `docs: refresh current acceptance handoff`
