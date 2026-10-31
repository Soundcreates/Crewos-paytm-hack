# Pilot deployment freshness

Date: 2026-10-25

## Finding

Pilot task assignment checked that an employee had a deployment for the current runtime, but it did not compare that deployment's policy revision with the workspace's current policy revision. A policy edit could therefore leave an old deployment authorizing another queued workflow. Tasks and approval resumes also needed to remain bound to the deployment that accepted them.

## Guard

Pilot work now passes one shared deployment preflight. It requires:

- Required probation for the employee's current spec, with passing evidence for the current runtime revision and policy revision.
- The latest deployment to match the current spec, runtime, policy revision, and the exact latest required probation run IDs.
- For an existing workflow, the deployment ID captured when that workflow was assigned to still be the latest valid deployment.

Assignment calls this check before inserting a workflow. Approval acceptance checks it in a short transaction before consuming the approval. External MCP input resumes use the same check before submitting the input. The worker checks it before task execution and again at the tool effect boundary, alongside the current policy decision and exact-action approval check. A task assigned under an older deployment stays blocked after a later redeployment; fresh work can use the new deployment.

HTTP, MCP, Slack, schedules, and background task submission share `createWorkflow`, so assignment checks apply to each path. Full mode keeps its existing simulation and per-action policy behavior; the pilot evidence requirement is only added when pilot mode is active.

## Concurrency

Assignment and deployment acceptance lock the workspace and employee rows while checking evidence and writing the accepted record. Policy creation, activation changes, and MCP-generated policy rules take the workspace lock too, so those database operations serialize with acceptance. Worker and resume checks use short database-only transactions and release their locks before provider calls. No database lock spans an external request.

## Regression evidence

`test/pilot-deployment-freshness.test.mjs` runs the HTTP and worker paths with controlled local model and Jira fixtures. It proves that a deployed pilot employee's queued workflow and an approval-resumed workflow are refused after a policy edit, a stale pending approval remains pending, no Jira effect runs, new assignment is rejected, and fresh probation plus redeployment permits new work.

The existing pilot Jira approval fixture now records the current spec and deployment IDs, matching what real workflow assignment stores.

Commands run:

- `npm run build:ts` — passed.
- `node --check backend/server.mjs && node --check backend/workflows/probation.mjs && node --check backend/src/controllers/employee-controller.mjs && node --check test/pilot-deployment-freshness.test.mjs` — passed.
- `node --test test/pilot-deployment-freshness.test.mjs test/pilot-jira.test.mjs test/pilot-runtime.test.mjs test/auth-api-flow.test.mjs test/hire-meeting-flow.test.mjs test/schedules.test.mjs test/crewos-release-schedules.test.mjs` — 32 passed, 0 failed.
- `npm run check:source` — passed.
