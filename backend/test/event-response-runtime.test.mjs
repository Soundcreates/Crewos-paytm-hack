import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventResponseRuntime } from '../src/services/event-response-runtime.mjs';

test('runtime exposes coordinator adapter groups and normalizes membership', async () => {
  const fn = async () => ({});
  const reads = Object.fromEntries(['verifyInboxEvent','getActiveSubscription','getServicePrincipal','getConnectionEnvironment','getEmployeeAuthority','authorizeSubscription','verifyEventResponseEvidence'].map((x) => [x, fn]));
  reads.findMembershipRole = async () => ({ role: 'Manager' });
  const delegations = { planDelegation: fn };
  const runtime = createEventResponseRuntime({ repository: { store: {}, delegations, authorityReads: reads }, selector: { selectCollaborator: fn }, worker: { runWorkflow: fn, resumeWorkflow: fn }, policies: { assessRisk: fn }, llmJson: { reason: fn } });
  assert.deepEqual(Object.keys(runtime).sort(), ['authority','delegations','evidenceVerifier','reasoner','store','taskGraph','workflowWorker'].sort());
  assert.equal(await runtime.authority.findMembershipRole({}), 'manager');
  await assert.rejects(runtime.workflowWorker.runWorkflow({ allowedTools: ['shopify.order.write'] }), { code: 'tool_not_allowed' });
});

test('runtime rejects incomplete repository contract', () => {
  assert.throws(() => createEventResponseRuntime({ repository: {}, selector: {}, worker: {}, policies: {}, llmJson: {} }), /repository/);
});
