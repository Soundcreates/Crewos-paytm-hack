# PostgreSQL acceptance

Date: 2026-10-25

## Change

LangGraph PostgreSQL setup now runs under a transaction-scoped advisory lock on one pinned client. The runtime creates the checkpoint migration ledger before calling the SDK, because the SDK's missing-table recovery catches `42P01` but leaves an enclosing PostgreSQL transaction aborted. All SDK migrations remain inside the transaction, so setup failures roll back the ledger and schema changes together. Initialization retries up to four times for transient PostgreSQL and network errors; permanent schema and permission failures surface immediately. Failed checkpointer initialization clears the cached promise so a later call can retry.

## Local evidence

- `node --test test/postgres-checkpoint-setup.test.mjs`: 4 passed. Covers fresh and existing ledgers, rollback on permanent failure, bounded transient retry, and wrapped connection errors.
- `docker build -t crewos:completion .`: passed. The image builds with Node 22 and the production TypeScript/Vite build.
- `npm run test:postgres`: passed against a fresh disposable PostgreSQL 17 container on an internal Docker network with a controlled local model fixture and no paid provider calls.

Acceptance output:

```text
{"migrations":16,"queued":12}
{"competingSchedulers":"pass","occurrences":1}
{"workers":2,"completed":13,"verifiedRefunds":13,"toolRuns":13,"duplicateEffects":0,"checkpointTables":4,"model":"controlled local fixture"}
{"postgresCheckpointRestart":"input_required","effects":0}
{"postgresCheckpointRestart":"completed","effects":1}
{"backupRestore":"pass","workflows":13,"refunds":13,"scheduleRuns":1,"overwriteRefused":true}
```

The first checkpoint process stopped at manager approval without executing the effect. A separate process resumed the checkpoint, completed approval, and recorded exactly one effect. Restore reproduced all 13 workflows, 13 simulated refunds, and the single schedule run; a second restore into that non-empty database was rejected.

## Remaining verification

This validates local PostgreSQL behavior and transaction-pooling-compatible setup structure. It does not validate a live Neon account or prove the behavior against Neon itself; that gate remains open.

## Current-code PostgreSQL and runtime follow-up (2026-10-25)

The follow-up ran with branch HEAD `00d656cc677c40a0515be5216dd5045591b50d9a`. The production image was `crewos:verify-image-4967723` (`sha256:dd739679bce618f547f69e2e67840189af700c564a646a36efb7638b5e548da6`), built from code commit `4967723fbcdb6868e0bc04f45eada0a224164e57`. The subsequent `5ebe58457166c7036614ae24ad95f30e1ae96cd7` commit added the mounted-browser UX report and screenshots only; the `backend`, `frontend`, `lib`, `test-postgres`, and package files are identical to the image source. Thus the tested product source matches the current branch product source.

Command:

```sh
CREWOS_ACCEPTANCE_IMAGE=crewos:verify-image-4967723 REQUEST_TRACE=false npm run test:postgres
```

Result: exit 0 against a fresh disposable PostgreSQL 17 container on an internal-only Docker network, with the controlled local model fixture and no provider calls.

```text
{"migrations":16,"queued":12}
{"competingSchedulers":"pass","occurrences":1}
{"workers":2,"completed":13,"verifiedRefunds":13,"toolRuns":13,"duplicateEffects":0,"checkpointTables":4,"model":"controlled local fixture"}
{"postgresCheckpointRestart":"input_required","effects":0}
{"postgresCheckpointRestart":"completed","effects":1}
{"backupRestore":"pass","workflows":13,"refunds":13,"scheduleRuns":1,"overwriteRefused":true}
```

The app image was also started in production mode on an internal-only network with a fresh disposable PostgreSQL 17 database and synthetic local configuration. No host port was published, and no provider credentials or external network access were supplied. Docker marked the container `healthy`; in-container requests returned `/api/health` **200** with `{"ok":true,"name":"CrewOS",...}` and `/api/ready` **200** with `{"ready":true,"database":true,"worker":true}`. `docker stop --time 35` completed with container state `exited`, exit code `0`. The app container, database container, and internal network were then removed. This verifies startup, local database connectivity, worker readiness, HTTP health, and graceful shutdown; it does not verify live Neon Auth, live provider integrations, TLS termination, or production credentials.
