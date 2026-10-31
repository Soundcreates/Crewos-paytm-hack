import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEventResponseStoreRepository } from '../backend/src/repositories/event-response-store-repository.mjs';

const directory = mkdtempSync(join(tmpdir(), 'crewos-event-store-'));
process.env.DATABASE_FILE = join(directory, 'store.sqlite');
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
process.env.CREWOS_ORG_ENGINE_V2 = 'true';
process.env.CREWOS_ORG_ENGINE_V2_ORGS = 'org_store';
const database = await import('../backend/lib/db.mjs');
const { all, get, run, transaction, id, closeDatabase } = database;
const at = '2026-10-31T10:00:00.000Z';
const later = '2026-10-31T11:00:00.000Z';
const policyVersion = createHash('sha256').update('[]').digest('hex');
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const hash = (value) => createHash('sha256').update(stable(value)).digest('hex');

after(async () => {
  await closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

test('event response store requires SQL helpers and writes primary workflow, task, evidence, and dispatch binding atomically', async () => {
  assert.throws(() => createEventResponseStoreRepository(), /requires all, get, run, transaction, and newId/);
  await run('INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)', 'org_store', 'Event store', at);
  await run('INSERT INTO users(id,name,email,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)', 'manager_store', 'Manager', 'store-manager@example.test', 'salt', 'hash', at);
  await run('INSERT INTO memberships(org_id,user_id,role,created_at) VALUES(?,?,?,?)', 'org_store', 'manager_store', 'manager', at);
  await run('INSERT INTO employees(id,org_id,name,title,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', 'employee_store', 'org_store', 'Sales', 'Sales', 'active', at, at);
  await run('INSERT INTO employee_specs(id,employee_id,version,data,provenance,created_by,created_at) VALUES(?,?,?,?,?,?,?)', 'spec_store', 'employee_store', 1,
    JSON.stringify({ capabilities: ['commerce.order.analyze'] }), '[]', 'manager_store', at);
  await run('INSERT INTO employee_deployments(id,org_id,employee_id,spec_version,runtime_version,policy_revision,evidence,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    'deploy_store', 'org_store', 'employee_store', 1, 'event-simulation-v1', policyVersion, '{}', 'manager_store', at);
  await run(`INSERT INTO provider_connections(id,org_id,provider,provider_account_id,environment,status,granted_scopes,config,created_at,updated_at)
    VALUES(?,?,?,?,'simulation','connected','[]',?,?,?)`, 'connection_store', 'org_store', 'shopify', 'fixture.myshopify.com',
  JSON.stringify({ fixture: true, identityVerified: true, effectsEnabled: false }), at, at);
  await run('INSERT INTO service_principals(id,org_id,kind,name,status,created_at) VALUES(?,?,?,?,?,?)', 'principal_store', 'org_store', 'org_service', 'Events', 'active', at);
  await run(`INSERT INTO event_subscriptions(id,org_id,principal_id,employee_id,connection_id,event_type,required_capability,authorized_by,enabled,created_at,updated_at)
    VALUES(?,?,?,?,?,'orders/paid','commerce.order.analyze','manager_store',1,?,?)`, 'subscription_store', 'org_store', 'principal_store', 'employee_store', 'connection_store', at, at);
  await run(`INSERT INTO provider_tool_readiness(org_id,tool,connection_id,capability,handler_id,verifier_id,readiness_state,probation_state,policy_revision,updated_at)
    VALUES(?,?,?,?,?,?,'ready','passed',?,?)`, 'org_store', 'commerce.order.analyze', 'connection_store', 'commerce.order.analyze', 'event-read-v1', 'event-verify-v1', policyVersion, at);
  const observation = { orderId: 'order_store', remoteOrderId: 'remote-store-1', paymentState: 'paid', currency: 'USD', totalMinor: 1000, simulated: true };
  const provenance = { kind: 'shopify_paid_order_observation', orgId: 'org_store', inboxId: 'inbox_store', dispatchId: 'dispatch_store',
    topic: 'orders/paid', eventId: 'event_store', eventVersion: 'event_store', subscriptionId: 'subscription_store', principalId: 'principal_store',
    managerUserId: 'manager_store', connectionId: 'connection_store', environment: 'simulation', observationHash: hash(observation) };
  const acceptedBinding = { orgId: 'org_store', inboxId: 'inbox_store', subscriptionId: 'subscription_store', principalId: 'principal_store',
    managerUserId: 'manager_store', employeeId: 'employee_store', connectionId: 'connection_store', provider: 'shopify', eventType: 'orders/paid',
    environment: 'simulation', simulated: 1, sourceVersion: 'event_store', capability: 'commerce.order.analyze' };
  await run(`INSERT INTO event_inbox(id,org_id,provider,connection_id,external_event_id,event_type,environment,simulated,received_at,normalized,state)
    VALUES(?,?,?,?,'event_store','orders/paid','simulation',1,?,?,'processed')`, 'inbox_store', 'org_store', 'shopify', 'connection_store', at,
  JSON.stringify({ _projection: { paidVerified: true, simulated: true, orderId: 'order_store' } }));
  await run(`INSERT INTO event_dispatch_records(id,org_id,inbox_id,subscription_id,service_principal_id,manager_grant_user_id,state,worker_owner,lease_generation,
    lease_expires_at,attempts,outcome_json,dispatch_deadline_at,recovery_deadline_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'checking','store-worker',2,?,1,?,?,?, ?,?)`, 'dispatch_store', 'org_store', 'inbox_store', 'subscription_store', 'principal_store',
  'manager_store', later, JSON.stringify({ acceptedBinding }), later, later, at, at);
  const repo = createEventResponseStoreRepository({ all, get, run, transaction, newId: id, verifyEvidence: async ({
    orgId, connectionId, eventVersion, workflowId, executionGeneration, stepInputHash, observationHash,
  }) => ({ verified: true, verifierId: 'store-verifier', refs: [{ toolRunId: 'tool_store' }], bindings: {
    orgId, connectionId, eventVersion, workflowId, executionGeneration, stepInputHash, observationHash, verifierId: 'store-verifier',
  } }) });
  const lease = { owner: 'store-worker', generation: 2, expiresAt: later };
  const spec = { orgId: 'org_store', role: 'primary', employeeId: 'employee_store', createdBy: 'manager_store', servicePrincipalId: 'principal_store',
    subscriptionId: 'subscription_store', connectionId: 'connection_store', capability: 'commerce.order.analyze',
    goal: 'Analyze the authenticated paid order.', runtimeVersion: 'event-simulation-v1', idempotencyKey: 'event-dispatch:dispatch_store',
    observation, observationHash: hash(observation), provenance, authoritySnapshot: { deploymentId: 'deploy_store', capabilityVersion: '1', policyVersion },
  };
  const publication = { queue: 'event-simulation-local', toolAllowlist: ['shopify.order.read_simulated'] };
  const created = await repo.ensurePrimaryFenced({ orgId: 'org_store', dispatchId: 'dispatch_store', lease, spec,
    task: { capability: 'commerce.order.analyze' }, publication, now: at });
  assert.equal(created.updated, true);
  assert.equal(created.workflow.role, 'primary');
  assert.equal(created.workflow.capability, 'commerce.order.analyze');
  assert.equal(created.workflow.executionGeneration, 1);
  const dispatch = await get('SELECT state,primary_workflow_id,task_id FROM event_dispatch_records WHERE org_id=? AND id=?', 'org_store', 'dispatch_store');
  assert.deepEqual({ state: dispatch.state, primaryWorkflowId: dispatch.primary_workflow_id, taskId: dispatch.task_id },
    { state: 'running', primaryWorkflowId: created.workflow.id, taskId: created.workflow.id });
  assert.equal((await get('SELECT state,queue_owner FROM crew_tasks WHERE org_id=? AND workflow_id=?', 'org_store', created.workflow.id)).queue_owner, 'event_response_v1');
  const replay = await repo.ensurePrimaryFenced({ orgId: 'org_store', dispatchId: 'dispatch_store', lease, spec, task: { capability: 'commerce.order.analyze' }, publication, now: at });
  assert.equal(replay.updated, true);
  assert.equal(replay.workflow.id, created.workflow.id);

  const input = { connectionId: 'connection_store', eventVersion: 'event_store', observationHash: hash(observation) };
  const output = { observation, observationHash: hash(observation) };
  const tool = await run(`INSERT INTO tool_runs(id,org_id,workflow_id,step_index,tool,input,output,status,lease_generation,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, 'tool_store', 'org_store', created.workflow.id, 0, 'shopify.order.read_simulated', JSON.stringify(input), JSON.stringify(output), 'completed', 1, at);
  assert.ok(tool);
  const step = { tool: 'shopify.order.read_simulated', input, output, toolRunRefs: [{ toolRunId: 'tool_store' }] };
  const evidenceArgs = { orgId: 'org_store', dispatchId: 'dispatch_store', lease, workflowId: created.workflow.id,
    executionGeneration: 1, role: 'primary', result: { answer: 'Order analyzed.' }, output: { steps: [step], result: { answer: 'Order analyzed.' } },
    continuation: null, evidenceRefs: [{ toolRunId: 'tool_store' }], now: at };
  const waiting = await repo.recordWorkflowEvidenceFenced({ ...evidenceArgs, status: 'waiting_dependency' });
  assert.equal(waiting.updated, true);
  assert.equal(waiting.workflow.status, 'waiting_dependency');
  assert.equal(Number((await get('SELECT lease_generation FROM workflows WHERE org_id=? AND id=?', 'org_store', created.workflow.id)).lease_generation), 1);
  assert.equal(Number((await get('SELECT lease_generation FROM crew_tasks WHERE org_id=? AND workflow_id=?', 'org_store', created.workflow.id)).lease_generation), 1);
  const saved = await repo.recordWorkflowEvidenceFenced({ ...evidenceArgs, status: 'completed' });
  assert.equal(saved.updated, true);
  assert.equal(saved.workflow.status, 'completed');
  assert.equal((await get('SELECT id FROM event_workflow_evidence WHERE org_id=? AND workflow_id=? AND execution_generation=1', 'org_store', created.workflow.id)).id.length > 0, true);
  assert.equal((await all('SELECT tool_run_id FROM event_workflow_evidence_runs WHERE org_id=?', 'org_store')).length, 1);
  const stale = await repo.recordWorkflowEvidenceFenced({ ...evidenceArgs, lease: { ...lease, generation: 1 }, status: 'completed' });
  assert.equal(stale.updated, false);
});
