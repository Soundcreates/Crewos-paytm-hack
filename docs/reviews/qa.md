# Independent QA report

Date: 2026-10-25

Branch: `crewos/product-completion`

Original QA review HEAD: `c7915d8`

Environment: Node 26.8.2, Python 3.13.14. The release check ran with a clean environment and no `.env` file or provider credentials.

## Current evidence refresh (2026-10-25)

The latest product code checked is `3131e20`. An isolated CI-style container with Node `v22.23.4` and Python `3.12.15` passed `npm run check:release`: source validation, TypeScript/Vite builds, 215 Node tests, 2 Python extraction tests, and npm audit with 0 vulnerabilities. The production image built from that exact archive but was not started. PostgreSQL 17 acceptance and isolated health/readiness/shutdown passed at `4967723`; [`final-verification.md`](final-verification.md) confirms the backend, PostgreSQL harness, and runtime image configuration are unchanged at `3131e20`, so this evidence carries forward for those parts only. The new image itself was not runtime-probed.

These are local container checks, not a hosted CI run or deployment. Current production configuration was not checked; the static doctor result below is historical. Director's separate mounted-browser session inspected CrewOS Acceptance / Support QA on product source `3131e20`; its bounded employee/schedule results are in [`populated-browser-acceptance.md`](populated-browser-acceptance.md). DesignLead's Personal-only session is a different fixture and does not contradict that report. The populated browser pass still does not establish a complete manager journey, successful model-backed task, mobile/accessibility behavior, live Neon, provider/integration acceptance, trusted MCP verification, or deployment readiness. Do not mark the product fully accepted or production ready.

## Earlier handoff rerun at `51ecc6b` (2026-10-25)

At that earlier handoff, product HEAD was `51ecc6b`; source changes were committed and the unrelated `docs/.DS_Store` was untracked. `docker build -t crewos:completion .` passed from the repository's Node 22 Dockerfile. `npm run test:postgres` passed on disposable PostgreSQL 17: 16 migrations, two workers, 13 workflows and verified effects, zero duplicate effects, approval checkpoint resume, and backup/restore. `node --test test/crewos-release-schedules.test.mjs` passed 8/8, including full/pilot/full behavior and pilot worker skip semantics. The Python extraction suite passed 2/2.

At `b2f5ab3`, `npm run check:release` found three failures in `test/doctor-public-origin.test.mjs`; commit `51ecc6b` fixes that validation. The rerun at `51ecc6b` passed the source check, builds, Python tests, all 204 Node tests, and `npm audit --audit-level=high` with 0 vulnerabilities. That historical rerun used host Node 26.8.2/Python 3.13.14. The later isolated Node 22/Python 3.12 validation is recorded above; neither run establishes that a hosted CI workflow executed.

`npm run doctor -- --production` ran its build and static checks at `51ecc6b` without database or provider calls and exited 1. At that time it marked configuration not ready because the origin was not an acceptable public HTTPS origin, `COOKIE_SECURE=false`, no distinct evaluator was configured, and the Jira callback was empty. Jira client ID and secret metadata were reported present and Slack unconfigured; credential values were not read or printed. This is a historical snapshot. Current production configuration was not rechecked; run the doctor against the intended release settings before a deployment decision.

## Status reconciliation (2026-10-25)

The original QA run did not execute the PostgreSQL harness. Subsequent evidence in [`postgres-acceptance.md`](postgres-acceptance.md), independently reviewed by Verifier, records `npm run test:postgres` passing on a disposable PostgreSQL 17 instance with two workers, one approval resume, one schedule occurrence, and backup/restore. That later evidence supersedes earlier documentation that marked the PostgreSQL status failed/open. It clears the local PostgreSQL acceptance gate, not live Neon acceptance.

The earlier release checks and PostgreSQL acceptance were reported passing while separate product changes remained uncommitted. This original QA run reviewed `c7915d8`; the historical rerun above covers committed product HEAD `51ecc6b`. The later `4967723` CI-runtime, image, PostgreSQL, and local runtime checks are summarized at the top of this report. Live Neon identity and recovery, live model/provider and integration behavior, current production configuration, and the complete browser journey remain unverified.

Commit `a31250a` disables schedules in pilot mode through navigation, service/API management, and worker dispatch; full mode retains them. The focused schedule suite passes 8/8. Commit `b2f5ab3` adds current pilot deployment evidence checks for assignment, approval resume, worker execution, and tool effects. The live full-mode schedule UI journey remains unverified.

## Result

At code snapshot `3131e20`, the isolated Node 22/Python 3.12 release gate and production-image build pass. PostgreSQL 17 and isolated service-runtime checks pass at backend snapshot `4967723` and carry forward because those files are unchanged; the new image was not started. Director's mounted Browser verified the bounded populated checks described above, while full manager acceptance remains open. Hosted CI execution, current production configuration, real Neon email verification/password recovery, live provider/model execution, mobile/accessibility, and the complete browser journey remain open, so this is not full release acceptance.

## Checks run in the original QA snapshot (`c7915d8`)

| Command | Result |
| --- | --- |
| `node --test test/crewos-release-schedules.test.mjs` | Passed: 6 tests, 0 failures. |
| `node --test test/config-check.test.mjs test/frontend-auth-api.test.mjs` | Passed: 4 tests, 0 failures. |
| `env -i PATH="$PATH" REQUEST_TRACE=false npm_config_userconfig=/dev/null npm_config_cache=/tmp/crewos-qa-npm-cache npm run check:release` | Passed with exit code 0. Source check, TypeScript builds, Vite build, Python tests (2 passed), Node tests (164 passed, 0 failed, 0 skipped), and `npm audit --audit-level=high` (0 vulnerabilities). |

The first authoring run of `node --test test/crewos-release-schedules.test.mjs` failed 3 of 6 cases because the test expected a valid same-tenant create to fail and did not clean up fixture state after that assertion stopped early. I corrected the tenant expectation and added cleanup; the final rerun of the same command passed 6 of 6. These were test setup failures, not reproduced application defects.

Vite emitted dependency warnings that `"use client"` directives in Framer Motion and Radix modules were ignored during bundling. The build completed successfully. The test output also emitted two Solari `close()` billing warnings. The exercised Solari tests use mocked provider transports and mock WebSocket sessions; this sanitized run loaded no provider credentials.

## Original schedule regressions (six cases)

`test/crewos-release-schedules.test.mjs` covers:

- Local 09:00 recurrences through both New York DST transitions, leap February, and the following non-leap month end.
- Cross-tenant list, history, update, pause, delete, and employee ownership boundaries, plus member denial.
- Concurrent edits with the same revision: one succeeds and the stale writer gets `409 stale_schedule`.
- A paused employee: the due run is skipped with an explicit reason, then dispatch resumes after redeployment.
- A deleted creator membership: the schedule pauses; a current manager can resume and take responsibility.
- Thirty-six hours of missed intervals and three concurrent scheduler polls: one occurrence is dispatched, missed work is coalesced, and the next run proceeds after the previous workflow completes.

## Findings by severity

1. **PostgreSQL local acceptance passed after this QA run:** see [`postgres-acceptance.md`](postgres-acceptance.md) for the command, environment, and output. Neon remains unverified.
2. **No new reproducible schedule bug found** in the six SQLite regressions or existing schedule suite.

## Reviewed changes and remaining proof

- Neon Auth errors now preserve structured code, HTTP status, and request reference; offline tests cover `EMAIL_NOT_VERIFIED`, same-origin reset calls, cookies, and rejected reset codes. Actual Neon verification and recovery email delivery, OTP expiry, and password reset acceptance remain unverified.
- `PasswordReset` uses the same-origin Neon Auth proxy and provides retry and error paths. No live provider flow was attempted.
- `config-check` tests run offline and check that fake secret values and database URL components are not returned. The doctor command recorded at `51ecc6b` printed only check statuses and no credential values, and found that snapshot's configuration not ready as summarized above.
- The new `frontend-resilience` test verifies the `ViewBoundary` alert fallback and first password-reset screen render. It does not exercise a forced browser render failure, retry, navigation recovery, or a real Neon reset email/OTP flow.
- The original QA `check:release` runs used host Node 26.8.2 and Python 3.13.14. The later isolated Node 22/Python 3.12 release validation and image build pass for code `3131e20`; PostgreSQL and service-runtime evidence carry forward from unchanged backend code `4967723`. Hosted CI execution is not evidenced. The current populated-browser report verifies bounded employee/schedule paths; the complete journey, mobile/accessibility, and live provider acceptance remain open.
