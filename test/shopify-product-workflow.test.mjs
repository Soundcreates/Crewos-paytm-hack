import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';

const directory=mkdtempSync(join(tmpdir(),'crewos-shopify-product-flow-'));
const envKeys=['NODE_ENV','PILOT_MODE','DATABASE_URL','DATABASE_FILE','NEON_AUTH_BASE_URL','APP_ORIGIN','APP_MASTER_KEY','OPENROUTER_API_KEY','OPENROUTER_MODEL','OPENROUTER_EVALUATOR_MODEL','CREWOS_ORG_ENGINE_V2','CREWOS_ORG_ENGINE_V2_ORGS','REQUEST_TRACE'];
const originalEnv=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
Object.assign(process.env,{NODE_ENV:'test',PILOT_MODE:'false',DATABASE_URL:'',DATABASE_FILE:join(directory,'flow.sqlite'),NEON_AUTH_BASE_URL:'',APP_ORIGIN:'http://127.0.0.1:4173',APP_MASTER_KEY:'fixture-only-shopify-flow-master-key',OPENROUTER_MODEL:'planner',OPENROUTER_EVALUATOR_MODEL:'grader',CREWOS_ORG_ENGINE_V2:'true',CREWOS_ORG_ENGINE_V2_ORGS:'',REQUEST_TRACE:'false'});
delete process.env.OPENROUTER_API_KEY;
const {handleHttpRequest}=await import('../backend/server.mjs');
const {all,closeDatabase,get,run}=await import('../backend/lib/db.mjs');
const originalFetch=globalThis.fetch;
let selectedConnectionId='',toolCallCount=0;

function jsonResponse(payload){return new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json'}});}
globalThis.fetch=async(input,options={})=>{
  const url=String(input),body=options.body?JSON.parse(options.body):{};
  if(url.endsWith('/embeddings'))return jsonResponse({data:[{embedding:Array(8).fill(0)}]});
  if(url.endsWith('/chat/completions')){
    if(body.model==='grader')return jsonResponse({choices:[{message:{content:JSON.stringify({score:1,summary:'The simulated product was read back from the local projection.'})}}]});
    if(body.response_format)return jsonResponse({choices:[{message:{content:JSON.stringify({routes:['workspace_tools'],summary:'Use the granted Shopify product tool.'})}}]});
    if(body.messages?.some(message=>message.role==='tool'))return jsonResponse({choices:[{message:{content:'The manager-approved simulation product was verified.'}}]});
    const tool=body.tools?.find(item=>item.function?.parameters?.properties?.connectionId);
    assert.ok(tool,'the workflow should only receive the granted product-set tool');
    toolCallCount++;
    const args={connectionId:selectedConnectionId,idempotencyKey:`flow-product-${toolCallCount}`,products:[{title:`Fixture product ${toolCallCount}`,variants:[{sku:`FIXTURE-${toolCallCount}`,priceMinor:1299,currency:'USD'}]}]};
    return jsonResponse({choices:[{message:{content:'',tool_calls:[{id:`shopify-call-${toolCallCount}`,type:'function',function:{name:tool.function.name,arguments:JSON.stringify(args)}}]}}]});
  }
  throw new Error(`Unexpected non-fixture network request: ${url}`);
};

function response(){const headers=new Map();return {headersSent:false,statusCode:0,body:'',setHeader(k,v){headers.set(String(k).toLowerCase(),v);},getHeader(k){return headers.get(String(k).toLowerCase());},writeHead(status,values={}){this.statusCode=status;for(const [k,v]of Object.entries(values))this.setHeader(k,v);this.headersSent=true;},end(body=''){this.body=String(body);this.headersSent=true;},destroy(){this.destroyed=true;},json(){return this.body?JSON.parse(this.body):null;}};}
async function request(method,path,{body,cookie}={}){
  const payload=body===undefined?null:Buffer.from(JSON.stringify(body)),req=Readable.from(payload?[payload]:[]),res=response();
  req.method=method;req.url=path;req.headers={host:'127.0.0.1:4173',...(method!=='GET'?{origin:process.env.APP_ORIGIN}:{}),...(payload?{'content-type':'application/json','content-length':String(payload.length)}:{}),...(cookie?{cookie}:{})};req.socket={encrypted:false,remoteAddress:'127.0.0.1'};
  await handleHttpRequest(req,res);return res;
}
function cookieOf(res){const values=res.getHeader('set-cookie'),item=(Array.isArray(values)?values:[values]).find(value=>value?.startsWith('crewos_session='));assert.ok(item,'signup should issue a session');return item.split(';',1)[0];}
async function waitForWorkflow(id,statuses){let row;for(let i=0;i<500;i++){row=await get('SELECT * FROM workflows WHERE id=?',id);if(statuses.includes(row?.status))return row;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail(`workflow ${id} did not reach ${statuses.join('/')} (last: ${row?.status})`);}
async function prepareOwner(email,organization){const signup=await request('POST','/api/auth/signup',{body:{name:'Fixture owner',email,password:'shopify-flow-password-123',organization}});assert.equal(signup.statusCode,201,signup.body);return {cookie:cookieOf(signup),orgId:signup.json().organization.id,userId:signup.json().user.id};}

after(async()=>{globalThis.fetch=originalFetch;await closeDatabase();rmSync(directory,{recursive:true,force:true});for(const key of envKeys){if(originalEnv[key]===undefined)delete process.env[key];else process.env[key]=originalEnv[key];}});

test('fixture-only product draft requires manager approval and the single workflow worker persists verified readback',async()=>{
  const owner=await prepareOwner('shopify-flow-owner@example.test','Shopify flow');
  process.env.CREWOS_ORG_ENGINE_V2_ORGS=owner.orgId;
  const connected=await request('POST','/api/commerce/v2/shopify/simulation-connections',{cookie:owner.cookie,body:{storeDomain:'fixture-shop.myshopify.com'}});
  assert.equal(connected.statusCode,201,connected.body);selectedConnectionId=connected.json().id;
  const employeeResponse=await request('POST','/api/employees',{cookie:owner.cookie,body:{name:'Catalog employee',title:'Catalog specialist',mission:'Prepare safe product drafts',responsibilities:['Propose product catalog updates'],tools:['shopify.product.set'],policies:[],successMetrics:[],capabilities:[],coworkers:[],evaluationPolicy:'Require manager review for catalog changes'}});
  assert.equal(employeeResponse.statusCode,201,employeeResponse.body);const employee=employeeResponse.json();
  const probation=await request('POST',`/api/employees/${employee.id}/probation`,{cookie:owner.cookie,body:{}});
  assert.equal(probation.statusCode,201,probation.body);assert.equal(probation.json().passed,true,probation.body);
  const deployed=await request('POST',`/api/employees/${employee.id}/deploy`,{cookie:owner.cookie,body:{}});assert.equal(deployed.statusCode,200,deployed.body);

  const direct=await request('POST',`/api/commerce/v2/shopify/connections/${selectedConnectionId}/catalog`,{cookie:owner.cookie,body:{idempotencyKey:'direct-must-not-write',products:[]}});
  assert.equal(direct.statusCode,409);assert.equal(direct.json().error,'workflow_approval_required');
  const crossOwner=await prepareOwner('shopify-flow-other@example.test','Other Shopify flow');
  process.env.CREWOS_ORG_ENGINE_V2_ORGS=`${owner.orgId},${crossOwner.orgId}`;
  const otherConnection=await request('POST','/api/commerce/v2/shopify/simulation-connections',{cookie:crossOwner.cookie,body:{storeDomain:'other-fixture.myshopify.com'}});
  assert.equal(otherConnection.statusCode,201,otherConnection.body);
  const crossRead=await request('GET',`/api/commerce/v2/shopify/connections/${otherConnection.json().id}/catalog`,{cookie:owner.cookie});
  assert.equal(crossRead.statusCode,404,'connection ownership must be resolved from the authenticated org');

  process.env.OPENROUTER_API_KEY='fixture-only-local-llm-key-123456';
  const expiredTask=await request('POST','/api/workflows',{cookie:owner.cookie,body:{employeeId:employee.id,goal:'Prepare and propose one product catalog draft for manager review.'}});
  assert.equal(expiredTask.statusCode,202,expiredTask.body);const expiredWorkflow=await waitForWorkflow(expiredTask.json().taskId,['input_required','failed']);
  assert.equal(expiredWorkflow.status,'input_required',expiredWorkflow.error);
  const expiredRequest=JSON.parse(expiredWorkflow.input_requests)['approval-0'];
  assert.ok(expiredRequest.params.commerceBinding);
  assert.equal((await request('POST',`/api/workflows/${expiredWorkflow.id}/approve`,{cookie:owner.cookie,body:{approved:true,approvalId:'forged-approval'}})).statusCode,409);
  await run('UPDATE approvals SET expires_at=? WHERE id=?',new Date(Date.now()-1000).toISOString(),expiredRequest.approvalId);
  assert.equal((await request('POST',`/api/workflows/${expiredWorkflow.id}/approve`,{cookie:owner.cookie,body:{approved:true,approvalId:expiredRequest.approvalId}})).statusCode,409,'expired approval cannot resume the worker');

  const task=await request('POST','/api/workflows',{cookie:owner.cookie,body:{employeeId:employee.id,goal:'Prepare and propose one product catalog draft for manager review.'}});
  assert.equal(task.statusCode,202,task.body);const pending=await waitForWorkflow(task.json().taskId,['input_required','failed']);
  assert.equal(pending.status,'input_required',pending.error);
  const approval=JSON.parse(pending.input_requests)['approval-0'];
  assert.equal(approval.params.commerceBinding.storeDomain,'fixture-shop.myshopify.com');
  const review=await request('POST',`/api/workflows/${pending.id}/approve`,{cookie:owner.cookie,body:{approved:true,approvalId:approval.approvalId}});
  assert.equal(review.statusCode,200,review.body);
  const finished=await waitForWorkflow(pending.id,['completed','failed','reconciliation_required']);
  assert.equal(finished.status,'completed',finished.error);
  const runs=await all('SELECT id,tool,status,output FROM tool_runs WHERE org_id=? AND workflow_id=?',owner.orgId,pending.id);
  assert.equal(runs.length,1);assert.equal(runs[0].tool,'shopify.product.set');assert.equal(runs[0].status,'completed');
  const output=JSON.parse(runs[0].output);assert.equal(output.simulated,true);assert.equal(output.verified,true);assert.equal(output.approval.signer,owner.userId);
  const operation=await get('SELECT * FROM external_operations WHERE org_id=? AND workflow_id=?',owner.orgId,pending.id);
  assert.equal(operation.state,'completed');assert.equal(operation.tool_run_id,runs[0].id);assert.equal(operation.connection_id,selectedConnectionId);
  const opApproval=await get('SELECT * FROM operation_approvals WHERE org_id=? AND operation_id=?',owner.orgId,operation.id);
  assert.equal(opApproval.state,'consumed');assert.equal(opApproval.signer_user_id,owner.userId);assert.equal(opApproval.nonce,approval.params.commerceBinding.nonce);
  if ('approved_by_user_id' in opApproval) assert.equal(opApproval.approved_by_user_id,owner.userId);
  if ('approved_at' in opApproval) assert.ok(opApproval.approved_at);
  if ('consumed_at' in opApproval) assert.ok(opApproval.consumed_at);
  const projection=await all('SELECT product_json,simulated FROM commerce_catalog_projection WHERE org_id=? AND connection_id=?',owner.orgId,selectedConnectionId);
  assert.equal(projection.length,1);assert.equal(projection[0].simulated,1);assert.equal(JSON.parse(projection[0].product_json).title,'Fixture product 2');
  assert.equal(toolCallCount,2,'the expired approval path does not execute; only the approved workflow gets one tool call');
});
