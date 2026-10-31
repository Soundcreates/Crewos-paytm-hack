import assert from 'node:assert/strict';
import test from 'node:test';
import { createActionGateway, mandatoryRiskDecision } from '../backend/src/services/action-gateway.mjs';

test('operation registration binds a single existing tool run and rejects duplicate idempotency key with changed input', async () => {
  let saved;
  const row = { org_id:'org_a',workflow_id:'wf_a',tool_run_id:'tr_a',tool:'jira.create_issue',input:'{"title":"A"}',tool_state:'started',connection_id:'c_a',environment:'staging',connection_state:'connected' };
  const repository = {
    findActionBindings: async (...args) => args[0] === 'org_a' ? row : null,
    findTaskByOrgAndId: async (org,id) => org==='org_a'&&id==='task_a'?{id,org_id:org,workflow_id:'wf_a'}:null,
    findOperationByIdempotency: async () => saved,
    insertExternalOperation: async (...args) => { saved = { id:args[0],org_id:args[1],workflow_id:args[2],tool_run_id:args[3],connection_id:args[4],environment:args[5],task_id:args[6],action:args[7],input_hash:args[8],idempotency_key:args[9],policy_revision:args[10],state:'pending' }; },
  };
  const gateway = createActionGateway({ repository,newId:()=>'op_a',timestamp:()=>new Date(0).toISOString() });
  const req = {orgId:'org_a',taskId:'task_a',workflowId:'wf_a',toolRunId:'tr_a',connectionId:'c_a',environment:'staging',action:'jira.create_issue',idempotencyKey:'same',policyRevision:'r1',input:{title:'A'}};
  assert.equal((await gateway.register(req)).tool_run_id,'tr_a');
  await assert.rejects(gateway.register({...req,orgId:'org_b'}),/ownership binding/);
  saved = {...saved,input_hash:'changed'};
  await assert.rejects(gateway.register(req), {code:'idempotency_conflict'});
});

test('mandatory high-risk floor is approval even with no ordinary policy', () => {
  assert.deepEqual(mandatoryRiskDecision('customer.message.send','staging'),{decision:'REQUIRE_APPROVAL',reason:'mandatory_high_risk_approval'});
  assert.deepEqual(mandatoryRiskDecision('payments.refund','simulation'),{decision:'ordinary_policy'});
  assert.deepEqual(mandatoryRiskDecision('payments.refund','staging'),{decision:'REQUIRE_APPROVAL',reason:'mandatory_high_risk_approval'});
  assert.equal(mandatoryRiskDecision('jira.search','staging').decision,'ordinary_policy');
});
