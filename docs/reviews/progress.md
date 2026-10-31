# CrewOS current progress handoff

- **Date:** 2026-10-25
- **Branch:** `crewos/product-completion`
- **Documentation HEAD at handoff start:** `96314cb`
- **Latest product code checked:** `3131e20` (`fix: keep settings navigation within sidebar viewport`)

Read [`FINAL_HANDOFF.md`](../../FINAL_HANDOFF.md) for the concise setup, architecture, test commands, current acceptance, and remaining gates. This status reconciles [`final-verification.md`](final-verification.md), [`populated-browser-acceptance.md`](populated-browser-acceptance.md), and [`ux.md`](ux.md). The untracked `docs/.DS_Store` was left untouched.

## Current acceptance

**Release suite and production image:** A clean archive of product code `3131e20` passed `npm run check:release` inside an isolated Node `v22.23.4` / Python `3.12.15` Docker image. The source check, TypeScript and Vite builds, 215 Node tests, 2 Python extraction tests, and npm audit (0 vulnerabilities) passed. The production image also built from that archive. These are local CI-runtime checks, not a hosted CI run or deployment. The newly built `3131e20` image was not started.

**PostgreSQL and isolated runtime:** The PostgreSQL 17 harness and health/readiness/graceful-shutdown probe were run against the production image built from code `4967723`. They passed 16 migrations, competing schedulers, two workers, 13 workflows/effects with no duplicates, approval resume after worker restart, backup/restore with overwrite refusal, `/api/health` 200, `/api/ready` 200, and graceful stop exit 0. The exact `3131e20` release report confirms backend, PostgreSQL harness, and image configuration are unchanged from `4967723`, so these results carry forward for those components. They are not a runtime probe of the newly built `3131e20` image, nor live Neon or deployment evidence. See [`final-verification.md`](final-verification.md) and [`postgres-acceptance.md`](postgres-acceptance.md).

**Mounted browser:** Director's populated Browser session loaded product source `3131e20` at `http://localhost:4186/?acceptance=team-review`, serving `/assets/index-DZDHajG4.js`. It showed CrewOS Acceptance with Support QA: the employee was already deployed and had existing 100% passing probation evidence; the review inspected that evidence but did not rerun probation or deployment. The reviewer opened existing 60-minute schedule history and task detail, where the task was failed because OpenRouter was not configured in that QA session. A separate weekday 14:30 Asia/Calcutta schedule was created, paused, reopened, and saved after a name-only edit; the final row retained the cadence, timezone, and paused state. The original schedule and employee were unchanged. The new schedule remains paused. This verifies a bounded populated manager flow and schedule round trip, not the complete product journey or successful model execution. See [`populated-browser-acceptance.md`](populated-browser-acceptance.md).

DesignLead's separate Browser session showed the empty Personal workspace; that session-specific fixture boundary does not contradict Director's populated CrewOS Acceptance session. The final QA assets also passed Settings direct-load, keyboard activation, Back, and Forward checks; see [`ux.md`](ux.md).

## Setup and run

- Use Node 22 for release work. Install with `npm install` and `python3 -m pip install -r requirements.txt`.
- For local development, run `npm run dev:backend` and `npm run dev:frontend` in separate terminals. The API uses port 4173; Vite uses 5173.
- Production requires a public HTTPS `APP_ORIGIN`, matching Neon `DATABASE_URL` and `NEON_AUTH_BASE_URL`, `APP_MASTER_KEY`, a model configuration, secure cookies, and a distinct evaluator. Keep credentials out of reports.
- The last static `npm run doctor -- --production` result was at `51ecc6b` and failed for origin, secure-cookie, evaluator, and Jira-callback settings. Current production configuration has not been checked; rerun the doctor with the intended release settings.

## Verification commands

| Command or check | Recorded result |
| --- | --- |
| `npm run check:release` | Passed for archive `3131e20` inside isolated Node 22.23.4/Python 3.12.15 image: 215 Node tests, Python 2/2, audit 0. Not hosted CI. |
| `docker build --progress=plain -f "$CONTEXT/Dockerfile" -t crewos:verify-image-3131e20 "$CONTEXT"` | Passed for archive `3131e20`; image ID `sha256:f9979442402e8a08f165a1685a150323092b13ec47eddff15309a5e7573fff27`. Image not started. |
| `CREWOS_ACCEPTANCE_IMAGE=crewos:verify-image-4967723 REQUEST_TRACE=false npm run test:postgres` | Passed at the earlier backend/runtime snapshot: PostgreSQL 17, 16 migrations, 2 workers, 13 effects, no duplicates, approval restart, and backup/restore. Backend and harness are unchanged at `3131e20`. |
| Isolated local runtime probe | Passed on the `4967723` production image: health and ready 200, worker/database ready, graceful shutdown exit 0. Carried forward only because the runtime is unchanged; current `3131e20` image was not started. |
| `npm run doctor -- --production` | Historical result at `51ecc6b`: static checks, exit 1. Current production config remains open. |

See [README.md](../../README.md), [PILOT_RUNBOOK.md](../../PILOT_RUNBOOK.md), and [`test-postgres/README.md`](../../test-postgres/README.md) for setup, operations, and harness details.

## Remaining gates

- Complete a full manager journey with a successful provider-backed task: workspace/invite, source upload, employee compile/edit, fresh probation/deployment, task assignment and approval, verified evidence, and meeting follow-up. The browser run inspected existing probation evidence; it did not rerun it. The recorded task failed at the provider-disabled boundary.
- Validate mobile widths, horizontal overflow, touch targets, dialog scrolling, reduced motion, forced colors, rendered contrast, and populated-data screen-reader behavior. The mounted Browser had no viewport control.
- Recheck current production configuration. The doctor result at `51ecc6b` is historical, not a statement about present configuration.
- Complete live Neon Auth/email/recovery/invitations/roles/tenant isolation; Slack and Jira OAuth/actions; Solari browser/desktop/session/replay and effective egress control; model/vector relevance and provider recovery.
- Keep external MCP dispatch blocked until a trusted operator verifier and non-production read-back path are configured and validated. Hosted readiness, public TLS, recovery timing, rollback, and deployment readiness remain open.
- Do not mark the product fully accepted or production ready, and do not deploy or call paid providers without the required authorization.

## Recent coherent commits

- `96314cb` `docs: record populated browser acceptance`
- `bec6f53` `docs: close settings browser acceptance`
- `3131e20` `fix: keep settings navigation within sidebar viewport`
- `7a90909` `fix: resolve settings hash in every mode`
- `1d8d0ad` `docs: record final runtime release check`
- `4967723` `test: cover freshness and recovery lifecycle gates`
- `3202285` `docs: refresh current acceptance handoff`
