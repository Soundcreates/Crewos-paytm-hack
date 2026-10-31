import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createFoundationRepository } from '../backend/src/repositories/foundation-repository.mjs';
import { capabilityGrantFingerprint, createEventDispatcher } from '../backend/src/services/event-dispatcher.mjs';
import { createOperationApprovalService } from '../backend/src/services/operation-approvals.mjs';
import { createTaskGraphService } from '../backend/src/services/task-graph.mjs';
import { buildEmployeeToolRegistry, providerToolAvailable } from '../backend/workflows/langgraph/tool-registry.mjs';

const now=()=> '2026-10-31T00:00:00.000Z';

test('employee execution lock is atomic per tenant and fences concurrent legacy/task claimants', async()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE employee_execution_locks(org_id TEXT,employee_id TEXT,workflow_id TEXT,task_id TEXT,worker_id TEXT,lease_generation INTEGER,lease_expires_at TEXT,acquired_at TEXT,updated_at TEXT,PRIMARY KEY(org_id,employee_id));`);
  const repo=createFoundationRepository({get:(sql,...p)=>db.prepare(sql).get(...p),all:(sql,...p)=>db.prepare(sql).all(...p),run:(sql,...p)=>{const r=db.prepare(sql).run(...p);return {changes:Number(r.changes)};}});
  const claims=await Promise.all([
    repo.acquireEmployeeExecutionLock('org_a','emp_1','wf_1','task_1','worker_legacy',1,'2026-10-31T00:01:00.000Z',now()),
    repo.acquireEmployeeExecutionLock('org_a','emp_1','wf_2','task_2','worker_task',1,'2026-10-31T00:01:00.000Z',now()),
  ]);
  assert.deepEqual(claims.map(row=>row.changes).sort(),[0,1]);
  assert.equal((await repo.findActiveEmployeeExecutionLock('org_a','emp_1',now())).workflow_id,claims[0].changes===1?'wf_1':'wf_2');
  assert.equal((await repo.acquireEmployeeExecutionLock('org_b','emp_1','wf_b','task_b','worker_b',1,'2026-10-31T00:01:00.000Z',now())).changes,1);
  db.close();
});

test('legacy workflow companion is lazily backfilled only from the same-org workflow owner',async()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE employees(id TEXT,org_id TEXT,PRIMARY KEY(org_id,id));
    CREATE TABLE workflows(id TEXT PRIMARY KEY,org_id TEXT,employee_id TEXT,goal TEXT,status TEXT,spec_version INTEGER,runtime_version TEXT,worker_id TEXT,lease_generation INTEGER,lease_expires_at TEXT,created_at TEXT,updated_at TEXT,UNIQUE(org_id,id));
    CREATE TABLE crew_tasks(id TEXT PRIMARY KEY,org_id TEXT,workflow_id TEXT,owner_employee_id TEXT,capability TEXT,goal TEXT,state TEXT,idempotency_key TEXT UNIQUE,correlation_id TEXT,spec_version INTEGER,runtime_version TEXT,worker_id TEXT,lease_generation INTEGER DEFAULT 0,lease_expires_at TEXT,created_at TEXT,updated_at TEXT,UNIQUE(org_id,id),UNIQUE(org_id,idempotency_key));`);
  db.prepare('INSERT INTO employees VALUES(?,?)').run('emp_a','org_a');
  db.prepare('INSERT INTO employees VALUES(?,?)').run('emp_b','org_b');
  db.prepare('INSERT INTO workflows VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('wf_old','org_a','emp_a','Resume my task','input_required',2,'langgraph-react-v1',null,0,null,now(),now());
  db.prepare('INSERT INTO workflows VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('wf_working','org_a','emp_a','Keep worker lease','working',2,'langgraph-react-v1','worker_a',7,'2026-10-31T00:01:00.000Z',now(),now());
  const repo=createFoundationRepository({get:(sql,...p)=>db.prepare(sql).get(...p),all:(sql,...p)=>db.prepare(sql).all(...p),run:(sql,...p)=>{const r=db.prepare(sql).run(...p);return {changes:Number(r.changes)};}});
  const task=await repo.ensureWorkflowTaskCompanion('org_a','wf_old',now());
  assert.equal(task.org_id,'org_a');
  assert.equal(task.workflow_id,'wf_old');
  assert.equal(task.owner_employee_id,'emp_a');
  assert.equal(task.state,'waiting_approval');
  assert.equal((await repo.ensureWorkflowTaskCompanion('org_a','wf_old',now())).id,task.id);
  const active=await repo.ensureWorkflowTaskCompanion('org_a','wf_working',now());
  assert.equal(active.state,'running');
  assert.equal(active.worker_id,'worker_a');
  assert.equal(active.lease_generation,7);
  assert.equal(active.lease_expires_at,'2026-10-31T00:01:00.000Z');
  assert.equal(await repo.ensureWorkflowTaskCompanion('org_b','wf_old',now()),null);
  db.close();
});

test('team membership and task ownership rechecks are SQL scoped to the requesting organization',async()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE employee_team_memberships(org_id TEXT,team_id TEXT,employee_id TEXT); CREATE TABLE crew_tasks(id TEXT,org_id TEXT,state TEXT,owner_employee_id TEXT,workflow_id TEXT);`);
  db.prepare('INSERT INTO employee_team_memberships VALUES(?,?,?)').run('org_a','team_shared','emp_a');
  db.prepare('INSERT INTO employee_team_memberships VALUES(?,?,?)').run('org_b','team_shared','emp_b');
  db.prepare('INSERT INTO crew_tasks VALUES(?,?,?,?,?)').run('task_a','org_a','queued','emp_a',null);
  db.prepare('INSERT INTO crew_tasks VALUES(?,?,?,?,?)').run('task_b','org_b','queued','emp_b',null);
  const repo=createFoundationRepository({get:(sql,...p)=>db.prepare(sql).get(...p),all:(sql,...p)=>db.prepare(sql).all(...p),run:(sql,...p)=>{const r=db.prepare(sql).run(...p);return {changes:Number(r.changes)};}});
  assert.deepEqual((await repo.verifyEmployeeTeamMemberships('org_a','emp_a',['team_shared'])).map(row=>row.team_id),['team_shared']);
  assert.deepEqual(await repo.verifyEmployeeTeamMemberships('org_a','emp_b',['team_shared']),[]);
  assert.equal((await repo.findTaskByOrgAndId('org_a','task_b')),undefined);
  assert.equal((await repo.findTaskByOrgAndId('org_a','task_a')).owner_employee_id,'emp_a');
  db.close();
});

function dispatcherRepo(overrides={}) {
  return {
    findActiveSubscriptionForDispatch:async()=>({id:'sub1',principal_id:'principal1',employee_id:'emp1',connection_id:'connection1',event_type:'orders/paid',enabled:1,principal_kind:'org_service',principal_status:'active',authorized_by:'manager',environment:'simulation',connection_status:'connected',connection_config:'{"fixture":true,"identityVerified":true,"effectsEnabled":false}',granted_scopes:'["read_orders"]',required_scopes:'["read_orders"]',revoked_at:null,credential_expires_at:null,employee_state:'active',deployment_id:'dep1',spec_data:'{"capabilities":["commerce.order.analyze"]}',spec_version:1,required_capability:'commerce.order.analyze',capability_grant_hash:capabilityGrantFingerprint('commerce.order.analyze',1),readiness_state:'ready',probation_state:'passed',handler_id:'handler',verifier_id:'verifier',readiness_policy_revision:'rev1'}),
    findMembershipRole:async()=> 'manager',
    ...overrides,
  };
}

function dispatchRow(overrides={}) {
  const row={id:'dispatch1',org_id:'org_a',inbox_id:'inbox1',subscription_id:'sub1',service_principal_id:'principal1',manager_grant_user_id:'manager',
    employee_id:'emp1',connection_id:'connection1',provider:'shopify',event_type:'orders/paid',external_event_id:'event1',inbox_environment:'simulation',
    simulated:1,required_capability:'commerce.order.analyze',spec_version:1,deployment_id:'dep1',...overrides};
  const acceptedBinding={orgId:row.org_id,inboxId:row.inbox_id,subscriptionId:row.subscription_id,principalId:row.service_principal_id,managerUserId:row.manager_grant_user_id,
    employeeId:row.employee_id,connectionId:row.connection_id,provider:row.provider,eventType:row.event_type,environment:row.inbox_environment,simulated:Number(row.simulated),
    sourceVersion:row.external_event_id,capability:row.required_capability,specVersion:Number(row.spec_version),deploymentId:row.deployment_id};
  return {...row,outcome_json:JSON.stringify({acceptedBinding})};
}

function claimedDispatchRepo(overrides={}) {
  let claim;
  return dispatcherRepo({
    claimEventDispatch:async(_org,_id,owner,leaseUntil)=>{claim={owner,leaseUntil,generation:4};return{changes:1};},
    findDispatchById:async(_org,id)=>({id,worker_owner:claim?.owner,state:'checking',lease_generation:claim?.generation,lease_expires_at:claim?.leaseUntil}),
    ...overrides,
  });
}

test('event dispatch is tenant-bound, service-principal authorized, and blocked without a real worker adapter',async()=>{
  const repository=dispatcherRepo();
  const dispatcher=createEventDispatcher({repository,timestamp:now,newId:()=> 'dispatch1',env:{CREWOS_ORG_ENGINE_V2:'true',CREWOS_ORG_ENGINE_V2_ORGS:'org_a'},checkPolicy:async()=>({decision:'ALLOW'}),riskFloor:()=>({decision:'ALLOW'}),currentPolicyRevision:async()=> 'rev1'});
  const good=await dispatcher.authorize(dispatchRow());
  assert.equal(good.allowed,false);
  assert.equal(good.reason,'worker_adapter_disabled');
  const wrongOrg=await dispatcher.authorize(dispatchRow({org_id:'org_b'}));
  assert.equal(wrongOrg.reason,'organization_engine_v2_disabled');
  assert.equal((await dispatcher.authorize({...dispatchRow(),outcome_json:JSON.stringify({acceptedBinding:{...JSON.parse(dispatchRow().outcome_json).acceptedBinding,connectionId:'foreign'}})})).allowed,false);
});

test('authorized event dispatch remains blocked and cannot enqueue a workflow or execute an effect',async()=>{
  let recorded;
  const repository=claimedDispatchRepo({
    findDispatchInputs:async()=>dispatchRow({id:'d1'}),
    finishEventDispatch:async(_org,_id,_owner,_generation,state,reason,outcome)=>{recorded={state,reason,outcome};return {changes:1};},
  });
  const dispatcher=createEventDispatcher({repository,timestamp:now,newId:()=> 'd1',env:{CREWOS_ORG_ENGINE_V2:'true',CREWOS_ORG_ENGINE_V2_ORGS:'org_a'},checkPolicy:async()=>({decision:'ALLOW'}),riskFloor:()=>({decision:'ALLOW'}),currentPolicyRevision:async()=> 'rev1'});
  const result=await dispatcher.dispatch('org_a','d1');
  assert.equal(result.state,'blocked');
  assert.equal(result.reason,'worker_adapter_disabled');
  assert.equal(recorded.outcome.taskCreated,false);
  assert.equal(recorded.outcome.workflowEnqueued,false);
  assert.equal(recorded.outcome.effectExecuted,false);
});

test('explicitly authorized simulated order dispatch links one workflow before the existing worker starts it',async()=>{
  const sequence=[];let saved;
  const repository=claimedDispatchRepo({findDispatchInputs:async()=>dispatchRow({id:'d1'}),linkEventDispatchTask:async()=>{sequence.push('linked');return{changes:1};},finishEventDispatch:async(_org,_id,_owner,_generation,state,_reason,outcome)=>{saved={state,outcome};sequence.push('committed');return{changes:1};}});
  const dispatcher=createEventDispatcher({repository,timestamp:now,newId:()=> 'd1',env:{CREWOS_ORG_ENGINE_V2:'true',CREWOS_ORG_ENGINE_V2_ORGS:'org_a'},checkPolicy:async()=>({decision:'ALLOW'}),riskFloor:()=>({decision:'ordinary_policy'}),currentPolicyRevision:async()=> 'rev1',workerAdapterEnabled:true,enqueueSimulationWorkflow:async()=>({taskId:'workflow1',workflowId:'workflow1'}),startSimulationWorkflow:async()=>sequence.push('started')});
  const result=await dispatcher.dispatch('org_a','d1');
  assert.equal(result.state,'enqueued');assert.equal(saved.state,'enqueued');assert.equal(saved.outcome.effectExecuted,false);assert.deepEqual(sequence,['linked','committed','started']);
});

test('event dispatch blocks unauthorized principal, missing capability, expired or revoked connection, and policy changes',async()=>{
  const base={id:'sub',principal_id:'principal1',connection_id:'connection1',event_type:'orders/paid',employee_id:'emp1',enabled:1,principal_kind:'org_service',principal_status:'active',authorized_by:'manager',environment:'simulation',connection_status:'connected',connection_config:'{"fixture":true,"identityVerified":true,"effectsEnabled":false}',granted_scopes:'["read_orders"]',required_scopes:'["read_orders"]',employee_state:'active',deployment_id:'dep',spec_data:'{"capabilities":["commerce.order.analyze"]}',spec_version:1,required_capability:'commerce.order.analyze',capability_grant_hash:capabilityGrantFingerprint('commerce.order.analyze',1),readiness_state:'ready',probation_state:'passed',handler_id:'handler',verifier_id:'verifier',readiness_policy_revision:'rev1'};
  for (const [overrides,checkPolicy,reason] of [
    [{findActiveSubscriptionForDispatch:async()=>null},async()=>({decision:'ALLOW'}),'subscription_disabled'],
    [{findActiveSubscriptionForDispatch:async()=>({...base,principal_kind:'manager'})},async()=>({decision:'ALLOW'}),'service_principal_invalid'],
    [{findActiveSubscriptionForDispatch:async()=>({...base,spec_data:'{"capabilities":[]}'})},async()=>({decision:'ALLOW'}),'employee_capability_missing'],
    [{findActiveSubscriptionForDispatch:async()=>({...base,granted_scopes:'[]'})},async()=>({decision:'ALLOW'}),'connection_scope_missing'],
    [{findActiveSubscriptionForDispatch:async()=>({...base,credential_expires_at:'2020-01-01T00:00:00.000Z'})},async()=>({decision:'ALLOW'}),'connection_credential_expired'],
    [{findActiveSubscriptionForDispatch:async()=>({...base,connection_status:'revoked',revoked_at:now()})},async()=>({decision:'ALLOW'}),'connection_unavailable'],
    [{},async()=>({decision:'DENY'}),'current_policy_denied'],
  ]) {
    const dispatcher=createEventDispatcher({repository:dispatcherRepo(overrides),timestamp:now,newId:()=> 'dispatch',env:{CREWOS_ORG_ENGINE_V2:'true',CREWOS_ORG_ENGINE_V2_ORGS:'org_a'},checkPolicy,riskFloor:()=>({decision:'ALLOW'}),currentPolicyRevision:async()=> 'rev1'});
    const result=await dispatcher.authorize(dispatchRow({subscription_id:'sub'}));
    assert.equal(result.reason,reason);
  }
  const highRisk=createEventDispatcher({repository:dispatcherRepo(),timestamp:now,newId:()=> 'dispatch',env:{CREWOS_ORG_ENGINE_V2:'true',CREWOS_ORG_ENGINE_V2_ORGS:'org_a'},checkPolicy:async()=>({decision:'ALLOW'}),riskFloor:()=>({decision:'REQUIRE_APPROVAL'}),currentPolicyRevision:async()=> 'rev1'});
  assert.equal((await highRisk.authorize(dispatchRow({subscription_id:'sub'}))).reason,'mandatory_risk_approval_unavailable');
  const fixtureProd=createEventDispatcher({repository:dispatcherRepo({findActiveSubscriptionForDispatch:async()=>({enabled:1,principal_kind:'org_service',principal_status:'active',authorized_by:'manager',environment:'production',connection_status:'connected',granted_scopes:'[]',required_scopes:'[]'})}),timestamp:now,newId:()=> 'dispatch',env:{CREWOS_ORG_ENGINE_V2:'true',CREWOS_ORG_ENGINE_V2_ORGS:'org_a'},checkPolicy:async()=>({decision:'ALLOW'}),riskFloor:()=>({decision:'ALLOW'})});
  assert.equal((await fixtureProd.authorize(dispatchRow({subscription_id:'sub',inbox_environment:'production',environment:'production',simulated:1}))).reason,'fixture_production_blocked');
});

test('task DAG checks serialize width budgets and reject cross-tenant parents',async()=>{
  const tasks=new Map(), dependencies=[];
  let tail=Promise.resolve();
  const transaction=async fn=>{let release;const previous=tail;tail=new Promise(resolve=>release=resolve);await previous;try{return await fn();}finally{release();}};
  const repository={
    findTaskByIdempotency:async(org,key)=>[...tasks.values()].find(task=>task.org_id===org&&task.idempotency_key===key),
    findTaskByOrgAndId:async(org,id)=>{const task=tasks.get(id);return task?.org_id===org?task:null;},
    findTaskRoot:async(org,id)=>{const row=tasks.get(id);if(!row||row.org_id!==org)return null;let current=row,depth=0;while(current.parent_task_id){current=tasks.get(current.parent_task_id);depth++;if(!current||depth>32)return null;}return {id:current.id,depth};},
    findTaskGraphStats:async(org,root)=>{const descendants=[...tasks.values()].filter(task=>task.org_id===org);return {width:descendants.filter(task=>task.id===root||task.parent_task_id===root).length,depth:0};},
    isDependencyReachable:async()=>null,
    insertTaskIfAbsent:async(id,org,workflow,parent,employee,capability,goal,refs,criteria,state,priority,key,correlation,spec,runtime,created,updated)=>{tasks.set(id,{id,org_id:org,workflow_id:workflow,parent_task_id:parent,owner_employee_id:employee,capability,goal,input_refs:refs,state,idempotency_key:key,created_at:created,updated_at:updated});return {changes:1};},
    insertTaskDependency:async(...args)=>{dependencies.push(args);return {changes:1};},
  };
  let serial=0;
  const service=createTaskGraphService({repository,transaction,lockOrganization:async()=>true,newId:()=>`task${++serial}`,timestamp:now,maxDepth:3,maxWidth:2});
  const root=await service.create({orgId:'org_a',ownerEmployeeId:'emp_a',capability:'research',goal:'root',idempotencyKey:'root'});
  const siblings=await Promise.allSettled([
    service.create({orgId:'org_a',ownerEmployeeId:'emp_a',capability:'research',goal:'child one',idempotencyKey:'child-one',parentTaskId:root.id}),
    service.create({orgId:'org_a',ownerEmployeeId:'emp_a',capability:'research',goal:'child two',idempotencyKey:'child-two',parentTaskId:root.id}),
  ]);
  assert.equal(siblings.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(siblings.filter(result=>result.status==='rejected'&&result.reason.code==='task_budget_exceeded').length,1);
  await assert.rejects(()=>service.create({orgId:'org_b',ownerEmployeeId:'emp_b',capability:'research',goal:'cross tenant',idempotencyKey:'cross',parentTaskId:root.id}),{code:'task_tenant_mismatch'});
});

test('provider tools require a supported schema, explicit grant, connected scoped credential, verifier, and passing probation',()=>{
  const readiness={state:'ready',connectionId:'conn',connectionStatus:'connected',credentialState:'active',requiredScopes:['shop:read'],grantedScopes:['shop:read'],handlerId:'handler',verifierId:'verifier',policyRevision:'rev1'};
  assert.equal(providerToolAvailable({entry:{key:'shop.orders.read',providerTool:true},readiness,probation:{passed:true,policyRevision:'rev1'}}),true);
  assert.equal(providerToolAvailable({entry:{key:'shop.orders.read',providerTool:true},readiness,probation:{passed:false,policyRevision:'rev1'}}),false);
  assert.equal(providerToolAvailable({entry:{key:'shop.orders.read',providerTool:true},readiness:{...readiness,credentialState:'revoked'},probation:{passed:true,policyRevision:'rev1'}}),false);
  assert.equal(providerToolAvailable({entry:{key:'shop.orders.read',providerTool:true},readiness,probation:{passed:true,policyRevision:'old'}}),false);
  assert.equal(buildEmployeeToolRegistry([{key:'unsupported.tool'}],['unsupported.tool']).length,0);
  assert.equal(buildEmployeeToolRegistry([{key:'shop.orders.read',providerTool:true,inputSchema:{type:'object',properties:{},additionalProperties:false}}],['shop.orders.read']).length,0);
  assert.equal(buildEmployeeToolRegistry([{key:'solari.sandbox.echo'}],[]).length,0);
  assert.equal(providerToolAvailable({entry:{key:'shop.orders.read',providerTool:true},readiness,probation:{passed:true,policyRevision:'rev1'},pilotMode:true}),false);
});

test('operation approval is one-time and rejects signer, policy revision, and nonce replay changes',async()=>{
  let row={id:'ap1',org_id:'org_a',operation_id:'op1',connection_id:'conn1',environment:'staging',task_id:'task1',action:'shopify.theme.publish',policy_revision:'policy1',nonce:'nonce1',signer_user_id:'manager1',artifact_hash:'artifact1',input_hash:'input1',credential_version:3,state:'pending',expires_at:'2026-11-01T00:00:00.000Z',approved_by_user_id:null,current_policy_revision:'policy1',current_input_hash:'input1',current_action:'shopify.theme.publish',current_task_id:'task1',current_connection_id:'conn1',current_environment:'staging',current_artifact_hash:'artifact1',connection_status:'connected',current_credential_version:3,credential_expires_at:null,revoked_at:null,operation_state:'pending'};
  const repository={
    findOperationApprovalBinding:async()=>({...row,artifact_hash:'artifact1'}),
    insertOperationApproval:async()=>({changes:1}),findOperationApprovalByNonce:async()=>row,
    findOperationApproval:async()=>row,
    approveOperationApproval:async(_by,_at,_org,_id,signer)=>{if(row.state!=='pending'||signer!==row.signer_user_id)return {changes:0};row={...row,state:'approved',approved_by_user_id:signer};return {changes:1};},
    findOperationApprovalState:async()=>row,
    consumeOperationApproval:async()=>{if(row.state!=='approved')return {changes:0};row={...row,state:'consumed'};return {changes:1};},
  };
  const service=createOperationApprovalService({repository,newId:()=> 'ap1',timestamp:now,authorizeSigner:async({userId})=>userId==='manager1',recheckAtExecution:async()=>true,transaction:async fn=>fn(),lockOrganization:async()=>true,lockConnection:async()=>true});
  await assert.rejects(()=>service.approve({orgId:'org_a',approvalId:'ap1',userId:'intruder'}),{code:'approval_unauthorized'});
  row.state='approved';
  await assert.rejects(()=>service.consume({orgId:'org_a',approvalId:'ap1',expected:{operationId:'op1',connectionId:'conn1',environment:'staging',taskId:'task1',action:'shopify.theme.publish',inputHash:'input1',artifactHash:'artifact1',policyRevision:'old',nonce:'nonce1',credentialVersion:3}}),{code:'approval_stale'});
  row.state='approved';
  const expected={operationId:'op1',connectionId:'conn1',environment:'staging',taskId:'task1',action:'shopify.theme.publish',inputHash:'input1',artifactHash:'artifact1',policyRevision:'policy1',nonce:'nonce1',credentialVersion:3};
  assert.equal((await service.consume({orgId:'org_a',approvalId:'ap1',expected})).consumed,true);
  await assert.rejects(()=>service.consume({orgId:'org_a',approvalId:'ap1',expected}),{code:'approval_stale'});
});
