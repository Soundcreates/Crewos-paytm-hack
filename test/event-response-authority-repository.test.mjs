import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { createEventResponseAuthorityRepository } from '../backend/src/repositories/event-response-authority-repository.mjs';

const directory = mkdtempSync(join(tmpdir(), 'crewos-event-authority-'));
process.env.DATABASE_FILE = join(directory, 'authority.sqlite');
process.env.DATABASE_URL = '';
process.env.NODE_ENV = 'test';
const database = await import('../backend/lib/db.mjs');
const { all, get, run, transaction, closeDatabase } = database;
const repo = createEventResponseAuthorityRepository({ all, get, run, transaction, newId: () => 'test_id' });
const at = '2026-10-31T10:00:00.000Z';
const policyRevision = createHash('sha256').update('[]').digest('hex');
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const hash = (value) => createHash('sha256').update(stable(value)).digest('hex');

after(async () => {
  await closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

test('authority reads bind a signed simulated paid observation to current grants and real workflow tool runs', async () => {
  await run('INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)', 'org_authority', 'Authority', at);
  await run('INSERT INTO users(id,name,email,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)', 'user_manager', 'Manager', 'manager-authority@example.test', 'salt', 'hash', at);
  await run('INSERT INTO memberships(org_id,user_id,role,created_at) VALUES(?,?,?,?)', 'org_authority', 'user_manager', 'owner', at);
  for (const [id, name] of [['emp_sales', 'Sales'], ['emp_support', 'Support']]) {
    await run('INSERT INTO employees(id,org_id,name,title,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', id, 'org_authority', name, name, 'active', at, at);
  }
  const sourceSpec = { capabilities: ['commerce.order.analyze'], tools: [], coworkers: [] };
  const targetSpec = { capabilities: ['support.case.triage'], tools: [], coworkers: [] };
  await run('INSERT INTO employee_specs(id,employee_id,version,data,provenance,created_by,created_at) VALUES(?,?,?,?,?,?,?)', 'spec_sales', 'emp_sales', 1, JSON.stringify(sourceSpec), '[]', 'user_manager', at);
  await run('INSERT INTO employee_specs(id,employee_id,version,data,provenance,created_by,created_at) VALUES(?,?,?,?,?,?,?)', 'spec_support', 'emp_support', 1, JSON.stringify(targetSpec), '[]', 'user_manager', at);
  await run('INSERT INTO employee_deployments(id,org_id,employee_id,spec_version,runtime_version,policy_revision,evidence,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)', 'deploy_sales', 'org_authority', 'emp_sales', 1, 'event-simulation-v1', policyRevision, '{}', 'user_manager', at);
  await run('INSERT INTO employee_deployments(id,org_id,employee_id,spec_version,runtime_version,policy_revision,evidence,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)', 'deploy_support', 'org_authority', 'emp_support', 1, 'event-simulation-v1', policyRevision, '{}', 'user_manager', at);
  await run(`INSERT INTO provider_connections(id,org_id,provider,provider_account_id,environment,status,granted_scopes,config,created_at,updated_at)
    VALUES(?,?,?,?,?,'connected','[]',?,?,?)`, 'conn_authority', 'org_authority', 'shopify', 'fixture.myshopify.com', 'simulation', JSON.stringify({ fixture: true, identityVerified: true, effectsEnabled: false }), at, at);
  await run('INSERT INTO service_principals(id,org_id,kind,name,status,created_at) VALUES(?,?,?,?,?,?)', 'principal_authority', 'org_authority', 'org_service', 'Webhook simulation', 'active', at);
  await run(`INSERT INTO event_subscriptions(id,org_id,principal_id,employee_id,connection_id,event_type,required_capability,authorized_by,enabled,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?, ?,1,?,?)`, 'sub_authority', 'org_authority', 'principal_authority', 'emp_sales', 'conn_authority', 'orders/paid', 'commerce.order.analyze', 'user_manager', at, at);
  await run(`INSERT INTO provider_tool_readiness(org_id,tool,connection_id,capability,handler_id,verifier_id,readiness_state,probation_state,updated_at,policy_revision)
    VALUES(?,?,?,?,?,?,'ready','passed',?,?)`, 'org_authority', 'commerce.order.analyze', 'conn_authority', 'commerce.order.analyze', 'event-read-v1', 'event-verify-v1', at, policyRevision);
  await run(`INSERT INTO provider_tool_readiness(org_id,tool,connection_id,capability,handler_id,verifier_id,readiness_state,probation_state,updated_at,policy_revision)
    VALUES(?,?,?,?,?,?,'ready','passed',?,?)`, 'org_authority', 'support.case.triage', 'conn_authority', 'support.case.triage', 'event-read-v1', 'event-verify-v1', at, policyRevision);

  const raw = {
    occurred_at: at,
    order: { id: 'remote_100', currency: 'USD', total_price: '12.50', financial_status: 'paid', created_at: at, updated_at: at },
    _projection: { orderId: 'order_authority', paidVerified: true, simulated: true },
  };
  await run(`INSERT INTO event_inbox(id,org_id,provider,connection_id,external_event_id,event_type,environment,simulated,occurred_at,received_at,normalized,state)
    VALUES(?,?,?,?,?,'orders/paid','simulation',1,?, ?,?,'processed')`, 'inbox_authority', 'org_authority', 'shopify', 'conn_authority', 'evt_paid_100', at, at, JSON.stringify(raw));
  await run(`INSERT INTO canonical_orders(id,org_id,connection_id,environment,remote_order_id,currency,total_minor,payment_state,order_state,occurred_at,updated_at,simulated,last_event_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, 'order_authority', 'org_authority', 'conn_authority', 'simulation', 'remote_100', 'USD', 1250, 'refunded', 'open', at, at, 1, 'evt_paid_100');
  await run('INSERT INTO order_event_receipts(connection_id,external_event_id,order_id,event_type,created_at) VALUES(?,?,?,?,?)', 'conn_authority', 'evt_paid_100', 'order_authority', 'orders/paid', at);
  await run(`INSERT INTO employee_delegation_grants(id,org_id,grant_scope,source_employee_id,target_employee_id,capability,delegated_capability,subscription_id,principal_id,connection_id,environment,manager_signer_user_id,authorized_by_user_id,authorization_json,source_spec_revision,source_deployment_revision,target_spec_revision,target_deployment_revision,created_at,updated_at)
    VALUES(?,?,'event',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, 'grant_support', 'org_authority', 'emp_sales', 'emp_support', 'commerce.order.analyze', 'support.case.triage', 'sub_authority', 'principal_authority', 'conn_authority', 'simulation', 'user_manager', 'user_manager', '{}', '1', 'deploy_sales', '1', 'deploy_support', at, at);

  const verifiedEvent = await repo.verifyInboxEvent({ orgId: 'org_authority', inboxId: 'inbox_authority', eventId: 'evt_paid_100', expectedTopic: 'orders/paid', expectedConnectionId: 'conn_authority' });
  assert.equal(verifiedEvent.verified, true);
  assert.equal(verifiedEvent.eventVersion, 'evt_paid_100');
  assert.equal(verifiedEvent.paidOrderObservation.paymentState, 'paid');
  assert.equal((await repo.getActiveSubscription({ orgId: 'org_authority', inboxId: 'inbox_authority', subscriptionId: 'sub_authority' })).managerAuthorized, true);
  assert.equal((await repo.getServicePrincipal({ orgId: 'org_authority', principalId: 'principal_authority' })).kind, 'service');
  assert.equal((await repo.getConnectionEnvironment({ orgId: 'org_authority', connectionId: 'conn_authority' })).effectsEnabled, false);
  const primary = await repo.getEmployeeAuthority({ orgId: 'org_authority', employeeId: 'emp_sales', connection: { id: 'conn_authority' }, subscription: { requiredCapability: 'commerce.order.analyze' } });
  assert.equal(primary.active, true);
  assert.equal(primary.readiness, 'ready');
  const subscription = await repo.getActiveSubscription({ orgId: 'org_authority', inboxId: 'inbox_authority', subscriptionId: 'sub_authority' });
  const principal = await repo.getServicePrincipal({ orgId: 'org_authority', principalId: 'principal_authority' });
  const connection = await repo.getConnectionEnvironment({ orgId: 'org_authority', connectionId: 'conn_authority' });
  assert.equal((await repo.authorizeSubscription({ orgId: 'org_authority', subscription, principal, employee: primary, connection, managerUserId: 'user_manager', capability: 'commerce.order.analyze' })).allowed, true);
  const child = await repo.getEmployeeAuthority({ orgId: 'org_authority', employeeId: 'emp_support', connection, subscription, purpose: 'event_delegation' });
  assert.equal((await repo.authorizeSubscription({ orgId: 'org_authority', subscription, principal, employee: child, connection, managerUserId: 'user_manager', purpose: 'event_delegation', capability: 'support.case.triage' })).grantId, 'grant_support');
  await run("UPDATE employee_delegation_grants SET state='revoked' WHERE org_id=? AND id=?", 'org_authority', 'grant_support');
  assert.equal((await repo.authorizeSubscription({ orgId: 'org_authority', subscription, principal, employee: child, connection, managerUserId: 'user_manager', purpose: 'event_delegation', capability: 'support.case.triage' })).allowed, false);

  const workflowId = 'wf_evidence_authority';
  await run(`INSERT INTO workflows(id,org_id,employee_id,created_by,goal,status,runtime_version,plan,created_at,updated_at,lease_generation,spec_version,deployment_id,idempotency_key,origin,created_by_principal_id,origin_subscription_id,execution_generation,execution_role,provenance_json)
    VALUES(?,?,?,?,?,'completed','event-simulation-v1','[]',?,?,?,?,?,?,?,?,?,?,?,?)`, workflowId, 'org_authority', 'emp_sales', 'user_manager', 'Verify paid event', at, at, 7, 1, 'deploy_sales', 'event-dispatch:test', '{}', 'principal_authority', 'sub_authority', 7, 'primary', JSON.stringify({ inboxId: 'inbox_authority', eventVersion: 'evt_paid_100', connectionId: 'conn_authority' }));
  const observationHash = hash(verifiedEvent.paidOrderObservation);
  const stepInputHash = hash([{ tool: 'shopify.order.read_simulated', input: { connectionId: 'conn_authority', eventVersion: 'evt_paid_100', observationHash } }]);
  const input = { connectionId: 'conn_authority', eventVersion: 'evt_paid_100', observationHash };
  const output = { observationHash, observation: verifiedEvent.paidOrderObservation };
  await run(`INSERT INTO tool_runs(id,org_id,workflow_id,step_index,tool,input,output,status,lease_generation,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, 'toolrun_authority', 'org_authority', workflowId, 0, 'shopify.order.read_simulated', JSON.stringify(input), JSON.stringify(output), 'completed', 7, at);
  const step = { tool: 'shopify.order.read_simulated', input, output, toolRunRefs: [{ toolRunId: 'toolrun_authority' }] };
  const evidenceArgs = { orgId: 'org_authority', connectionId: 'conn_authority', eventVersion: 'evt_paid_100', workflowId, executionGeneration: 7, stepInputHash, toolRunRefs: ['toolrun_authority'], steps: [step], observation: verifiedEvent.paidOrderObservation, observationHash, role: 'primary' };
  assert.equal((await repo.verifyEventResponseEvidence(evidenceArgs)).verified, true);
  assert.equal((await repo.verifyEventResponseEvidence({ ...evidenceArgs, workflowId: 'wf_other_tenant' })).verified, false);
  assert.equal((await repo.verifyEventResponseEvidence({ ...evidenceArgs, executionGeneration: 6 })).verified, false);
  assert.equal((await repo.verifyEventResponseEvidence({ ...evidenceArgs, steps: [{ ...step, output: { ...output, paymentState: 'pending' } }] })).verified, false);
  await run("UPDATE tool_runs SET lease_generation=6 WHERE org_id=? AND id=?", 'org_authority', 'toolrun_authority');
  assert.equal((await repo.verifyEventResponseEvidence(evidenceArgs)).verified, false);
  await run("UPDATE tool_runs SET lease_generation=7 WHERE org_id=? AND id=?", 'org_authority', 'toolrun_authority');
  // A later refund changes canonical state, not the authenticated paid-event observation.
  await run("UPDATE canonical_orders SET payment_state='refunded' WHERE org_id=? AND id=?", 'org_authority', 'order_authority');
  assert.equal((await repo.verifyEventResponseEvidence(evidenceArgs)).verified, true);
  assert.equal(await repo.verifyInboxEvent({ orgId: 'org_other', inboxId: 'inbox_authority', eventId: 'evt_paid_100', expectedTopic: 'orders/paid', expectedConnectionId: 'conn_authority' }).then((x) => x.verified), false);
});
