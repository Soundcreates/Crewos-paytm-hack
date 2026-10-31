# Durable event employee response coordinator

## Boundary

`backend/src/services/event-employee-response.mjs` consumes an already persisted event dispatch acquired by the existing event dispatcher. It exposes `run({ orgId, dispatchId, lease })` only. The dispatcher remains the sole inbox/dispatch ingress, authentication authority, and lease issuer. This service does not create dispatch or inbox rows, claim leases, or provide another idempotency layer.

This slice handles only the authenticated Shopify `orders/paid` event on an active simulation connection with effects disabled. Its immutable input is the signed paid-order observation from that event version. Later order mutations do not change the meaning of the observation. The canonical order reader must confirm the observation hash and its simulated paid state. The workflow runtime is `event-simulation-v1`; its only tool is `shopify.order.read_simulated`. No provider, customer communication, commerce mutation, Slack, or other external effect is allowed. The worker must enforce this allowlist independently of any reasoner instructions.

## Execution and authority

The dispatch row supplies org, inbox, event, topic, subscription, connection, principal, employee, manager USER ID, required capability, environment, and its current dispatcher state. The service loads it with `{ orgId, dispatchId }`, reloads the inbox and canonical event, and checks every binding across inbox, event, subscription, connection, principal, manager grant, and employee. Every read that can return tenant data takes `orgId`.

Authorization is current at execution time. The manager membership adapter may return `{ role }`; the service normalizes that shape and allows only `owner`, `admin`, or `manager`. The subscription must still have a live manager authorization and an active service principal. The primary employee must have current active deployment, capability version, policy version, readiness, probation, and `commerce.order.analyze`. Missing, undefined, or false grants and risk decisions deny. `createdBy` is the manager's USER ID from the authorized dispatch/subscription provenance; a service principal ID is never used as a workflow creator.

Collaborator selection is supplied by the injected selector/grant service. Profile text is untrusted ranking guidance and grants no authority. The chosen employee must be distinct, active, current, and hold the exact `support.case.triage` capability. A separate narrow, revocable grant must authorize that employee, capability, subscription, and service principal. An occupied employee execution lock returns pending for that same immutable delegation slot; the service never silently assigns a different employee.

## Fences, atomic writes, and recovery

There are three distinct concurrency domains:

1. **Dispatch lease:** `lease.owner`, `lease.generation`, dispatch state, and nonexpired lease are checked before work. Every dispatch-scoped mutation includes this lease and must compare owner, generation, state, and expiry atomically.
2. **Workflow execution:** each workflow has its own `executionGeneration`. Evidence, continuation, terminal writes, and resume compare this generation as well as the dispatch lease. A stale workflow worker cannot fail or overwrite a newer execution.
3. **Delegation slot:** one immutable slot key, `event-delegation:<dispatchId>:primary`, has its own generation and compare-and-set state. The selected employee does not appear in the slot key. A resolved slot is replayed as resolved and cannot create another child.

The primary workflow's only idempotency key is `event-dispatch:<dispatchId>`. A replay validates role, employee, manager creator, complete immutable provenance, and observation hash. `ensurePrimaryFenced` atomically persists the parent workflow and companion task, sets the dispatch primary pointer, and enqueues local publication while the dispatch lease is current. Child creation is delegated to `delegations.ensureChildFenced`, which atomically creates the child workflow and its own companion task, records the immutable delegation slot, and moves the parent workflow/task to `waiting_dependency`. If the employee is busy, it persists the slot's selected employee and returns pending; retries keep that employee and cannot silently reselect. It does not edit existing prerequisite edges. The dispatch pointer continues to reference the primary workflow only.

`delegations.resolveFenced` requires the current dispatch lease, slot generation, and child execution generation. Parent resume requires a single atomic workflow-plus-task update from `waiting_dependency`; workflow and task generations remain aligned. The child owns its own capability, deployment, evidence, and task record. A parent already completed cannot delegate again. A worker state of `working` is in progress. A queued asynchronous reasoner or resume is pending, never a failure.

The service retries transient lease, busy, serialization, and worker failures through `retryDispatchFenced`, passing a bounded attempt count, capped exponential backoff (default 1 second to 5 minutes), and the persisted dispatch deadline. The adapter owns durable `next_attempt_at` scheduling and deadline exhaustion. Only terminal authorization, binding, tool-policy, and evidence validation failures call `failChainFenced`. A stale lease stops without writing failure. Reclaiming pending or expired inbox/outbox rows remains the existing dispatcher's responsibility; it must retry expired dispatch leases, then call this service with the newly acquired generation. A completed primary with an unfinished dispatch is read and verified before completion is retried. A resolved child slot is reused if the parent has not resumed yet.

## Reasoning and evidence

`reasoner.reason` is injected and must produce substantive, observation-grounded work or report pending. The service independently checks each returned tool against the local simulation allowlist. Every step must include actual input, output, and persisted `toolRunRefs`.

`evidenceVerifier.verify` must reread the authoritative inbox and canonical order snapshot and independently verify the referenced tool runs. Its result must bind org, connection, event version, workflow ID, execution generation, a hash of step tools and inputs, the verifier identity, and paid-order observation hash. A bare `verified: true`, summary text, unowned reference, reference to another workflow's tool run, or missing tool-run record is insufficient. Each workflow gets its own execution and evidence record. Persisted continuation state is saved under both dispatch and workflow fences.

## Injected adapter contract

Construction fails when any required method is absent. Mutating methods return `{ updated: true, ... }` only when all specified predicates and writes succeed atomically; `{ updated: false }` is a fence conflict. Throw `{ code, retryable: true }` for transient failures. Do not perform a partial write and then return false.

### `authority`

- `verifyInboxEvent({ orgId, inboxId, eventId, expectedTopic, expectedConnectionId })` returns a canonical authenticated event containing `verified`, matching IDs, `topic`, `eventVersion`, and immutable `paidOrderObservation`.
- `getActiveSubscription({ orgId, inboxId, subscriptionId })` returns current `{ orgId, id, inboxId, connectionId, principalId, employeeId, managerUserId, requiredCapability, topic, active, managerAuthorized, revoked }`.
- `getServicePrincipal({ orgId, principalId })` returns the active service principal.
- `getConnectionEnvironment({ orgId, connectionId })` returns current environment/effects state.
- `getEmployeeAuthority({ orgId, employeeId, connection, principal, subscription, purpose? })` returns current deployment, capabilities, policy, readiness, and probation facts.
- `findMembershipRole({ orgId, userId })` returns a role string or `{ role }` for the manager USER ID.
- `authorizeSubscription({ orgId, subscription, principal, employee, connection, managerUserId, purpose?, capability? })` returns explicit `{ allowed: true, managerUserId, employeeId, capability, grantId, revoked: false }` for the exact narrow grant. All other results deny.
- `assessRisk({ orgId, event, subscription, employee, connection, capability })` must explicitly return `{ allowed: true }`.
- `selectCollaborator({ orgId, primaryEmployeeId, request, profileTextIsUntrusted: true, event })` returns a candidate only. It is not an authorization decision.

### `store`

- `getDispatch({ orgId, dispatchId })`, `getInbox({ orgId, inboxId })`, `getWorkflow({ orgId, workflowId? , idempotencyKey? })`, and `getPaidOrderSnapshot({ orgId, connectionId, observation, eventVersion })` are org-scoped authoritative reads.
- `assertDispatchLease({ orgId, dispatchId, lease, now })` checks owner, generation, allowed dispatch state, and nonexpired lease; it returns `{ valid: true }` only for a live fence.
- `ensurePrimaryFenced({ orgId, dispatchId, lease, spec, task, publication, now })` atomically inserts or validates the `event-dispatch:<dispatchId>` primary workflow, primary companion task, dispatch primary pointer, and local queue publication. Existing rows are returned only after immutable input/provenance validation. The write checks the supplied deployment/capability/policy and manager-grant snapshot against current authority in the transaction.
- `recordWorkflowEvidenceFenced({ orgId, dispatchId, lease, workflowId, executionGeneration, role, result, output, continuation, evidenceRefs, status, now })` persists this workflow's verified steps, collaboration request, result, continuation, and evidence under both fences so retries can recover the exact decision.
- `saveContinuationFenced(...)` durably stores a pending reasoner's continuation under both fences.
- `completeDispatchFenced(...)`, `retryDispatchFenced(...)`, and `failChainFenced(...)` compare the dispatch lease and authoritative workflow/delegation state atomically. Retry accepts `maxAttempts`, capped backoff, and persisted deadline; it schedules bounded retries or returns the dispatcher's terminal retry state without failing the employee workflow chain. `failChainFenced` also terminally fails a pending delegation slot and parent under their current fences when applicable.

### `workflowWorker`, `taskGraph`, `delegations`, `reasoner`, `evidenceVerifier`

- `workflowWorker.runWorkflow({ orgId, workflowId, expectedExecutionGeneration, dispatchLease, plan, allowedTools })` executes only the supplied local plan, records its actual tool runs, and returns their step inputs/outputs and tool-run references. It must enforce the allowlist itself and fence writes by dispatch lease and workflow generation. A queued/running result is pending.
- `workflowWorker.resumeWorkflow({ orgId, workflowId, expectedExecutionGeneration, slotId, expectedSlotGeneration, dependency, dispatchLease, allowedTools })` atomically requeues the workflow and companion task from `waiting_dependency`, with aligned new execution generations. `{ updated: true, pending: true }` is an accepted asynchronous resume.
- `taskGraph.planDelegation({ orgId, parentWorkflowId, parentEmployeeId, childEmployeeId, taskGraph, limits })` checks existing graph cycle, depth, width, budget, and same-employee concurrency. It does not mutate prerequisite edges.
- `delegations.getSlot({ orgId, dispatchId, slotKey })` returns the immutable slot. `ensureChildFenced(...)` performs the atomic child/companion/slot/parent-wait transaction and rechecks the employee authority snapshot and nonrevoked narrow grant in that transaction. A busy result must preserve the selected employee and slot. `resolveFenced(...)` compares slot and child execution generations and records verified child evidence.
- `reasoner.reason({ orgId, workflowId, role, goal, observation, continuation, parentEvidenceRefs?, allowedTools, executionGeneration })` returns substantive output with steps, result, optional continuation, and optional primary collaboration request, or `{ pending: true }`.
- `evidenceVerifier.verify({ orgId, connectionId, eventVersion, workflowId, executionGeneration, steps, stepInputHash, toolRunRefs, observation, observationHash, role, now })` rereads current authoritative inbox/order data and returns `{ verified: true, verifierId, refs, bindings }` with exact matching org, connection, event, workflow, generation, input hash, observation hash, and verifier identity. Each ref includes its `toolRunId`.

## Foundation schema handoff

The parallel schema/repository work should expose these durable interfaces without duplicating DDL in this service:

- `task_delegations`: org and dispatch IDs, immutable slot key, parent and child workflow/task IDs, selected employee, narrow grant ID, request hash, slot state/generation, child execution generation, verified evidence refs/result, timestamps, and terminal error. Unique key: `(org_id, dispatch_id, slot_key)`. CAS must bind org, current generation, expected state, dispatch lease, and expiry.
- `employee_delegation_grants`: org, manager USER ID, service principal, target employee, exact capability, subscription or event scope, active/revoked state, revocation time, and timestamps. Reads must return only current grants; revocation is effective on the next authority check.
- Primary and child workflows/tasks carry explicit role and execution generation. Only primary workflow ID populates the dispatch primary pointer. Child companion task is linked to its own workflow and delegation slot. Existing task prerequisite records remain unchanged.

## Integration checks

The server composition now passes the dispatcher's acquired owner/generation/expiry token and org ID to the event response service. It does not add a second ingress or enable provider effects.

The fixture tests cover authorization, org binding, lease expiry, workflow replay/idempotency, parent/child role ownership, immutable slots, evidence rejection, pending resume, and no self-delegation.

## Hackathon MVP: run the local event flow

The server now composes the SQL repositories and deterministic local worker. To enable it for a demo, set and restart with:

```dotenv
CREWOS_ORG_ENGINE_V2=true
CREWOS_ORG_ENGINE_V2_ORGS=<your-org-id>
CREWOS_EVENT_RESPONSE_MVP=true
CREWOS_LOCAL_WEBHOOK_FIXTURES=true
CREWOS_LOCAL_WEBHOOK_FIXTURE_SECRET=<local fixture secret>
PROCESS_ROLE=combined
```

`PILOT_MODE` must be off. Create a Shopify simulation connection at `POST /api/commerce/v2/shopify/simulation-connections`. Add a manager-authorized event subscription at `POST /api/event-subscriptions` with `{ "connectionId": "...", "employeeId": "..." }`. The primary employee must be deployed with `commerce.order.analyze` and a `coworkers` list containing the coworker profile ID. Then create a grant at `POST /api/event-delegation-grants` with the subscription ID, target employee ID, and `support.case.triage`. `GET /api/event-subscriptions` and `GET /api/event-delegation-grants?subscriptionId=...` show the saved setup.

Send a signed local `orders/paid` fixture to `POST /api/local-fixtures/webhooks/<connectionId>`, using `X-Provider-Event-ID`, `X-Provider-Event-Type: orders/paid`, and `X-CrewOS-Signature: sha256=<hex HMAC of the raw body>`. The API records the event; the combined worker claims it on its next poll. The primary performs a simulated read, selects the explicitly granted coworker by profile ID, the coworker performs its own simulated read, and the primary completes with the coworker result. Read the result from the workflow/task views and canonical simulated orders.

For MVP speed, reasoning is deterministic and only the local simulated order-read tool is available. This path does not use an LLM, Shopify credentials, provider writes, customer messages, or Slack. It currently supports one child review per paid-order event; broad DAG scheduling and live webhook registration are outside this demo path.
