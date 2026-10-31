import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createEventResponseDelegationRepository } from '../backend/src/repositories/event-response-delegation-repository.mjs';

const directory = mkdtempSync(join(tmpdir(), 'crewos-event-delegation-'));
process.env.DATABASE_FILE = join(directory, 'delegation.sqlite');
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.CREWOS_ORG_ENGINE_V2 = 'true';
process.env.CREWOS_ORG_ENGINE_V2_ORGS = 'org_response';
const database = await import('../backend/lib/db.mjs');
const { all, get, run, transaction, id, lockOrganization, lockEmployee, closeDatabase } = database;
const at = '2026-10-31T10:00:00.000Z';
const later = '2026-10-31T11:00:00.000Z';
const policyVersion = createHash('sha256').update('[]').digest('hex');
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const hash = (value) => createHash('sha256').update(stable(value)).digest('hex');
const repo = createEventResponseDelegationRepository({
  all, get, run, transaction, newId: id, lockOrganization, lockEmployee,
  planDelegation: async () => ({ allowed: true, depth: 1 }),
});

after(async () => {
  await closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

async function seed() {
  await run('INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)', 'org_response', 'Event response', at);
  await run('INSERT INTO users(id,name,email,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)', 'manager_response', 'Manager', 'event-manager@example.test', 'salt', 'hash', at);
  await run('INSERT INTO memberships(org_id,user_id,role,created_at) VALUES(?,?,?,?)', 'org_response', 'manager_response', 'owner', at);
  await run('INSERT INTO solari_profiles(id,org_id,provider_id,key_hash,name,created_by,created_at) VALUES(?,?,?,?,?,?,?)', 'support_profile', 'org_response', 'fixture', 'hash', 'Support profile', 'manager_response', at);
  await run('INSERT INTO employees(id,org_id,name,title,profile_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', 'employee_sales', 'org_response', 'Sales', 'Sales analyst', null, 'active', at, at);
  await run('INSERT INTO employees(id,org_id,name,title,profile_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', 'employee_support', 'org_response', 'Support', 'Support specialist', 'support_profile', 'active', at, at);
  await run('INSERT INTO employee_specs(id,employee_id,version,data,provenance,created_by,created_at) VALUES(?,?,?,?,?,?,?)',
    'spec_sales', 'employee_sales', 1, JSON.stringify({ capabilities: ['commerce.order.analyze'], coworkers: ['coworker_support'] }), '[]', 'manager_response', at);
  await run('INSERT INTO employee_specs(id,employee_id,version,data,provenance,created_by,created_at) VALUES(?,?,?,?,?,?,?)',
    'spec_support', 'employee_support', 2, JSON.stringify({ capabilities: ['support.case.triage'], coworkers: [] }), '[]', 'manager_response', at);
  await run('INSERT INTO coworkers(id,org_id,employee_id,name,role,expertise,summary,updated_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    'coworker_sales', 'org_response', 'employee_sales', 'Sales', 'Sales analyst', '["orders"]', '', at, at);
  await run('INSERT INTO coworkers(id,org_id,employee_id,name,role,expertise,summary,updated_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    'coworker_support', 'org_response', 'employee_support', 'Support', 'Support specialist', '["support","orders"]', '', at, at);
  await run('INSERT INTO employee_deployments(id,org_id,employee_id,spec_version,runtime_version,policy_revision,evidence,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    'deploy_sales', 'org_response', 'employee_sales', 1, 'event-simulation-v1', policyVersion, '{}', 'manager_response', at);
  await run('INSERT INTO employee_deployments(id,org_id,employee_id,spec_version,runtime_version,policy_revision,evidence,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    'deploy_support', 'org_response', 'employee_support', 2, 'event-simulation-v1', policyVersion, '{}', 'manager_response', at);
  await run(`INSERT INTO provider_connections(id,org_id,provider,provider_account_id,environment,status,granted_scopes,config,created_at,updated_at)
    VALUES(?,?,? ,?,'simulation','connected','[]',?,?,?)`, 'connection_response', 'org_response', 'shopify', 'fixture.myshopify.com',
  JSON.stringify({ fixture: true, identityVerified: true, effectsEnabled: false }), at, at);
  await run('INSERT INTO service_principals(id,org_id,kind,name,status,created_at) VALUES(?,?,?,?,?,?)', 'principal_response', 'org_response', 'org_service', 'Shopify fixtures', 'active', at);
  await run(`INSERT INTO event_subscriptions(id,org_id,principal_id,employee_id,connection_id,event_type,required_capability,authorized_by,enabled,created_at,updated_at)
    VALUES(?,?,?,?,?,'orders/paid','commerce.order.analyze','manager_response',1,?,?)`, 'subscription_response', 'org_response', 'principal_response',
  'employee_sales', 'connection_response', at, at);
  await run(`INSERT INTO provider_tool_readiness(org_id,tool,connection_id,capability,handler_id,verifier_id,readiness_state,probation_state,policy_revision,updated_at)
    VALUES(?,?,?,?,?,?,'ready','passed',?,?)`, 'org_response', 'support.case.triage', 'connection_response', 'support.case.triage', 'event-read-v1', 'verify-v1', policyVersion, at);
  const normalized = { order: { id: 'remote-55' }, _projection: { orderId: 'canonical-55', paidVerified: true, simulated: true } };
  await run(`INSERT INTO event_inbox(id,org_id,provider,connection_id,external_event_id,event_type,environment,simulated,received_at,normalized,state)
    VALUES(?,?,? ,?,'event-55','orders/paid','simulation',1,?,?,'processed')`, 'inbox_response', 'org_response', 'shopify', 'connection_response', at, JSON.stringify(normalized));
  const provenance = { kind: 'shopify_paid_order_observation', orgId: 'org_response', inboxId: 'inbox_response', dispatchId: 'dispatch_response',
    topic: 'orders/paid', eventId: 'event-55', eventVersion: 'event-55', subscriptionId: 'subscription_response', principalId: 'principal_response',
    managerUserId: 'manager_response', connectionId: 'connection_response', environment: 'simulation', observationHash: 'observation-hash' };
  const acceptedBinding = { orgId: 'org_response', inboxId: 'inbox_response', subscriptionId: 'subscription_response', principalId: 'principal_response',
    managerUserId: 'manager_response', employeeId: 'employee_sales', connectionId: 'connection_response', provider: 'shopify', eventType: 'orders/paid',
    environment: 'simulation', simulated: 1, sourceVersion: 'event-55', capability: 'commerce.order.analyze' };
  await run(`INSERT INTO event_dispatch_records(id,org_id,inbox_id,subscription_id,service_principal_id,manager_grant_user_id,task_id,state,worker_owner,
    lease_generation,lease_expires_at,attempts,outcome_json,dispatch_deadline_at,recovery_deadline_at,primary_workflow_id,created_at,updated_at)
    VALUES(?,?,?,?,?, ?,NULL,'running','response-worker',4,?,1,?,?,?, ?,?,?)`, 'dispatch_response', 'org_response', 'inbox_response', 'subscription_response',
  'principal_response', 'manager_response', later, JSON.stringify({ acceptedBinding }), later, later, 'workflow_primary', at, at);
  const primaryOrigin = { type: 'event_response', version: 1, dispatchId: 'dispatch_response', role: 'primary', connectionId: 'connection_response',
    subscriptionId: 'subscription_response', servicePrincipalId: 'principal_response', managerUserId: 'manager_response', observation: {}, authoritySnapshot: {} };
  await run(`INSERT INTO workflows(id,org_id,employee_id,created_by,goal,status,runtime_version,plan,created_at,updated_at,spec_version,deployment_id,
    idempotency_key,origin,created_by_principal_id,origin_subscription_id,lease_generation,execution_generation,execution_role,provenance_json,continuation_json)
    VALUES(?,?,?,?,?,'waiting_dependency','event-simulation-v1','[]',?,?,?,?,?,?,?,?,0,3,'primary',?,'{}')`, 'workflow_primary', 'org_response', 'employee_sales', 'manager_response',
  'Analyze order 55', at, at, 1, 'deploy_sales', 'event-dispatch:dispatch_response', JSON.stringify(primaryOrigin), 'principal_response', 'subscription_response', JSON.stringify(provenance));
  await run(`INSERT INTO crew_tasks(id,org_id,workflow_id,owner_employee_id,capability,goal,state,idempotency_key,correlation_id,spec_version,runtime_version,queue_owner,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'waiting_dependency',?,?,?,'event-simulation-v1','event_response_v1',?,?)`, 'workflow_primary', 'org_response', 'workflow_primary',
  'employee_sales', 'commerce.order.analyze', 'Analyze order 55', 'event-dispatch:dispatch_response', 'dispatch_response', 1, at, at);
  await run('UPDATE event_dispatch_records SET task_id=? WHERE org_id=? AND id=?', 'workflow_primary', 'org_response', 'dispatch_response');
  await run(`INSERT INTO event_workflow_evidence(id,org_id,dispatch_id,workflow_id,connection_id,source_event_id,event_version,observation_hash,step_input_hash,
    execution_generation,role,verifier_id,bindings_json,evidence_refs_json,result_json,continuation_json,verified_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,3,'primary','primary-verifier','{}','[]','{}','{}',?,?)`, 'primary_evidence', 'org_response', 'dispatch_response', 'workflow_primary',
  'connection_response', 'event-55', 'event-55', 'observation-hash', 'primary-input-hash', at, at);
  await run(`INSERT INTO employee_delegation_grants(id,org_id,grant_scope,source_employee_id,target_employee_id,capability,delegated_capability,subscription_id,principal_id,
    connection_id,environment,manager_signer_user_id,authorized_by_user_id,authorization_json,source_spec_revision,source_deployment_revision,target_spec_revision,
    target_deployment_revision,created_at,updated_at) VALUES(?,?,'event',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, 'grant_response', 'org_response', 'employee_sales',
  'employee_support', 'commerce.order.analyze', 'support.case.triage', 'subscription_response', 'principal_response', 'connection_response', 'simulation',
  'manager_response', 'manager_response', '{}', '1', 'deploy_sales', '2', 'deploy_support', at, at);
  await run(`INSERT INTO workflows(id,org_id,employee_id,created_by,goal,status,runtime_version,plan,created_at,updated_at,spec_version,deployment_id,
    idempotency_key,origin,lease_generation,execution_generation,execution_role,provenance_json,continuation_json)
    VALUES(?,?,?,?,?,'working','event-simulation-v1','[]',?,?,?,?,?,'{}',0,1,'legacy','{}','{}')`, 'workflow_busy', 'org_response', 'employee_support', 'manager_response',
  'Existing support work', at, at, 2, 'deploy_support', 'busy_work');
  await run(`INSERT INTO crew_tasks(id,org_id,workflow_id,owner_employee_id,capability,goal,state,idempotency_key,correlation_id,spec_version,runtime_version,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'running',?,?,?,'event-simulation-v1',?,?)`, 'task_busy', 'org_response', 'workflow_busy', 'employee_support', 'legacy.workflow',
  'Existing support work', 'busy_work', 'busy_work', 2, at, at);
  await run(`INSERT INTO employee_execution_locks(org_id,employee_id,workflow_id,task_id,worker_id,lease_generation,lease_expires_at,acquired_at,updated_at)
    VALUES(?,?,?,?,?,1,?,?,?)`, 'org_response', 'employee_support', 'workflow_busy', 'task_busy', 'legacy-worker', later, at, at);
  return { provenance, acceptedBinding };
}

const childSpec = (request = { objective: 'Check customer support implications.' }) => ({
  idempotencyKey: 'event-dispatch:dispatch_response:child:event-delegation:dispatch_response:primary', orgId: 'org_response', role: 'child',
  employeeId: 'employee_support', createdBy: 'manager_response', servicePrincipalId: 'principal_response', subscriptionId: 'subscription_response',
  connectionId: 'connection_response', capability: 'support.case.triage', goal: 'Review paid order support implications.', runtimeVersion: 'event-simulation-v1',
  provenance: { kind: 'shopify_paid_order_observation', orgId: 'org_response', inboxId: 'inbox_response', dispatchId: 'dispatch_response', topic: 'orders/paid',
    eventId: 'event-55', eventVersion: 'event-55', subscriptionId: 'subscription_response', principalId: 'principal_response', managerUserId: 'manager_response',
    connectionId: 'connection_response', environment: 'simulation', observationHash: 'observation-hash' },
  observation: {}, observationHash: 'observation-hash', authoritySnapshot: { deploymentId: 'deploy_support', capabilityVersion: '2', policyVersion, grantId: 'grant_response' },
  parentWorkflowId: 'workflow_primary', slotKey: 'event-delegation:dispatch_response:primary', request,
});

test('delegation creates a durable busy reservation, later creates a real child, and resolves only verified child evidence', async () => {
  await seed();
  const lease = { owner: 'response-worker', generation: 4, expiresAt: later };
  const spec = childSpec();
  const createArgs = { orgId: 'org_response', dispatchId: 'dispatch_response', lease,
    parentWorkflow: { id: 'workflow_primary', orgId: 'org_response', employeeId: 'employee_sales', executionGeneration: 3, status: 'waiting_dependency' },
    parentExecutionGeneration: 3, slotKey: spec.slotKey, existingSlot: null, expectedSlotGeneration: null,
    requestHash: hash(spec.request), candidateEmployeeId: 'employee_support', grantId: 'grant_response', childSpec: spec,
    task: { role: 'child', capability: 'support.case.triage' }, plan: { allowed: true, depth: 1 }, now: at };

  const waiting = await repo.ensureChildFenced(createArgs);
  assert.equal(waiting.updated, true);
  assert.equal(waiting.state, 'busy');
  assert.equal(waiting.slot.state, 'waiting');
  assert.equal(waiting.slot.employeeId, 'employee_support');
  assert.equal(waiting.slot.childWorkflowId, null);
  assert.equal(await get('SELECT id FROM workflows WHERE org_id=? AND idempotency_key=?', 'org_response', spec.idempotencyKey), undefined);

  await run("UPDATE crew_tasks SET state='completed' WHERE org_id=? AND id=?", 'org_response', 'task_busy');
  await run('DELETE FROM employee_execution_locks WHERE org_id=? AND employee_id=?', 'org_response', 'employee_support');
  const attached = await repo.ensureChildFenced({ ...createArgs, existingSlot: waiting.slot, expectedSlotGeneration: waiting.slot.generation, now: '2026-10-31T10:01:00.000Z' });
  assert.equal(attached.updated, true);
  assert.equal(attached.workflow.execution_role, 'child');
  assert.equal(attached.workflow.employee_id, 'employee_support');
  assert.equal(attached.slot.employeeId, 'employee_support');
  assert.equal(attached.slot.childWorkflowId, attached.workflow.id);
  assert.equal(attached.slot.childExecutionGeneration, 1);
  const childTask = await get('SELECT * FROM crew_tasks WHERE org_id=? AND id=?', 'org_response', attached.slot.childTaskId);
  assert.equal(childTask.workflow_id, attached.workflow.id);
  assert.equal(childTask.parent_task_id, 'workflow_primary');
  assert.equal(childTask.queue_owner, 'event_response_v1');
  assert.equal(childTask.state, 'queued');
  assert.equal(await get('SELECT * FROM employee_execution_locks WHERE org_id=? AND workflow_id=?', 'org_response', 'workflow_primary'), undefined);

  const toolInput = { connectionId: 'connection_response', eventVersion: 'event-55', observationHash: 'observation-hash' };
  const toolOutput = { orderId: 'canonical-55', simulated: true };
  await run(`INSERT INTO tool_runs(id,org_id,workflow_id,step_index,tool,input,output,status,lease_generation,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, 'child_tool_run', 'org_response', attached.workflow.id, 0, 'shopify.order.read_simulated',
  JSON.stringify(toolInput), JSON.stringify(toolOutput), 'completed', 1, at);
  await run("UPDATE workflows SET status='completed',result=?,finished_at=?,updated_at=? WHERE org_id=? AND id=? AND execution_generation=1",
    JSON.stringify({ answer: 'Support review complete' }), at, at, 'org_response', attached.workflow.id);
  await run("UPDATE crew_tasks SET state='completed',result_json=?,updated_at=? WHERE org_id=? AND workflow_id=?",
    JSON.stringify({ result: { answer: 'Support review complete' }, evidenceRefs: [{ toolRunId: 'child_tool_run' }] }), at, 'org_response', attached.workflow.id);
  const evidenceBindings = { orgId: 'org_response', connectionId: 'connection_response', workflowId: attached.workflow.id, eventVersion: 'event-55',
    executionGeneration: 1, stepInputHash: hash([{ tool: 'shopify.order.read_simulated', input: toolInput }]), observationHash: 'observation-hash', verifierId: 'child-verifier' };
  await run(`INSERT INTO event_workflow_evidence(id,org_id,dispatch_id,workflow_id,connection_id,source_event_id,event_version,observation_hash,step_input_hash,
    execution_generation,role,verifier_id,bindings_json,evidence_refs_json,result_json,continuation_json,verified_at,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,1,'child',?,?,?,?,?,?,?)`, 'child_evidence', 'org_response', 'dispatch_response', attached.workflow.id, 'connection_response',
  'event-55', 'event-55', 'observation-hash', evidenceBindings.stepInputHash, 'child-verifier', JSON.stringify(evidenceBindings),
  JSON.stringify([{ toolRunId: 'child_tool_run' }]), JSON.stringify({ result: { answer: 'Support review complete' } }), '{}', at, at);
  await run('INSERT INTO event_workflow_evidence_runs(org_id,evidence_id,tool_run_id) VALUES(?,?,?)', 'org_response', 'child_evidence', 'child_tool_run');
  const denied = await repo.resolveFenced({ orgId: 'org_response', dispatchId: 'dispatch_response', lease, slotId: attached.slot.id,
    expectedSlotGeneration: attached.slot.generation, childWorkflowId: attached.workflow.id, childExecutionGeneration: 1,
    evidenceRefs: [{ toolRunId: 'some-other-run' }], now: '2026-10-31T10:02:00.000Z' });
  assert.equal(denied.updated, false);

  await run("UPDATE employee_delegation_grants SET state='revoked',version=version+1 WHERE org_id=? AND id=?", 'org_response', 'grant_response');
  const revoked = await repo.resolveFenced({ orgId: 'org_response', dispatchId: 'dispatch_response', lease, slotId: attached.slot.id,
    expectedSlotGeneration: attached.slot.generation, childWorkflowId: attached.workflow.id, childExecutionGeneration: 1,
    evidenceRefs: [{ toolRunId: 'child_tool_run' }], now: '2026-10-31T10:02:00.000Z' });
  assert.equal(revoked.updated, false);
  await run("UPDATE employee_delegation_grants SET state='active',version=version+1 WHERE org_id=? AND id=?", 'org_response', 'grant_response');

  const resolved = await repo.resolveFenced({ orgId: 'org_response', dispatchId: 'dispatch_response', lease, slotId: attached.slot.id,
    expectedSlotGeneration: attached.slot.generation, childWorkflowId: attached.workflow.id, childExecutionGeneration: 1,
    evidenceRefs: [{ toolRunId: 'child_tool_run' }], now: '2026-10-31T10:03:00.000Z' });
  assert.equal(resolved.updated, true);
  assert.equal(resolved.slot.state, 'resolved');
  assert.equal(resolved.slot.generation, attached.slot.generation + 1);
  assert.deepEqual(resolved.slot.evidenceRefs, ['child_tool_run']);
  const replay = await repo.resolveFenced({ orgId: 'org_response', dispatchId: 'dispatch_response', lease, slotId: attached.slot.id,
    expectedSlotGeneration: attached.slot.generation, childWorkflowId: attached.workflow.id, childExecutionGeneration: 1,
    evidenceRefs: [{ toolRunId: 'child_tool_run' }], now: '2026-10-31T10:04:00.000Z' });
  assert.equal(replay.updated, false);
});

test('delegation creation fails closed on stale dispatch generation and a grant scoped to another event connection', async () => {
  // This test uses distinct rows in the same temporary database to assert the
  // transaction boundary before any child task or slot is published.
  const dispatch = await get('SELECT * FROM event_dispatch_records WHERE org_id=? AND id=?', 'org_response', 'dispatch_response');
  assert.ok(dispatch);
  const spec = childSpec();
  const common = { orgId: 'org_response', dispatchId: 'dispatch_response', lease: { owner: 'response-worker', generation: 3, expiresAt: later },
    parentWorkflow: { id: 'workflow_primary', orgId: 'org_response', employeeId: 'employee_sales', executionGeneration: 3, status: 'waiting_dependency' },
    parentExecutionGeneration: 3, slotKey: spec.slotKey, existingSlot: null, expectedSlotGeneration: null, requestHash: hash(spec.request),
    candidateEmployeeId: 'employee_support', grantId: 'grant_response', childSpec: spec, task: { role: 'child', capability: 'support.case.triage' },
    plan: { allowed: true }, now: '2026-10-31T10:05:00.000Z' };
  assert.deepEqual(await repo.ensureChildFenced(common), { updated: false });
  const before = await get('SELECT id,state,slot_generation FROM task_delegations WHERE org_id=? AND dispatch_id=? AND dispatch_slot_key=?', 'org_response', 'dispatch_response', spec.slotKey);
  const wrongScope = await repo.ensureChildFenced({ ...common, lease: { ...common.lease, generation: 4 }, childSpec: { ...spec, connectionId: 'another-connection' } });
  assert.deepEqual(wrongScope, { updated: false });
  const after = await get('SELECT id,state,slot_generation FROM task_delegations WHERE org_id=? AND dispatch_id=? AND dispatch_slot_key=?', 'org_response', 'dispatch_response', spec.slotKey);
  assert.deepEqual({ id: after.id, state: after.state, generation: after.slot_generation }, { id: before.id, state: before.state, generation: before.slot_generation });
  assert.equal((await all('SELECT id FROM workflows WHERE org_id=? AND idempotency_key=?', 'org_response', spec.idempotencyKey)).length, 1);
});
