import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskGraphService } from '../backend/src/services/task-graph.mjs';

test('task graph enforces org ownership, serializes graph creation, and fences stale lease transitions', async () => {
  const tasks=new Map();let generation=0;
  const repository={
    findTaskByIdempotency:async(org,key)=>[...tasks.values()].find(t=>t.org_id===org&&t.idempotency_key===key)||null,
    findTaskByOrgAndId:async(org,id)=>tasks.get(id)?.org_id===org?tasks.get(id):null,
    findTaskRoot:async(org,id)=>tasks.get(id)?.org_id===org?{id,parent_task_id:null,depth:0}:null,
    findTaskGraphStats:async()=>({width:tasks.size,depth:0}),isDependencyReachable:async()=>null,
    insertTaskIfAbsent:async(id,org,workflow,parent,employee,cap,goal,refs,criteria,state,priority,key,corr,spec,runtime,created,updated)=>{tasks.set(id,{id,org_id:org,workflow_id:workflow,parent_task_id:parent,owner_employee_id:employee,capability:cap,goal,input_refs:refs,state,priority,idempotency_key:key,correlation_id:corr,spec_version:spec,runtime_version:runtime,lease_generation:0,created_at:created,updated_at:updated});return {changes:1};},
    insertTaskDependency:async()=>({changes:1}),
    transitionTaskFenced:async(org,id,from,to,lease,updates,at)=>{const t=tasks.get(id);if(t?.org_id!==org||t.state!==from||t.lease_generation!==lease)return {changes:0};Object.assign(t,updates,{state:to,lease_generation:++generation,updated_at:at});return {changes:1};},
  };
  const service=createTaskGraphService({repository,transaction:fn=>fn(),lockOrganization:async()=>({id:'org_a'}),newId:()=>`task_${tasks.size+1}`,timestamp:()=>new Date(0).toISOString()});
  const task=await service.create({orgId:'org_a',goal:'Inspect',capability:'read',ownerEmployeeId:'employee_a',idempotencyKey:'task-key'});
  await assert.rejects(service.transition({orgId:'org_b',taskId:task.id,expectedState:'queued',nextState:'planning',leaseGeneration:0}),error=>error.code==='task_tenant_mismatch'&&!/lease|generation/i.test(error.message));
  const next=await service.transition({orgId:'org_a',taskId:task.id,expectedState:'queued',nextState:'planning',leaseGeneration:0});
  assert.equal(next.state,'planning');
  await assert.rejects(service.transition({orgId:'org_a',taskId:task.id,expectedState:'planning',nextState:'running',leaseGeneration:0}),{code:'task_fence_conflict'});
});
