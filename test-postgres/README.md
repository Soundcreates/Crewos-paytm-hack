# Disposable PostgreSQL acceptance harness

This harness exercises CrewOS's PostgreSQL migration, workflow, scheduler, worker, approval-checkpoint, and backup/restore paths against local disposable containers. It does not connect to Neon or make model, Solari, Slack, Jira, Pinecone, or other provider calls.

## Prerequisites

- Docker with a running engine.
- The `postgres:17-bookworm` image already available locally. The script uses `--pull=never` so it will not fetch images while running.
- A locally built CrewOS image tagged `crewos:completion`, built from this repository's Node 22 Dockerfile.

If PostgreSQL 17 is not available locally, fetch it once with `docker pull postgres:17-bookworm` before running the harness.

## Run

From the repository root:

```sh
docker build -t crewos:completion .
npm run test:postgres
```

The npm script requires `--confirm-disposable-postgres`; its package script supplies that flag. The harness creates a unique internal Docker network, a PostgreSQL 17 container, a controlled model fixture, and two worker containers. It injects local-only test configuration and uses the network alias `ep-local...neon.tech` to exercise Neon-compatible URL validation against local PostgreSQL. It removes the created containers and network when it exits.

Set `CREWOS_ACCEPTANCE_IMAGE` to use a different prebuilt application image. That image must contain the built backend and frontend and run Node 22. Do not point the harness at a hosted database or a production image with real secrets.

## What it verifies

- Application and LangGraph PostgreSQL migrations.
- Concurrent schedule polling creates one occurrence.
- Two workers complete the queued simulated tasks with no duplicate effects.
- A process can stop at manager approval and a later process can resume the same checkpoint.
- Backup and restore reproduce the workflow/refund/schedule records, and restore refuses a populated target.

The current successful output reports 16 migrations, two workers, 13 completed workflows and verified simulated effects, zero duplicate effects, one resumed approval action, and a successful backup/restore. The schedule occurrence count is one.

## Limits

This is local PostgreSQL 17 evidence. It does not prove live Neon authentication, managed Neon pooler behavior, real provider execution, browser acceptance, production readiness, or deployment recovery timing. See [`../docs/reviews/postgres-acceptance.md`](../docs/reviews/postgres-acceptance.md) for the dated acceptance record.
