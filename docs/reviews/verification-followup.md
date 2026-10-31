# Verification follow-up

**Reviewed:** 2026-10-25
**Branch:** `crewos/product-completion`
**Code head tested:** `8ca537e8ed7f74aa04800000b2510a3708103d57` (`docs: reconcile release acceptance reports`)
**Branch head after checks:** `a31250a605d44ec9a45992b73a2d8f5bda458255` (`fix: enforce pilot schedule boundary`)
**Tree state:** focused checks ran with concurrent schedule and workflow edits present in the shared worktree. The pilot-schedule change was committed after the focused checks; Builder's workflow changes remain uncommitted. No one else's edits were staged or changed by this review. This report and the three new test files are the only files owned by this review.

## Findings

### Production doctor accepts private HTTPS origins

`backend/lib/config-check.mjs:22-25` checks that production `APP_ORIGIN` uses HTTPS and has no path, query, fragment, or URL credentials. It does not check whether the host is local or private, even though the check message says “public HTTPS origin.” With otherwise valid production configuration, these three inputs all produce `APP_ORIGIN: pass` and `ready: true`:

```text
https://localhost
https://127.0.0.1
https://10.0.0.8
```

The new expected-behavior regression cases in `test/doctor-public-origin.test.mjs` fail on all three inputs. This is a reproducible production-readiness false green. The doctor must reject known local/private origins or its readiness message must stop claiming public reachability; a static check cannot prove a hostname's current DNS routing without a network check.

### View boundary and password recovery coverage

`test/frontend-resilience.test.mjs` covers the ViewBoundary alert fallback markup after seeding its derived error state. It does not mount a child that throws, test lazy-chunk rejection through React, or click the retry/reload actions. The boundary's actual catch and reset lifecycle remain unverified.

Password recovery now has an initial-screen render regression. The existing `test/frontend-auth-api.test.mjs` covers same-origin request URLs, cookies, and an invalid OTP response. There is still no automated UI transition coverage for successful code request/reset, mismatched passwords, resend, recovery error display, or returning to sign-in. No Neon branch or email provider was contacted, so real OTP delivery, one-time use, and session behavior remain live gates.

### Sandbox evidence is output evidence, not video

The new `test/tool-evidence-route.test.mjs` inserts local completed and failed sandbox tool-run records and verifies that the route returns their input/output JSON as `type: "tool-evidence"`; it also verifies that another tenant receives 404. The route does not redirect to a video replay for `solari.sandbox.echo`.

The task UI at `frontend/src/pages/OperationsPages.jsx:168` labels completed sandbox echo and desktop actions “Open replay.” For sandbox echo the URL returns command evidence JSON, not video. Align the sandbox action label with the evidence the route supplies. No Solari sandbox was launched.

### MCP verifier remains fail-closed and has no live enablement evidence

The focused MCP suite passes with the verifier unset: dispatch is rejected before the handler sends a request, and results without independent postcondition verification remain unverified. It also exercises a temporary local verifier fixture and confirms that only its supported tool can dispatch. That fixture is test code, not an operator-trusted live verifier.

No remote MCP server or live verifier was used. `MCP_VERIFIER_MODULE` presence in the static doctor is configuration evidence only; it does not establish that a trusted verifier can independently verify a real tool's postcondition. Keep remote execution unavailable until an operator supplies and validates a trusted verifier and a live, non-production read-back acceptance path.

### Solari profile-context note is stale

The committed `fe41d4a` change now uses the SDK's `browser.context` for profile-seeded sessions and, after reconnect, selects the context containing the existing workflow page. `test/solari-session.test.mjs` covers the SDK context when it is not first, reconnect selection, and the no-page failure case. The corresponding profile-context warnings in `docs/reviews/integrations.md:12` and `:30` still say the code uses `browser.contexts()[0]`; those statements are stale. Live saved-login persistence is still unverified.

## Checks run

| Command | Result |
| --- | --- |
| `npm run build:ts` | Passed. |
| `REQUEST_TRACE=false node --test test/frontend-auth-api.test.mjs test/frontend-resilience.test.mjs` | Passed, 5 tests. This shared-tree run also included a concurrent pilot-navigation test. |
| `REQUEST_TRACE=false node --test test/mcp-verifier.test.mjs test/mcp.test.mjs` | Passed, 10 tests. |
| `REQUEST_TRACE=false node --test test/tool-evidence-route.test.mjs test/solari-session.test.mjs` | Passed, 10 tests. |
| `REQUEST_TRACE=false node --test test/config-check.test.mjs test/doctor-public-origin.test.mjs` | Failed as expected: 2 existing checks passed and all 3 new public-origin expectations failed (`pass !== error`). |

These checks made no provider calls. The PostgreSQL acceptance gate was not repeated. The final release build, full test suite, `npm audit`, and PostgreSQL acceptance still need to run after Builder's pending workflow changes land; no final release certification is claimed here.
