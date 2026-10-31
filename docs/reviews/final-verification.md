# Final verification follow-up

**Reviewed:** 2026-10-25

**Branch:** `crewos/product-completion`

**Code head tested:** `4967723fbcdb6868e0bc04f45eada0a224164e57` (`test: cover freshness and recovery lifecycle gates`)

**Parent:** `cacf2f4` (`fix: improve keyboard and schedule navigation`)

**Tree at test time:** the only untracked file was `docs/.DS_Store`; it was not staged, read, or changed.

## New regression coverage

`test/pilot-deployment-freshness.test.mjs` now races policy deactivation through the real HTTP endpoint against task assignment through the real HTTP endpoint. It checks the safety outcome whichever request wins: assignment loses with `pilot_deployment_stale`, or it queues against the previous deployment and the worker refuses it before recording a tool run, artifact, or Jira issue. This is a SQLite race test. It does not independently validate PostgreSQL row-lock behavior.

The same test creates a persisted external-MCP input task tied to the now-stale deployment and exercises both resume paths: manager HTTP approval and inbound MCP `tasks/update`. Both must fail before updating task state or contacting the MCP endpoint. The MCP endpoint is loopback and is never dispatched; the assertion checks the freshness error rather than a transport failure. The inbound MCP route returns JSON-RPC error `-32603` with HTTP 200, per its current error contract.

`test/mcp.test.mjs` previously supplied a `runUpdate` stub that only recorded arguments, so the resume test could pass without exercising the MCP verifier gate. It now supplies a test-only verifier restricted to the fixture connection and `lookup_record`, and requires `dispatchMcpTool` to accept that verifier before the mocked forwarding callback succeeds. This closes the false-green in that test. The fixture is not a trusted operator verifier and proves no live MCP execution.

`test/frontend-lifecycle.test.mjs` mounts the client components in JSDOM. It makes a child throw inside `ViewBoundary`, checks the alert fallback, then clicks retry and checks the healthy page. The password reset test uses a controlled `fetch` to cover code request, mismatch rejection without a network call, resend error and success, reset error and retry success, and returning to sign-in. No browser automation or Neon endpoint was used.

## Checks

The focused host run passed on Node `v26.8.2`:

```text
REQUEST_TRACE=false node --test test/pilot-deployment-freshness.test.mjs test/mcp.test.mjs test/frontend-lifecycle.test.mjs
11 tests passed, 0 failed
```

For CI-version validation, I created a temporary context from `git archive` of the exact code head above. The context contained no `.env` or host `node_modules`; its `.dockerignore` was emptied so the archived tests were included. The successful test image used Node `v22.23.4`, Python `3.12.15`, npm `10.9.9`, and pip `25.0.1`.

From the repository at the tested commit, the context was prepared with:

```sh
CONTEXT=$(mktemp -d /tmp/crewos-ci-4967723.XXXXXX)
git archive 4967723fbcdb6868e0bc04f45eada0a224164e57 | tar -x -C "$CONTEXT"
: > "$CONTEXT/.dockerignore"
```

I then wrote the `Dockerfile.ci` shown below into that context and ran:

```text
docker build --progress=plain -f "$CONTEXT/Dockerfile.ci" -t crewos:verify-ci-4967723 "$CONTEXT"
```

The temporary `Dockerfile.ci` was:

```dockerfile
FROM node:22-bookworm-slim AS node22
FROM python:3.12-slim-bookworm
COPY --from=node22 /usr/local/ /usr/local/
WORKDIR /app
ENV NODE_ENV=test REQUEST_TRACE=false PILOT_MODE=false
COPY . .
RUN node --version \
 && python3 --version \
 && python --version \
 && npm --version \
 && python3 -m pip --version \
 && npm ci \
 && python3 -m pip install -r requirements.txt \
 && npm run check:source \
 && npm test \
 && npm audit --audit-level=high
```

All commands in that image completed successfully. `npm test` ran its pretest TypeScript and Vite production builds, then the Python extraction tests and Node suite. The Node runner reported **215 passed, 0 failed**. I also ran the Python extraction command directly in the built CI image and observed **2 passed**. `npm audit --audit-level=high` reported **0 vulnerabilities**. Vite emitted existing dependency warnings that Framer Motion `use client` directives were ignored during bundling; both builds completed.

```text
docker run --rm crewos:verify-ci-4967723 python3 -m unittest discover -s test -p 'test_extract_document_*.py'
```

The repository production Dockerfile also built from the same archived code with no runtime environment injected:

```text
docker build --progress=plain -f "$CONTEXT/Dockerfile" -t crewos:verify-image-4967723 "$CONTEXT"
```

It completed successfully. The image was not started or deployed. Its Dockerfile installs Debian Bookworm's Python 3.11 runtime; the separate CI image above supplies the requested Python 3.12 test runtime. Neither image replaced `crewos:completion`.

The resulting local image IDs were `sha256:634755527740f630d1449d3e83fd70cd37470ce5473408adc57d8cf7cd37ffae` for the CI test image and `sha256:dd739679bce618f547f69e2e67840189af700c564a646a36efb7638b5e548da6` for the production image.

One initial temporary CI harness copied Python files into the Node base and then failed at pip because Python's SSL extension was unavailable. No project tests ran in that attempt. The final recipe keeps the Python 3.12 base intact and copies Node 22 into it; that corrected run passed.

## Remaining gates

- The checks used local databases, mocked fetch/provider transports, and a temporary MCP verifier. They do not prove live Neon OTP delivery, Jira behavior, provider execution, or trustworthiness of any deployed MCP verifier. Keep MCP fail-closed until a trusted verifier and a non-production remote read-back acceptance path are validated.
- The freshness policy race uses SQLite and does not itself prove PostgreSQL row-lock semantics. The separate PostgreSQL 17 acceptance was rerun against the production image built from this product code; its exact command and output are in [`postgres-acceptance.md`](postgres-acceptance.md).
- JSDOM covers component lifecycle and controlled network responses, not a real browser journey or real Auth account/session behavior.
- The production image now passed a local isolated startup, `/api/health`, `/api/ready`, and graceful shutdown check. Live Neon Auth, provider integrations, public TLS routing, production credentials, and deployment readiness remain unverified.

No provider credentials were injected and no live provider calls were made.

## Local acceptance refresh (2026-10-25)

After the release run above, the PostgreSQL gate ran with branch HEAD `00d656cc677c40a0515be5216dd5045591b50d9a` and the production image `crewos:verify-image-4967723` built from product code `4967723fbcdb6868e0bc04f45eada0a224164e57`. The branch later advanced to `5ebe58457166c7036614ae24ad95f30e1ae96cd7`, which adds only the mounted-browser UX review and screenshots; `backend`, `frontend`, `lib`, `test-postgres`, and package files are unchanged from the image source. The PostgreSQL gate passed: 16 migrations, two workers completed 13 workflows, 13 verified simulated refunds, 13 tool runs, zero duplicate effects, approval resume across a worker restart, and successful backup/restore with overwrite refusal. See [`postgres-acceptance.md`](postgres-acceptance.md) for the exact output.

The same production image was launched with a fresh local PostgreSQL 17 database on an internal-only Docker network. No host port was published and no external network or provider credentials were supplied. Docker reported `healthy`; in-container `/api/health` returned 200 and `/api/ready` returned 200 with database and worker true. Graceful `docker stop --time 35` exited with code 0, after which the two containers and network were removed. This is local runtime evidence, not a live Neon Auth or public deployment check.

The first shell wrapper used zsh's read-only `status` variable and exited after starting the disposable resources but before the explicit HTTP probes. The containers remained healthy; I then queried both endpoints directly, performed the graceful stop, and removed the exact named containers and network. The final runtime result above reflects those direct probes and cleanup.

## Release refresh at final product head (2026-10-25)

**Code head tested:** `3131e20dd35c9c6d6f4031a934fea60f9f284392` (`fix: keep settings navigation within sidebar viewport`). The archive was made with `git archive` from this exact commit, so it contained committed files only and no host `node_modules` or `.env`. The worktree's untracked `docs/.DS_Store` was left untouched.

The complete source delta since `4967723fbcdb6868e0bc04f45eada0a224164e57` was reviewed. Runtime product changes are limited to `frontend/src/config/navigation.js` and `frontend/src/styles/shell.css`; the other changes are tests and documentation/screenshots. `backend`, `lib`, `test-postgres`, `Dockerfile`, `Dockerfile.ci`, `requirements.txt`, `package.json`, and `package-lock.json` have no delta from the previously tested backend/runtime baseline.

I created a temporary context from the exact archive, emptied its `.dockerignore` so tracked tests were included, and ran the release check in a clean two-base CI image:

```sh
git archive 3131e20dd35c9c6d6f4031a934fea60f9f284392 | tar -x -C "$CONTEXT"
: > "$CONTEXT/.dockerignore"
docker build --progress=plain -f "$CONTEXT/Dockerfile.ci" -t crewos:verify-ci-3131e20 "$CONTEXT"
```

`Dockerfile.ci` used `node:22-bookworm-slim` to supply Node/npm to `python:3.12-slim-bookworm`, then ran `npm ci`, installed `requirements.txt`, and ran `npm run check:release`. The observed tool versions were Node `v22.23.4`, Python `3.12.15`, npm `10.9.9`, and pip `25.0.1`. The release command passed source validation, the TypeScript and Vite production builds, all **215 Node tests** with **0 failures**, and `npm audit --audit-level=high` with **0 vulnerabilities**. Python extraction tests passed **2/2** inside `npm test`; I reran them directly in the same CI image and observed `Ran 2 tests ... OK`. Vite still prints existing Framer Motion `use client` directive warnings while completing successfully. npm also reports two dependency deprecation notices; neither caused a failure.

I built, but did not start, a new production image from the same archived head:

```sh
docker build --progress=plain -f "$CONTEXT/Dockerfile" -t crewos:verify-image-3131e20 "$CONTEXT"
```

The build passed. The local image ID is `sha256:f9979442402e8a08f165a1685a150323092b13ec47eddff15309a5e7573fff27`. The CI image ID is `sha256:79658d86102fafd490490748e30b93da3b205d10b2041c1b623ea9d2c1b6778e`. Both tags are unique; `crewos:completion` and the QA service on port 4186 were not touched. No provider keys, live provider calls, or production credentials were used.

### Evidence carried forward and remaining limits

The PostgreSQL 17 acceptance and isolated production health/readiness/shutdown results above were run against the image built from `4967723fbcdb6868e0bc04f45eada0a224164e57`, not rerun at this head. They remain evidence for the current backend/runtime source because the complete delta confirms those paths, the PostgreSQL harness, and runtime image configuration are unchanged. This is carried-forward evidence, not a claim that PostgreSQL or the new production image was retested at `3131e20`.

This release refresh did not perform a mounted-browser manager journey, live Neon Auth, live providers, public TLS routing, or deployment. JSDOM results and the earlier isolated local runtime checks remain separately scoped; they do not certify those live/browser paths or startup of the newly built image.
