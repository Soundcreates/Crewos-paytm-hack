import { createHash } from 'node:crypto';

const FINAL = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE = new Set(['queued', 'pending', 'running', 'leased', 'waiting_dependency', 'working']);
const CAPABILITY = 'support.case.triage';
const ALLOWED_TOPIC = 'orders/paid';
const ALLOWED_PRIMARY_CAPABILITY = 'commerce.order.analyze';
const LOCAL_TOOLS = Object.freeze(['shopify.order.read_simulated']);
const DEFAULT_LIMITS = Object.freeze({ payloadBytes: 16_384, payloadDepth: 8, evidenceRefs: 32, maxAttempts: 6, retryBaseDelayMs: 1_000, retryMaxDelayMs: 300_000, maxDepth: 4, maxWidth: 4, maxChildren: 3 });
const PRIVILEGED_ROLES = new Set(['owner', 'admin', 'manager']);

export class EventResponseError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = 'EventResponseError';
    this.code = code;
    this.retryable = retryable;
  }
}

const reject = (code, message, options) => { throw new EventResponseError(code, message, options); };
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function hash(value) { return createHash('sha256').update(stable(value)).digest('hex'); }
function required(owner, method) {
  if (typeof owner?.[method] !== 'function') reject('invalid_configuration', `Missing required adapter method ${method}.`);
  return owner[method].bind(owner);
}
function id(value, label) {
  if (typeof value !== 'string' || !value.trim()) reject('invalid_event', `Missing ${label}.`);
  return value.trim();
}
function same(actual, expected, label) {
  if (!expected || actual !== expected) reject('scope_mismatch', `${label} does not match the dispatch binding.`);
}
function org(row, orgId, label) {
  if (!row || row.orgId !== orgId) reject('scope_mismatch', `${label} is missing or outside the dispatch organization.`);
}
function capList(employee) {
  return (Array.isArray(employee?.capabilities) ? employee.capabilities : []).map((v) => typeof v === 'string' ? v : v?.key ?? v?.name).filter(Boolean);
}
function assertEmployee(employee, capability, label) {
  if (!employee?.active || employee.readiness !== 'ready' || employee.probationPassed !== true || !employee.deploymentId || !employee.capabilityVersion || !employee.policyVersion) reject('employee_denied', `${label} lacks current active deployment, readiness, probation, or policy authority.`);
  if (capability && !capList(employee).includes(capability)) reject('employee_capability_missing', `${label} lacks ${capability}.`);
}
function normalizeRole(value) {
  const role = isRecord(value) ? value.role : value;
  return typeof role === 'string' ? role.toLowerCase() : null;
}
function bounded(value, limits, depth = 0) {
  if (depth > limits.payloadDepth) return '[depth-limited]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => bounded(item, limits, depth + 1));
  if (isRecord(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (/authorization|cookie|secret|token|password/i.test(key)) continue;
      out[key] = bounded(item, limits, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.slice(0, 4_000);
  if (value === null || ['number', 'boolean'].includes(typeof value)) return value;
  return String(value).slice(0, 500);
}
function bytes(value) { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
function transient(error) { return error?.retryable === true || ['lease_lost', 'lease_conflict', 'execution_fence_conflict', 'dependency_busy', 'workflow_busy', 'temporarily_unavailable', 'serialization_conflict'].includes(error?.code); }

/**
 * Create the durable event-response coordinator. `run` consumes a dispatch row
 * already claimed by the event dispatcher. All mutations are fenced by its lease;
 * workflow execution and delegation have separate generations/CAS fences.
 */
export function createEventEmployeeResponseService(adapters, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const now = adapters?.now ?? (() => new Date().toISOString());
  const authority = adapters?.authority;
  const store = adapters?.store;
  const workflows = adapters?.workflowWorker;
  const delegations = adapters?.delegations;
  const reasoner = adapters?.reasoner;
  const verifier = adapters?.evidenceVerifier;
  const taskGraph = adapters?.taskGraph;

  const a = {
    verifyInboxEvent: required(authority, 'verifyInboxEvent'),
    getActiveSubscription: required(authority, 'getActiveSubscription'),
    getServicePrincipal: required(authority, 'getServicePrincipal'),
    getConnectionEnvironment: required(authority, 'getConnectionEnvironment'),
    getEmployeeAuthority: required(authority, 'getEmployeeAuthority'),
    authorizeSubscription: required(authority, 'authorizeSubscription'),
    assessRisk: required(authority, 'assessRisk'),
    selectCollaborator: required(authority, 'selectCollaborator'),
    findMembershipRole: required(authority, 'findMembershipRole'),
  };
  const s = {
    getDispatch: required(store, 'getDispatch'),
    getInbox: required(store, 'getInbox'),
    getPaidOrderSnapshot: required(store, 'getPaidOrderSnapshot'),
    getWorkflow: required(store, 'getWorkflow'),
    assertDispatchLease: required(store, 'assertDispatchLease'),
    ensurePrimaryFenced: required(store, 'ensurePrimaryFenced'),
    recordWorkflowEvidenceFenced: required(store, 'recordWorkflowEvidenceFenced'),
    completeDispatchFenced: required(store, 'completeDispatchFenced'),
    retryDispatchFenced: required(store, 'retryDispatchFenced'),
    failChainFenced: required(store, 'failChainFenced'),
    saveContinuationFenced: required(store, 'saveContinuationFenced'),
  };
  const w = {
    run: required(workflows, 'runWorkflow'),
    resume: required(workflows, 'resumeWorkflow'),
  };
  const d = {
    getSlot: required(delegations, 'getSlot'),
    ensureChildFenced: required(delegations, 'ensureChildFenced'),
    resolveFenced: required(delegations, 'resolveFenced'),
  };
  const r = { reason: required(reasoner, 'reason'), verify: required(verifier, 'verify') };
  const planDelegation = required(taskGraph, 'planDelegation');

  async function dispatchContext(row, lease) {
    const orgId = id(row.orgId, 'dispatch orgId');
    const inboxId = id(row.inboxId, 'dispatch inboxId');
    const subscriptionId = id(row.subscriptionId, 'dispatch subscriptionId');
    const connectionId = id(row.connectionId, 'dispatch connectionId');
    const principalId = id(row.principalId, 'dispatch principalId');
    const employeeId = id(row.employeeId, 'dispatch employeeId');
    const managerUserId = id(row.managerUserId, 'manager USER id');
    if (row.environment !== 'simulation' || row.topic !== ALLOWED_TOPIC || row.requiredCapability !== ALLOWED_PRIMARY_CAPABILITY) reject('event_not_allowed', 'Only simulated Shopify paid-order analysis dispatches are supported.');
    const leaseCheck = await s.assertDispatchLease({ orgId, dispatchId: row.id, lease, now: now() });
    if (leaseCheck?.valid !== true) reject('stale_lease', 'Dispatch lease is not current.', { retryable: true });
    const inbox = await s.getInbox({ orgId, inboxId });
    org(inbox, orgId, 'Inbox');
    same(inbox.id, inboxId, 'Inbox id');
    same(inbox.topic, row.topic, 'Inbox topic');
    same(inbox.connectionId, connectionId, 'Inbox connection');
    same(inbox.eventId, row.eventId, 'Inbox event');
    const event = await a.verifyInboxEvent({ orgId, inboxId, eventId: row.eventId, expectedTopic: row.topic, expectedConnectionId: connectionId });
    org(event, orgId, 'Verified inbox event');
    if (event.verified !== true) reject('unverified_event', 'The persisted inbox event is not authenticated.');
    for (const [key, value] of Object.entries({ inboxId, eventId: row.eventId, topic: row.topic, connectionId })) same(event[key], value, `Verified event ${key}`);
    if (!event.eventVersion || !event.paidOrderObservation || event.paidOrderObservation.paymentState !== 'paid') reject('event_snapshot_invalid', 'The signed event does not contain an immutable paid-order observation.');
    const snapshot = bounded(event.paidOrderObservation, limits);
    if (bytes(snapshot) > limits.payloadBytes) reject('payload_too_large', 'Paid-order observation exceeds the configured bound.');
    const subscription = await a.getActiveSubscription({ orgId, inboxId, subscriptionId });
    org(subscription, orgId, 'Subscription');
    for (const [key, value] of Object.entries({ id: subscriptionId, inboxId, connectionId, principalId, employeeId, managerUserId, requiredCapability: ALLOWED_PRIMARY_CAPABILITY, topic: ALLOWED_TOPIC })) same(subscription[key], value, `Subscription ${key}`);
    if (subscription.active !== true || subscription.managerAuthorized !== true || subscription.revoked === true) reject('subscription_denied', 'Subscription is inactive, revoked, or lacks current manager authorization.');
    const principal = await a.getServicePrincipal({ orgId, principalId });
    org(principal, orgId, 'Service principal');
    if (principal.id !== principalId || principal.active !== true || principal.kind !== 'service') reject('principal_denied', 'The subscribed service principal is not active.');
    const connection = await a.getConnectionEnvironment({ orgId, connectionId });
    org(connection, orgId, 'Connection');
    if (connection.id !== connectionId || connection.active !== true || connection.environment !== 'simulation' || connection.effectsEnabled !== false) reject('environment_denied', 'Only an active simulation connection with effects disabled is supported.');
    const order = await s.getPaidOrderSnapshot({ orgId, connectionId, observation: event.paidOrderObservation, eventVersion: event.eventVersion });
    org(order, orgId, 'Canonical paid-order snapshot');
    if (order.connectionId !== connectionId || order.eventVersion !== event.eventVersion || order.environment !== 'simulation' || order.simulated !== true || order.paymentState !== 'paid' || order.observationHash !== hash(event.paidOrderObservation)) reject('order_snapshot_invalid', 'Canonical order state does not match the signed paid-order observation.');
    const membership = await a.findMembershipRole({ orgId, userId: managerUserId });
    if (!PRIVILEGED_ROLES.has(normalizeRole(membership))) reject('manager_grant_denied', 'The manager user no longer has an authorized organization role.');
    const employee = await a.getEmployeeAuthority({ orgId, employeeId, connection, principal, subscription });
    org(employee, orgId, 'Primary employee');
    if (employee.employeeId !== employeeId) reject('employee_denied', 'Primary employee identity does not match subscription.');
    assertEmployee(employee, ALLOWED_PRIMARY_CAPABILITY, 'Primary employee');
    const grant = await a.authorizeSubscription({ orgId, subscription, principal, employee, connection, managerUserId, capability: ALLOWED_PRIMARY_CAPABILITY });
    if (!grant || grant.allowed !== true || grant.managerUserId !== managerUserId || grant.employeeId !== employeeId || grant.capability !== ALLOWED_PRIMARY_CAPABILITY || !grant.grantId || grant.revoked === true) reject('subscription_denied', 'Current manager-authorized service grant is required.');
    const risk = await a.assessRisk({ orgId, event, subscription, employee, connection, capability: ALLOWED_PRIMARY_CAPABILITY });
    if (!risk || risk.allowed !== true) reject('risk_denied', 'Current risk policy did not explicitly allow analysis.');
    return { orgId, inboxId, subscriptionId, connectionId, principalId, employeeId, managerUserId, managerGrantId: grant.grantId, event, snapshot, order, subscription, principal, connection, employee, risk };
  }

  function provenance(c, dispatch) {
    return Object.freeze({ kind: 'shopify_paid_order_observation', orgId: c.orgId, inboxId: c.inboxId, dispatchId: dispatch.id, topic: ALLOWED_TOPIC, eventId: c.event.eventId, eventVersion: c.event.eventVersion, subscriptionId: c.subscriptionId, principalId: c.principalId, managerUserId: c.managerUserId, connectionId: c.connectionId, environment: 'simulation', observationHash: hash(c.event.paidOrderObservation) });
  }

  async function workflowEvidence(c, dispatch, workflow, executionGeneration, output, role) {
    if (!workflow || workflow.orgId !== c.orgId || workflow.role !== role) reject('workflow_binding_invalid', `${role} workflow is not bound to this organization and role.`);
    if (!Number.isInteger(executionGeneration) || workflow.executionGeneration !== executionGeneration) reject('execution_fence_conflict', 'Workflow execution generation changed.', { retryable: true });
    if (workflow.status !== 'completed' && workflow.status !== 'waiting_dependency' && !ACTIVE.has(workflow.status)) {
      reject('workflow_terminal_failure', `Workflow ended in ${String(workflow.status)}.`);
    }
    if (!output && ACTIVE.has(workflow.status)) return { workflow, pending: true };
    if (!isRecord(output) || !Array.isArray(output.steps) || output.steps.length === 0) reject('reasoning_output_invalid', 'Reasoner did not return substantive step output.');
    for (const step of output.steps) {
      if (!LOCAL_TOOLS.includes(step.tool)) reject('tool_not_allowed', 'Event runtime returned a tool outside the local simulation allowlist.');
      if (!step.input || !step.output || !Array.isArray(step.toolRunRefs) || !step.toolRunRefs.length) reject('tool_run_missing', 'Every reasoning step must reference persisted tool runs and actual input/output.');
    }
    const toolRunRefs = output.steps.flatMap((step) => step.toolRunRefs);
    if (toolRunRefs.length > limits.evidenceRefs) reject('evidence_limit', 'Workflow produced too many evidence references.');
    const stepInputHash = hash(output.steps.map(({ tool, input }) => ({ tool, input })));
    const checked = await r.verify({ orgId: c.orgId, connectionId: c.connectionId, eventVersion: c.event.eventVersion, workflowId: workflow.id, executionGeneration, steps: output.steps, stepInputHash, toolRunRefs, observation: c.snapshot, observationHash: hash(c.event.paidOrderObservation), role, now: now() });
    if (!checked || checked.verified !== true || typeof checked.verifierId !== 'string' || !checked.verifierId || checked.bindings?.verifierId !== checked.verifierId || checked.bindings?.stepInputHash !== stepInputHash || checked.bindings?.orgId !== c.orgId || checked.bindings?.connectionId !== c.connectionId || checked.bindings?.eventVersion !== c.event.eventVersion || checked.bindings?.workflowId !== workflow.id || checked.bindings?.executionGeneration !== executionGeneration || checked.bindings?.observationHash !== hash(c.event.paidOrderObservation) || !Array.isArray(checked.refs) || checked.refs.length === 0 || checked.refs.length > limits.evidenceRefs || checked.refs.some((ref) => !toolRunRefs.includes(ref.toolRunId))) reject('evidence_invalid', 'Independent verifier did not confirm evidence bound to this execution and signed observation.');
    const status = workflow.status === 'completed' || workflow.status === 'waiting_dependency'
      ? workflow.status
      : role === 'primary' && output.collaborationRequest ? 'waiting_dependency' : 'completed';
    // A completed workflow may already have immutable evidence for this
    // execution generation. Re-verify it, but do not rewrite that evidence
    // when a child result is attached during the parent resume.
    if (workflow.status === 'completed' && Array.isArray(workflow.evidenceRefs) && workflow.evidenceRefs.length) {
      return { workflow, result: workflow.result ?? output.result, refs: checked.refs, collaborationRequest: output.collaborationRequest ?? null };
    }
    const persisted = await s.recordWorkflowEvidenceFenced({ orgId: c.orgId, dispatchId: dispatch.id, lease: dispatch.lease, workflowId: workflow.id, executionGeneration, role, result: output.result, output: { steps: output.steps, result: output.result, continuation: output.continuation ?? null, collaborationRequest: output.collaborationRequest ?? null }, continuation: output.continuation ?? null, evidenceRefs: checked.refs, status, now: now() });
    if (persisted?.updated !== true) reject('execution_fence_conflict', 'Workflow evidence write lost its execution or dispatch fence.', { retryable: true });
    return { workflow: persisted.workflow ?? workflow, result: output.result, refs: checked.refs, collaborationRequest: output.collaborationRequest ?? null };
  }

  async function failTerminal(c, dispatch, lease, error, slot) {
    const result = await s.failChainFenced({ orgId: c.orgId, dispatchId: dispatch.id, lease, slotId: slot?.id ?? null, expectedSlotGeneration: slot?.generation ?? null, code: error.code ?? 'terminal_failure', message: String(error.message ?? error).slice(0, 300), now: now() });
    if (result?.updated !== true) reject('stale_lease', 'Failure write lost the dispatch lease.', { retryable: true });
    return { state: 'failed', dispatch: result.dispatch, error: { code: error.code ?? 'terminal_failure', message: error.message } };
  }

  async function executeReasoned(c, dispatch, workflow, role, extra = {}) {
    const plan = await r.reason({ orgId: c.orgId, workflowId: workflow.id, role, goal: workflow.goal, event: c.event, observation: c.snapshot, continuation: workflow.continuation ?? null, ...extra, allowedTools: LOCAL_TOOLS, executionGeneration: workflow.executionGeneration });
    if (!plan || plan.pending === true) return { pending: true, continuation: plan?.continuation ?? workflow.continuation ?? null };
    const execution = await w.run({ orgId: c.orgId, workflowId: workflow.id, expectedExecutionGeneration: workflow.executionGeneration, dispatchLease: dispatch.lease, plan, allowedTools: LOCAL_TOOLS });
    if (!execution || execution.pending === true || execution.queued === true) return { pending: true, continuation: execution?.continuation ?? plan.continuation ?? workflow.continuation ?? null };
    const output = execution.output ?? execution;
    return { ...output, result: output.result ?? plan.result, continuation: output.continuation ?? plan.continuation ?? null, collaborationRequest: output.collaborationRequest ?? plan.collaborationRequest ?? null };
  }

  async function run({ orgId: suppliedOrgId, dispatchId, lease } = {}) {
    const orgId = id(suppliedOrgId, 'orgId');
    dispatchId = id(dispatchId, 'dispatchId');
    if (!lease || typeof lease.owner !== 'string' || !Number.isInteger(lease.generation) || lease.generation < 1 || !lease.expiresAt) reject('lease_required', 'A dispatch owner, positive generation, and expiry are required.');
    const dispatch = await s.getDispatch({ orgId, dispatchId });
    org(dispatch, orgId, 'Dispatch');
    same(dispatch.id, dispatchId, 'Dispatch id');
    if (FINAL.has(dispatch.state)) return { state: dispatch.state, dispatch, replay: true };
    if (dispatch.state !== 'checking' && dispatch.state !== 'running') reject('dispatch_state_invalid', 'Dispatch is not leased for execution.', { retryable: true });
    let context;
    let activeSlot = null;
    try {
      context = await dispatchContext(dispatch, lease);
      const prov = provenance(context, dispatch);
      const primaryKey = `event-dispatch:${dispatch.id}`;
      let primary = await s.getWorkflow({ orgId, idempotencyKey: primaryKey });
      const primarySpec = { idempotencyKey: primaryKey, orgId, role: 'primary', employeeId: context.employeeId, createdBy: context.managerUserId, servicePrincipalId: context.principalId, subscriptionId: context.subscriptionId, connectionId: context.connectionId, capability: ALLOWED_PRIMARY_CAPABILITY, goal: 'Analyze the authenticated simulated paid-order event using verified observations. Delegate only when coworker expertise is needed to complete the analysis.', runtimeVersion: 'event-simulation-v1', provenance: prov, observation: context.snapshot, observationHash: prov.observationHash, authoritySnapshot: { deploymentId: context.employee.deploymentId, capabilityVersion: context.employee.capabilityVersion, policyVersion: context.employee.policyVersion, managerGrantId: context.managerGrantId } };
      if (!primary) {
        const refreshed = await dispatchContext(dispatch, lease);
        if (refreshed.employee.deploymentId !== context.employee.deploymentId || refreshed.employee.capabilityVersion !== context.employee.capabilityVersion || refreshed.employee.policyVersion !== context.employee.policyVersion || refreshed.managerGrantId !== context.managerGrantId || hash(refreshed.event.paidOrderObservation) !== prov.observationHash) reject('authority_changed', 'Primary authority or event observation changed before workflow creation.');
        const created = await s.ensurePrimaryFenced({ orgId, dispatchId, lease, spec: primarySpec, task: { role: 'primary', capability: ALLOWED_PRIMARY_CAPABILITY }, publication: { queue: 'event-simulation-local', toolAllowlist: LOCAL_TOOLS }, now: now() });
        if (created?.updated !== true || !created.workflow) reject('lease_conflict', 'Primary workflow, companion task, dispatch pointer, and local publication were not atomically committed.', { retryable: true });
        primary = created.workflow;
      } else {
        org(primary, orgId, 'Primary workflow replay');
        if (primary.idempotencyKey !== primaryKey || primary.role !== 'primary' || primary.employeeId !== context.employeeId || primary.createdBy !== context.managerUserId || primary.servicePrincipalId !== context.principalId || primary.subscriptionId !== context.subscriptionId || primary.connectionId !== context.connectionId || primary.capability !== ALLOWED_PRIMARY_CAPABILITY || primary.observationHash !== prov.observationHash || primary.provenance?.observationHash !== prov.observationHash || stable(primary.provenance) !== stable(prov)) reject('idempotency_conflict', 'Primary workflow replay does not match immutable provenance.');
        same(dispatch.primaryWorkflowId, primary.id, 'Dispatch primary workflow pointer');
      }
      let output;
      if (primary.status === 'completed' || primary.status === 'waiting_dependency') output = primary.output ?? { steps: primary.steps, result: primary.result, continuation: primary.continuation, collaborationRequest: primary.collaborationRequest };
      else if (ACTIVE.has(primary.status)) {
        output = await executeReasoned(context, { ...dispatch, lease }, primary, 'primary', { employee: context.employee });
        if (!output || output.pending === true) return pending({ dispatch, lease, workflow: { ...primary, continuation: output?.continuation }, reason: 'reasoner_pending' });
        const saved = await workflowEvidence(context, { ...dispatch, lease }, primary, primary.executionGeneration, output, 'primary');
        if (saved.pending) return pending({ dispatch, lease, workflow: saved.workflow });
        primary = saved.workflow;
        output = { ...output, result: saved.result, evidenceRefs: saved.refs };
      } else reject('workflow_terminal_failure', `Primary workflow ended in ${String(primary.status)}.`);

      if (!output || !Array.isArray(output.steps) || !output.steps.length) {
        if (primary.status === 'completed' && Array.isArray(primary.toolRunRefs)) output = { ...primary.output, steps: primary.steps, result: primary.result };
        if (!output?.steps?.length) reject('evidence_invalid', 'Completed primary workflow has no persisted execution evidence.');
      }
      const primaryEvidence = await workflowEvidence(context, { ...dispatch, lease }, primary, primary.executionGeneration, output, 'primary');
      if (primaryEvidence.pending) return pending({ dispatch, lease, workflow: primary });
      primary = primaryEvidence.workflow;
      let primaryRefs = primaryEvidence.refs;

      const existingSlot = await d.getSlot({ orgId, dispatchId, slotKey: `event-delegation:${dispatch.id}:primary` });
      let delegationRequest = existingSlot?.request ?? output.collaborationRequest ?? null;
      if (primary.status === 'completed' && !existingSlot) delegationRequest = null;
      if (existingSlot?.state === 'resolved') {
        // A resolved edge is authoritative on replay; never select or create another child.
        delegationRequest = existingSlot.request;
      }
      if (delegationRequest || existingSlot) {
        if (primary.status === 'completed' && !existingSlot) reject('workflow_state_invalid', 'A completed primary cannot start a new delegation.');
        const slotKey = `event-delegation:${dispatch.id}:primary`;
        let slot = existingSlot;
        activeSlot = slot;
        if (slot) {
          org(slot, orgId, 'Delegation slot');
          same(slot.dispatchId, dispatch.id, 'Delegation dispatch');
          same(slot.slotKey, slotKey, 'Delegation slot key');
          if (typeof slot.requestHash !== 'string' || hash(slot.request) !== slot.requestHash) reject('delegation_slot_invalid', 'Delegation slot request changed after assignment.');
        }
        if (!slot || !slot.childWorkflowId) {
          const request = slot?.request ?? bounded(delegationRequest, limits);
          const candidate = slot?.employeeId ? { orgId, employeeId: slot.employeeId, active: true } : await a.selectCollaborator({ orgId, primaryEmployeeId: context.employeeId, request, profileTextIsUntrusted: true, event: context.event, subscription: context.subscription, principal: context.principal, connection: context.connection, managerUserId: context.managerUserId });
          org(candidate, orgId, 'Collaborator candidate');
          if (!candidate.employeeId || candidate.employeeId === context.employeeId || candidate.active !== true) reject('collaborator_denied', 'Candidate selection returned no eligible collaborator.');
          const child = await a.getEmployeeAuthority({ orgId, employeeId: candidate.employeeId, connection: context.connection, principal: context.principal, subscription: context.subscription, purpose: 'event_delegation' });
          org(child, orgId, 'Child employee authority');
          assertEmployee(child, CAPABILITY, 'Child employee');
          const childGrant = await a.authorizeSubscription({ orgId, subscription: context.subscription, principal: context.principal, employee: child, connection: context.connection, managerUserId: context.managerUserId, purpose: 'event_delegation', capability: CAPABILITY });
          if (!childGrant || childGrant.allowed !== true || childGrant.managerUserId !== context.managerUserId || childGrant.employeeId !== child.employeeId || childGrant.capability !== CAPABILITY || !childGrant.grantId || childGrant.revoked === true) reject('collaborator_denied', 'A current narrow manager grant for this employee and capability is required.');
          const childRisk = await a.assessRisk({ orgId, event: context.event, subscription: context.subscription, employee: child, connection: context.connection, capability: CAPABILITY });
          if (!childRisk || childRisk.allowed !== true) reject('risk_denied', 'Current risk policy did not explicitly allow child triage.');
          const planned = await planDelegation({ orgId, parentWorkflowId: primary.id, parentEmployeeId: context.employeeId, childEmployeeId: child.employeeId, taskGraph: primary.taskGraph ?? null, limits: { maxWidth: limits.maxWidth, maxDepth: limits.maxDepth, maxChildren: limits.maxChildren } });
          if (!planned || planned.allowed !== true || planned.cycle === true || planned.widthExceeded === true || planned.depthExceeded === true || planned.budgetExceeded === true || planned.sameEmployeeConcurrent === true) reject('dependency_denied', 'Task graph denied this delegation slot.');
          if (planned.depth !== undefined && planned.depth > limits.maxDepth) reject('dependency_denied', 'Delegation depth exceeds configured maximum.');
          const childFresh = await a.getEmployeeAuthority({ orgId, employeeId: child.employeeId, connection: context.connection, principal: context.principal, subscription: context.subscription, purpose: 'event_delegation' });
          org(childFresh, orgId, 'Refreshed child employee authority');
          assertEmployee(childFresh, CAPABILITY, 'Child employee');
          if (childFresh.deploymentId !== child.deploymentId || childFresh.capabilityVersion !== child.capabilityVersion || childFresh.policyVersion !== child.policyVersion) reject('authority_changed', 'Child deployment, capability, or policy changed before delegation creation.');
          const grantAgain = await a.authorizeSubscription({ orgId, subscription: context.subscription, principal: context.principal, employee: childFresh, connection: context.connection, managerUserId: context.managerUserId, purpose: 'event_delegation', capability: CAPABILITY });
          if (!grantAgain || grantAgain.allowed !== true || grantAgain.managerUserId !== context.managerUserId || grantAgain.employeeId !== childFresh.employeeId || grantAgain.capability !== CAPABILITY || !grantAgain.grantId || grantAgain.revoked === true) reject('collaborator_denied', 'The narrow manager grant was revoked or changed before child creation.');
          const riskAgain = await a.assessRisk({ orgId, event: context.event, subscription: context.subscription, employee: childFresh, connection: context.connection, capability: CAPABILITY });
          if (!riskAgain || riskAgain.allowed !== true) reject('risk_denied', 'Current risk policy no longer allows child triage.');
          const childKey = `${primaryKey}:child:${slotKey}`;
          const requestGoal = String(request.objective ?? request.goal ?? request.reason ?? '').trim().slice(0, 400);
          const childSpec = { idempotencyKey: childKey, orgId, role: 'child', employeeId: childFresh.employeeId, createdBy: context.managerUserId, servicePrincipalId: context.principalId, subscriptionId: context.subscriptionId, connectionId: context.connectionId, capability: CAPABILITY, goal: `Review the verified paid-order observation for customer-support implications${requestGoal ? `: ${requestGoal}` : '.'}`, runtimeVersion: 'event-simulation-v1', provenance: prov, observation: context.snapshot, observationHash: prov.observationHash, authoritySnapshot: { deploymentId: childFresh.deploymentId, capabilityVersion: childFresh.capabilityVersion, policyVersion: childFresh.policyVersion, grantId: grantAgain.grantId }, parentWorkflowId: primary.id, slotKey, request };
          const created = await d.ensureChildFenced({ orgId, dispatchId, lease, parentWorkflow: primary, parentExecutionGeneration: primary.executionGeneration, slotKey, existingSlot: slot, expectedSlotGeneration: slot?.generation ?? null, requestHash: hash(request), candidateEmployeeId: childFresh.employeeId, grantId: grantAgain.grantId, childSpec, task: { role: 'child', capability: CAPABILITY }, plan: planned, limits: { maxDepth: limits.maxDepth, maxWidth: limits.maxWidth, maxChildren: limits.maxChildren }, now: now() });
          if (created?.state === 'busy') {
            if (!created.slot || created.slot.employeeId !== childFresh.employeeId || created.slot.slotKey !== slotKey) reject('delegation_slot_invalid', 'Busy target must remain reserved in the immutable delegation slot.');
            slot = created.slot; activeSlot = slot;
            return pending({ dispatch, lease, workflow: primary, reason: 'delegation_target_busy' });
          }
          if (created?.updated !== true || !created.slot || !created.workflow) reject('lease_conflict', 'Child workflow, companion task, immutable delegation slot, and parent wait state were not atomically committed.', { retryable: true });
          slot = created.slot;
          activeSlot = slot;
        }
        if (slot.state === 'failed' || slot.state === 'cancelled') reject('delegation_terminal', 'The immutable delegation slot is terminal.');
        if (slot.state !== 'resolved') {
          const childWorkflow = await s.getWorkflow({ orgId, workflowId: slot.childWorkflowId });
          org(childWorkflow, orgId, 'Child workflow');
          if (childWorkflow.idempotencyKey !== `${primaryKey}:child:${slotKey}` || childWorkflow.role !== 'child' || childWorkflow.delegationSlotKey !== slotKey || childWorkflow.employeeId !== slot.employeeId || childWorkflow.capability !== CAPABILITY || childWorkflow.createdBy !== context.managerUserId || childWorkflow.servicePrincipalId !== context.principalId || childWorkflow.subscriptionId !== context.subscriptionId || childWorkflow.connectionId !== context.connectionId || childWorkflow.observationHash !== prov.observationHash || childWorkflow.provenance?.observationHash !== prov.observationHash || stable(childWorkflow.provenance) !== stable(prov)) reject('workflow_binding_invalid', 'Child workflow does not own its delegation slot and event provenance.');
          const currentChild = await a.getEmployeeAuthority({ orgId, employeeId: slot.employeeId, connection: context.connection, principal: context.principal, subscription: context.subscription, purpose: 'event_delegation' });
          org(currentChild, orgId, 'Current child employee authority');
          assertEmployee(currentChild, CAPABILITY, 'Child employee');
          if (currentChild.deploymentId !== childWorkflow.authoritySnapshot?.deploymentId || currentChild.capabilityVersion !== childWorkflow.authoritySnapshot?.capabilityVersion || currentChild.policyVersion !== childWorkflow.authoritySnapshot?.policyVersion) reject('authority_changed', 'Child authority changed after assignment.');
          const currentGrant = await a.authorizeSubscription({ orgId, subscription: context.subscription, principal: context.principal, employee: currentChild, connection: context.connection, managerUserId: context.managerUserId, purpose: 'event_delegation', capability: CAPABILITY });
          if (!currentGrant || currentGrant.allowed !== true || currentGrant.grantId !== childWorkflow.authoritySnapshot?.grantId || currentGrant.managerUserId !== context.managerUserId || currentGrant.employeeId !== slot.employeeId || currentGrant.capability !== CAPABILITY || currentGrant.revoked === true) reject('collaborator_denied', 'The assigned collaborator grant is no longer current.');
          const currentRisk = await a.assessRisk({ orgId, event: context.event, subscription: context.subscription, employee: currentChild, connection: context.connection, capability: CAPABILITY });
          if (!currentRisk || currentRisk.allowed !== true) reject('risk_denied', 'Current risk policy denied child review.');
          if (ACTIVE.has(childWorkflow.status)) {
            const childOutput = await executeReasoned(context, { ...dispatch, lease }, childWorkflow, 'child', { parentEvidenceRefs: primaryRefs, employee: currentChild });
            if (!childOutput || childOutput.pending === true) return pending({ dispatch, lease, workflow: { ...childWorkflow, continuation: childOutput?.continuation }, reason: 'child_reasoner_pending' });
            const childSaved = await workflowEvidence(context, { ...dispatch, lease }, childWorkflow, childWorkflow.executionGeneration, childOutput, 'child');
            if (childSaved.pending) return pending({ dispatch, lease, workflow: childSaved.workflow });
          }
          const latestChild = await s.getWorkflow({ orgId, workflowId: childWorkflow.id });
          if (latestChild.status !== 'completed') {
            if (ACTIVE.has(latestChild.status)) return pending({ dispatch, lease, workflow: latestChild });
            reject('child_terminal_failure', 'Child workflow failed before independent evidence verification.');
          }
          const childOutput = latestChild.output ?? { steps: latestChild.steps, result: latestChild.result };
          const childEvidence = await workflowEvidence(context, { ...dispatch, lease }, latestChild, latestChild.executionGeneration, childOutput, 'child');
          const resolved = await d.resolveFenced({ orgId, dispatchId, lease, slotId: slot.id, expectedSlotGeneration: slot.generation, childWorkflowId: latestChild.id, childExecutionGeneration: latestChild.executionGeneration, evidenceRefs: childEvidence.refs, now: now() });
          if (resolved?.updated !== true) reject('delegation_fence_conflict', 'Delegation resolution lost its slot or workflow fence.', { retryable: true });
          slot = resolved.slot ?? { ...slot, state: 'resolved' };
        }
        const parent = await s.getWorkflow({ orgId, workflowId: primary.id });
        if (parent.status === 'completed') output = parent.output ?? output;
        else {
          if (parent.status !== 'waiting_dependency') return pending({ dispatch, lease, workflow: parent });
          const resumed = await w.resume({ orgId, workflowId: parent.id, expectedExecutionGeneration: parent.executionGeneration, slotId: slot.id, expectedSlotGeneration: slot.generation, dependency: { childWorkflowId: slot.childWorkflowId, evidenceRefs: slot.evidenceRefs, result: slot.childResult }, dispatchLease: lease, allowedTools: LOCAL_TOOLS });
          if (!resumed || resumed.updated !== true) reject('execution_fence_conflict', 'Parent resume lost its workflow or dispatch fence.', { retryable: true });
          const updatedParent = await s.getWorkflow({ orgId, workflowId: parent.id });
          if (ACTIVE.has(updatedParent.status)) return pending({ dispatch, lease, workflow: updatedParent, reason: 'parent_resume_queued' });
          if (updatedParent.status !== 'completed') reject('parent_terminal_failure', 'Resumed parent did not complete successfully.');
          output = updatedParent.output ?? { steps: updatedParent.steps, result: updatedParent.result };
          primary = updatedParent;
          const parentEvidence = await workflowEvidence(context, { ...dispatch, lease }, primary, primary.executionGeneration, output, 'primary');
          primaryRefs = parentEvidence.refs;
        }
      } else if (primary.status === 'waiting_dependency') {
        return pending({ dispatch, lease, workflow: primary, reason: 'dependency_not_yet_requested' });
      }

      const latest = await s.getWorkflow({ orgId, workflowId: primary.id });
      if (latest.status !== 'completed' || latest.role !== 'primary') reject('workflow_terminal_failure', 'Primary workflow is not authoritatively complete.');
      const completed = await s.completeDispatchFenced({ orgId, dispatchId, lease, primaryWorkflowId: latest.id, primaryExecutionGeneration: latest.executionGeneration, result: latest.result, evidenceRefs: latest.evidenceRefs, delegationSlotId: activeSlot?.id ?? null, delegationSlotGeneration: activeSlot?.generation ?? null, now: now() });
      if (completed?.updated !== true) reject('stale_lease', 'Dispatch completion lost its lease or primary workflow fence.', { retryable: true });
      return { state: 'completed', dispatch: completed.dispatch, workflow: latest, replay: false };
    } catch (error) {
      if (transient(error)) {
        const retry = await s.retryDispatchFenced({ orgId, dispatchId, lease, maxAttempts: limits.maxAttempts, backoff: { baseDelayMs: limits.retryBaseDelayMs, maxDelayMs: limits.retryMaxDelayMs }, deadlineAt: dispatch.deadlineAt ?? null, error: { code: error.code ?? 'transient_failure', message: String(error.message ?? error).slice(0, 300) }, now: now() });
        if (retry?.updated !== true) return { state: 'lease_lost', replay: true };
        return { state: retry.state ?? 'retry', dispatch: retry.dispatch, pending: true, error: { code: error.code, message: error.message } };
      }
      if (!context) {
        if (transient(error)) throw error;
        const failed = await s.failChainFenced({ orgId, dispatchId, lease, slotId: null, expectedSlotGeneration: null, code: error.code ?? 'terminal_validation_failure', message: String(error.message ?? error).slice(0, 300), now: now() });
        if (failed?.updated !== true) return { state: 'lease_lost', replay: true };
        return { state: 'failed', dispatch: failed.dispatch, error: { code: error.code, message: error.message } };
      }
      return failTerminal(context, dispatch, lease, error, activeSlot);
    }
  }

  async function pending({ dispatch, lease, workflow, reason }) {
    if (workflow?.continuation !== undefined) {
      const saved = await s.saveContinuationFenced({ orgId: dispatch.orgId, dispatchId: dispatch.id, lease, workflowId: workflow.id, executionGeneration: workflow.executionGeneration, continuation: workflow.continuation, now: now() });
      if (saved?.updated !== true) reject('execution_fence_conflict', 'Pending continuation could not be durably stored.', { retryable: true });
    }
    const result = await s.retryDispatchFenced({ orgId: dispatch.orgId, dispatchId: dispatch.id, lease, pending: true, maxAttempts: limits.maxAttempts, backoff: { baseDelayMs: limits.retryBaseDelayMs, maxDelayMs: limits.retryMaxDelayMs }, deadlineAt: dispatch.deadlineAt ?? null, reason, now: now() });
    if (result?.updated !== true) reject('stale_lease', 'Pending state lost the dispatch lease.', { retryable: true });
    return { state: result.state ?? 'pending', dispatch: result.dispatch, workflow, pending: true };
  }

  return Object.freeze({ run });
}
