import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash as sha256 } from 'node:crypto';
import { createEventEmployeeResponseService } from '../backend/src/services/event-employee-response.mjs';

const lease = Object.freeze({ owner: 'dispatcher-a', generation: 4, expiresAt: '2030-01-01T00:01:00.000Z' });

function fixture(overrides = {}) {
  const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
  const hash = (value) => sha256('sha256').update(stable(value)).digest('hex');
  const dispatch = { id: 'dispatch-a', orgId: 'org-a', inboxId: 'inbox-a', eventId: 'evt-a', topic: 'orders/paid', subscriptionId: 'sub-a', connectionId: 'conn-a', principalId: 'principal-a', employeeId: 'employee-a', managerUserId: 'user-manager', requiredCapability: 'commerce.order.analyze', environment: 'simulation', state: 'checking', leaseOwner: lease.owner, leaseGeneration: lease.generation };
  const event = { verified: true, orgId: 'org-a', inboxId: 'inbox-a', eventId: 'evt-a', topic: 'orders/paid', eventVersion: 'v17', subscriptionId: 'sub-a', connectionId: 'conn-a', environment: 'simulation', paidOrderObservation: { orderId: 'order-9', paymentState: 'paid', currency: 'USD', totalMinor: 4200, observedAt: '2026-10-31T10:00:00Z' } };
  const workflows = new Map();
  const slots = new Map();
  const calls = { ensuredPrimary: [], ensuredChild: [], reason: [], verify: [], complete: [], fail: [], retry: [], resume: [], continuation: [] };
  let runCount = 0;
  let reasonPending = false;
  let resumePending = false;
  let rejectVerifier = false;
  let candidate = 'employee-b';
  let slotGeneration = 1;
  const keyOfSlot = (dispatchId, slotKey) => `${dispatchId}:${slotKey}`;
  const outputFor = (workflow, withDelegation) => ({
    result: { conclusion: 'Paid order observation reviewed.', workflowId: workflow.id },
    steps: [{ tool: 'shopify.order.read_simulated', input: { orderId: 'order-9' }, output: { paymentState: 'paid', totalMinor: 4200 }, toolRunRefs: [`run:${workflow.id}`] }],
    continuation: { stage: 'reviewed', workflowId: workflow.id },
    ...(withDelegation ? { collaborationRequest: { objective: 'Independently triage any support follow-up.' } } : {}),
  });
  const employee = (employeeId, capability) => ({ orgId: 'org-a', employeeId, active: true, deploymentId: `deploy-${employeeId}`, capabilityVersion: `caps-${employeeId}`, policyVersion: 'policy-current', readiness: 'ready', probationPassed: true, capabilities: [capability] });
  const adapters = {
    now: () => '2026-10-31T10:01:00Z',
    authority: {
      verifyInboxEvent: async () => overrides.event ?? event,
      getActiveSubscription: async () => ({ orgId: 'org-a', id: 'sub-a', inboxId: 'inbox-a', connectionId: 'conn-a', principalId: 'principal-a', employeeId: 'employee-a', managerUserId: 'user-manager', requiredCapability: 'commerce.order.analyze', topic: 'orders/paid', active: true, managerAuthorized: true }),
      getServicePrincipal: async () => ({ orgId: 'org-a', id: 'principal-a', kind: 'service', active: true }),
      getConnectionEnvironment: async () => ({ orgId: 'org-a', id: 'conn-a', active: true, environment: 'simulation', effectsEnabled: false }),
      getEmployeeAuthority: async ({ employeeId }) => employee(employeeId, employeeId === 'employee-a' ? 'commerce.order.analyze' : 'support.case.triage'),
      findMembershipRole: async () => ({ role: 'manager' }),
      authorizeSubscription: async ({ employee, managerUserId, capability }) => ({ allowed: true, managerUserId, employeeId: employee.employeeId, capability: capability ?? employee.capabilities[0], grantId: `grant:${employee.employeeId}`, revoked: false }),
      assessRisk: async () => ({ allowed: true }),
      selectCollaborator: async () => ({ orgId: 'org-a', employeeId: candidate, active: true, profileText: 'untrusted ranking hint' }),
    },
    store: {
      getDispatch: async ({ orgId, dispatchId }) => orgId === dispatch.orgId && dispatchId === dispatch.id ? dispatch : null,
      getInbox: async ({ orgId }) => orgId === 'org-a' ? { orgId: 'org-a', id: 'inbox-a', eventId: 'evt-a', topic: 'orders/paid', connectionId: 'conn-a' } : null,
      getPaidOrderSnapshot: async ({ orgId, observation, connectionId, eventVersion }) => ({ orgId, connectionId, environment: 'simulation', simulated: true, paymentState: observation.paymentState, observationHash: hash(observation), eventVersion }),
      getWorkflow: async ({ orgId, workflowId, idempotencyKey }) => [...workflows.values()].find((wf) => wf.orgId === orgId && (workflowId ? wf.id === workflowId : wf.idempotencyKey === idempotencyKey)) ?? null,
      assertDispatchLease: async ({ orgId, dispatchId, lease: current }) => ({ valid: orgId === 'org-a' && dispatchId === 'dispatch-a' && current.owner === lease.owner && current.generation === lease.generation && overrides.expired !== true }),
      ensurePrimaryFenced: async ({ spec }) => {
        calls.ensuredPrimary.push(spec);
        const wf = { ...spec, id: 'workflow-primary', status: 'working', executionGeneration: 2, role: 'primary', orgId: spec.orgId, steps: null, result: null };
        workflows.set(wf.id, wf);
        dispatch.primaryWorkflowId = wf.id;
        return { updated: true, workflow: wf, task: { role: 'primary' }, dispatchPointer: true, publication: true };
      },
      recordWorkflowEvidenceFenced: async ({ workflowId, executionGeneration, result, output, continuation, evidenceRefs, status }) => {
        const wf = workflows.get(workflowId);
        if (!wf || wf.executionGeneration !== executionGeneration) return { updated: false };
        wf.result = result; wf.output = output; wf.steps = output.steps; wf.continuation = continuation; wf.evidenceRefs = evidenceRefs; wf.status = status;
        return { updated: true, workflow: wf };
      },
      completeDispatchFenced: async (record) => { calls.complete.push(record); dispatch.state = 'completed'; return { updated: true, dispatch }; },
      retryDispatchFenced: async ({ pending, lease: current }) => { calls.retry.push({ pending }); if (overrides.expired || current?.owner !== dispatch.leaseOwner || current?.generation !== dispatch.leaseGeneration) return { updated: false }; dispatch.state = 'retry'; return { updated: true, state: pending ? 'pending' : 'retry', dispatch }; },
      failChainFenced: async (record) => { calls.fail.push(record); dispatch.state = 'failed'; return { updated: true, dispatch }; },
      saveContinuationFenced: async (record) => { calls.continuation.push(record); return { updated: true }; },
    },
    workflowWorker: {
      runWorkflow: async ({ plan }) => ({ updated: true, output: plan }),
      resumeWorkflow: async ({ workflowId }) => {
        calls.resume.push(workflowId);
        const parent = workflows.get(workflowId);
        if (resumePending) return { updated: true };
        const output = outputFor(parent, false);
        parent.status = 'completed'; parent.output = output; parent.steps = output.steps; parent.result = output.result; parent.evidenceRefs = [{ id: `evidence:${workflowId}`, toolRunId: `run:${workflowId}` }]; parent.executionGeneration++;
        return { updated: true };
      },
    },
    taskGraph: { planDelegation: async ({ limits }) => ({ allowed: limits.maxDepth === 4, cycle: false, widthExceeded: false, depthExceeded: false, budgetExceeded: false, sameEmployeeConcurrent: false, depth: 2 }) },
    delegations: {
      getSlot: async ({ orgId, dispatchId, slotKey }) => orgId === 'org-a' ? slots.get(keyOfSlot(dispatchId, slotKey)) ?? null : null,
      ensureChildFenced: async ({ orgId, slotKey, requestHash, candidateEmployeeId, childSpec, parentWorkflow }) => {
        const slot = { id: 'slot-a', orgId, dispatchId: dispatch.id, slotKey, requestHash, employeeId: candidateEmployeeId, generation: slotGeneration, state: 'waiting', request: childSpec.request, childWorkflowId: 'workflow-child' };
        const child = { ...childSpec, id: 'workflow-child', role: 'child', status: overrides.childTerminal ? 'failed' : 'working', executionGeneration: 1, orgId, delegationSlotKey: slotKey, goal: 'Review the simulated paid order.' };
        slots.set(keyOfSlot(dispatch.id, slotKey), slot); workflows.set(child.id, child);
        parentWorkflow.status = 'waiting_dependency';
        calls.ensuredChild.push({ slot, child });
        return { updated: true, slot, workflow: child, task: { role: 'child' } };
      },
      resolveFenced: async ({ slotId, expectedSlotGeneration, evidenceRefs }) => {
        const slot = [...slots.values()].find((value) => value.id === slotId);
        if (!slot || slot.generation !== expectedSlotGeneration) return { updated: false };
        slot.state = 'resolved'; slot.evidenceRefs = evidenceRefs; slot.childResult = workflows.get(slot.childWorkflowId).result; slot.generation++;
        return { updated: true, slot };
      },
    },
    reasoner: {
      reason: async ({ workflowId, role, allowedTools }) => {
        calls.reason.push({ workflowId, role, allowedTools });
        if (reasonPending) return { pending: true };
        const wf = workflows.get(workflowId);
        const output = outputFor(wf, role === 'primary');
        calls.currentOutput = output;
        if (role === 'child') { wf.status = 'completed'; wf.output = output; wf.steps = output.steps; wf.result = output.result; }
        runCount++;
        return output;
      },
    },
    evidenceVerifier: {
      verify: async ({ orgId, connectionId, eventVersion, workflowId, executionGeneration, observationHash, stepInputHash, steps, toolRunRefs }) => {
        calls.verify.push({ workflowId, executionGeneration, toolRunRefs, steps });
        if (rejectVerifier) return { verified: false };
        return { verified: true, verifierId: 'verifier-fixture', bindings: { verifierId: 'verifier-fixture', stepInputHash, orgId, connectionId, eventVersion, workflowId, executionGeneration, observationHash }, refs: toolRunRefs.map((toolRunId) => ({ id: `evidence:${workflowId}`, toolRunId })) };
      },
    },
  };
  for (const [key, value] of Object.entries(overrides.adapters ?? {})) {
    if (adapters[key] && value && typeof value === 'object') Object.assign(adapters[key], value);
    else adapters[key] = value;
  }
  const svc = createEventEmployeeResponseService(adapters);
  const execute = () => svc.run({ orgId: 'org-a', dispatchId: 'dispatch-a', lease });
  const executeWithLease = (currentLease) => svc.run({ orgId: 'org-a', dispatchId: 'dispatch-a', lease: currentLease });
  return { svc, execute, executeWithLease, dispatch, event, workflows, slots, calls, setReasonPending: (v) => { reasonPending = v; }, setResumePending: (v) => { resumePending = v; }, rejectVerifier: (v) => { rejectVerifier = v; }, setCandidate: (v) => { candidate = v; }, setSlotGeneration: (v) => { slotGeneration = v; }, runCount: () => runCount };
}

test('primary and child are separately owned, use immutable slot, and complete from verified evidence', async () => {
  const f = fixture();
  const result = await f.execute();
  assert.equal(result.state, 'completed');
  assert.equal(f.calls.ensuredPrimary[0].idempotencyKey, 'event-dispatch:dispatch-a');
  assert.equal(f.calls.ensuredPrimary[0].createdBy, 'user-manager');
  assert.equal(f.calls.ensuredChild[0].child.capability, 'support.case.triage');
  assert.equal(f.calls.ensuredChild[0].slot.slotKey, 'event-delegation:dispatch-a:primary');
  assert.deepEqual(f.calls.reason[0].allowedTools, ['shopify.order.read_simulated']);
  assert.equal(f.calls.verify.length >= 2, true);
  assert.equal(f.dispatch.state, 'completed');
});

test('dispatch/inbox/subscription bindings and current authorization fail closed', async (t) => {
  await t.test('org scoped get', async () => { const f = fixture(); await assert.rejects(f.svc.run({ orgId: 'org-other', dispatchId: 'dispatch-a', lease }), { code: 'scope_mismatch' }); });
  await t.test('verified event connection mismatch', async () => { const f = fixture({ event: { ...fixture().event, connectionId: 'other' } }); const out = await f.execute(); assert.equal(out.state, 'failed'); assert.equal(f.calls.ensuredPrimary.length, 0); });
  await t.test('undefined grant', async () => {
    const f = fixture({ adapters: { authority: { authorizeSubscription: async () => undefined } } });
    const out = await f.execute(); assert.equal(out.state, 'failed'); assert.equal(f.calls.ensuredPrimary.length, 0);
  });
  await t.test('no manager role', async () => {
    const f = fixture({ adapters: { authority: { findMembershipRole: async () => ({ role: 'employee' }) } } });
    const out = await f.execute(); assert.equal(out.state, 'failed'); assert.equal(f.calls.ensuredPrimary.length, 0);
  });
  await t.test('undefined risk is denial', async () => {
    const f = fixture({ adapters: { authority: { assessRisk: async () => undefined } } });
    const out = await f.execute(); assert.equal(out.state, 'failed'); assert.equal(f.calls.ensuredPrimary.length, 0);
  });
});

test('missing and mismatched evidence are terminal validation failures', async () => {
  const f = fixture();
  f.rejectVerifier(true);
  const result = await f.execute();
  assert.equal(result.state, 'failed');
  assert.equal(f.calls.complete.length, 0);
  assert.equal(f.calls.fail.length, 1);
});

test('working workflow is in progress and queued asynchronous reasoning remains pending', async () => {
  const f = fixture();
  f.setReasonPending(true);
  const result = await f.execute();
  assert.equal(result.pending, true);
  assert.equal(result.state, 'pending');
  assert.equal(f.dispatch.state, 'retry');
  assert.equal(f.calls.complete.length, 0);
});

test('expired dispatch lease cannot create any rows', async () => {
  const f = fixture({ expired: true });
  const result = await f.execute();
  assert.equal(result.state, 'lease_lost');
  assert.equal(f.calls.ensuredPrimary.length, 0);
  assert.equal(f.calls.ensuredChild.length, 0);
});

test('stale dispatch generation stops without failing the dispatch', async () => {
  const f = fixture();
  const result = await f.executeWithLease({ ...lease, generation: 3 });
  assert.equal(result.state, 'lease_lost');
  assert.equal(f.dispatch.state, 'checking');
  assert.equal(f.calls.ensuredPrimary.length, 0);
  assert.equal(f.calls.fail.length, 0);
});

test('terminal child failure fences the chain and never resumes the parent', async () => {
  const f = fixture({ childTerminal: true });
  const result = await f.execute();
  assert.equal(result.state, 'failed');
  assert.equal(f.calls.resume.length, 0);
  assert.equal(f.calls.fail.length, 1);
});

test('a queued parent resume is pending rather than failed', async () => {
  const f = fixture();
  f.setResumePending(true);
  const result = await f.execute();
  assert.equal(result.pending, true);
  assert.equal(result.state, 'pending');
  assert.equal(f.dispatch.state, 'retry');
  assert.equal(f.calls.fail.length, 0);
});

test('resolved delegation replays without selecting or creating another child before parent resume', async () => {
  const f = fixture();
  f.setResumePending(true);
  const first = await f.execute();
  assert.equal(first.pending, true);
  assert.equal(f.slots.get('dispatch-a:event-delegation:dispatch-a:primary').state, 'resolved');
  f.setResumePending(false);
  f.dispatch.state = 'checking';
  const second = await f.execute();
  assert.equal(second.state, 'completed');
  assert.equal(f.calls.ensuredChild.length, 1);
});

test('completed parent with an unfinished dispatch replays evidence and completes without delegation', async () => {
  const f = fixture({ adapters: { reasoner: { reason: async ({ workflowId }) => {
    const workflow = f.workflows.get(workflowId);
    const output = { result: { conclusion: 'Paid order was analyzed.' }, steps: [{ tool: 'shopify.order.read_simulated', input: { orderId: 'order-9' }, output: { paymentState: 'paid' }, toolRunRefs: [`run:${workflowId}`] }] };
    f.calls.currentOutput = output;
    return output;
  } } } });
  const first = await f.execute();
  assert.equal(first.state, 'completed');
  assert.equal(f.calls.ensuredChild.length, 0);
  f.dispatch.state = 'checking';
  const second = await f.execute();
  assert.equal(second.state, 'completed');
  assert.equal(f.calls.ensuredPrimary.length, 1);
  assert.equal(f.calls.ensuredChild.length, 0);
});

test('transient reasoner errors retry without terminal chain failure', async () => {
  const f = fixture({ adapters: { reasoner: { reason: async () => { throw Object.assign(new Error('temporary'), { code: 'temporarily_unavailable' }); } } } });
  const result = await f.execute();
  assert.equal(result.state, 'retry');
  assert.equal(f.calls.fail.length, 0);
  assert.equal(f.calls.retry.length, 1);
});

test('same employee cannot be selected as a collaborator', async () => {
  const f = fixture();
  f.setCandidate('employee-a');
  const result = await f.execute();
  assert.equal(result.state, 'failed'); // self-collaboration is a terminal authorization violation
  assert.equal(f.calls.fail.length, 1);
  assert.equal(f.calls.retry.length, 0);
});
