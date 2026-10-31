import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';

const directory=mkdtempSync(join(tmpdir(),'crewos-jira-pilot-'));
Object.assign(process.env,{NODE_ENV:'test',PILOT_MODE:'true',DATABASE_URL:'',NEON_AUTH_BASE_URL:'',DATABASE_FILE:join(directory,'pilot.sqlite'),APP_ORIGIN:'http://localhost:4173',APP_MASTER_KEY:'jira-pilot-test-key-1234567890',REQUEST_TRACE:'false',OPENROUTER_API_KEY:'mock-provider-key',OPENROUTER_MODEL:'planner',OPENROUTER_EVALUATOR_MODEL:'grader'});
delete process.env.PINECONE_API_KEY;
const {handleHttpRequest}=await import('../backend/server.mjs');
const {get,run,now,closeDatabase}=await import('../backend/lib/db.mjs');
const {storeSecret}=await import('../backend/lib/secrets.mjs');
const {verifyJiraIssue}=await import('../backend/build/integrations/jira.js');
const {recordApproval}=await import('../backend/lib/approvals.mjs');
const originalFetch=globalThis.fetch;
let issue=null,creates=0,heldCreate=null;
function json(body){return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});}
globalThis.fetch=async (input,options={})=>{
  const url=String(input),body=options.body && JSON.parse(options.body);
  if(url.endsWith('/embeddings')) return json({data:[]});
  if(url.endsWith('/chat/completions')) {
    if(body.model === 'grader') return json({choices:[{message:{content:JSON.stringify({score:1,summary:'The matching Jira issue was independently read back.'})}}]});
    if(body.response_format) return json({choices:[{message:{content:JSON.stringify({routes:['workspace_tools'],summary:'Use Jira.'})}}]});
    if(body.messages.some(message=>message.role === 'tool')) return json({choices:[{message:{content:'The Jira support issue was created and verified.'}}]});
    let requested={title:'Support case',description:'Verify SOP.'};
    try {const task=JSON.parse(body.messages.find(message=>message.role === 'user').content);if(task.input) requested=task.input;}catch{}
    return json({choices:[{message:{content:'',tool_calls:[{id:'jira-call',function:{name:body.tools[0].function.name,arguments:JSON.stringify(requested)}}]}}]});
  }
  if(url.includes('api.atlassian.com') && url.endsWith('/rest/api/3/issue') && options.method === 'POST') {creates++;if(heldCreate) await heldCreate;issue={key:'OPS-42',fields:body.fields};return json({key:issue.key});}
  if(url.includes('/rest/api/3/issue/OPS-42')) return json(issue);
  if(url.includes('/search/jql')) return json({issues:issue ? [{key:issue.key}] : []});
  throw new Error(`Unexpected provider request: ${url}`);
};
after(async()=>{globalThis.fetch=originalFetch;await closeDatabase();rmSync(directory,{recursive:true,force:true});});
async function request(method,path,body,cookie,headers={}) {
  const req=Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  Object.assign(req,{method,url:path,headers:{host:'localhost:4173',origin:'http://localhost:4173','content-type':'application/json',...(cookie ? {cookie} : {}),...headers},socket:{encrypted:false,remoteAddress:'127.0.0.1'}});
  const res={statusCode:200,headers:new Map(),setHeader(key,value){this.headers.set(key,value);},getHeader(key){return this.headers.get(key);},writeHead(status,headers={}){this.statusCode=status;for(const [key,value]of Object.entries(headers))this.headers.set(key,value);},end(body=''){this.body=String(body);},json(){return JSON.parse(this.body);}};
  await handleHttpRequest(req,res);return res;
}

test('pilot probation gates deployment, Jira creation verifies fields, and artifacts reach the dashboard',async()=>{
  const signup=await request('POST','/api/auth/signup',{name:'Owner',email:'jira-pilot@example.test',password:'pilot-password-123',organization:'Jira pilot'});
  assert.equal(signup.statusCode,201,signup.body);
  const cookie=signup.getHeader('set-cookie')[0].split(';')[0];
  const orgId=signup.json().organization.id,userId=signup.json().user.id;
  const hired=await request('POST','/api/employees',{name:'Support',title:'Support specialist',mission:'Create support cases',responsibilities:['Verify the SOP'],tools:['jira.create_issue'],policies:[],successMetrics:[],capabilities:[],coworkers:[],evaluationPolicy:'Pass required probation'},cookie);
  assert.equal(hired.statusCode,201,hired.body);const employee=hired.json();
  assert.equal((await request('POST',`/api/employees/${employee.id}/deploy`,{},cookie)).statusCode,409);
  const probation=await request('POST',`/api/employees/${employee.id}/probation`,{},cookie);
  assert.equal(probation.statusCode,201,probation.body);assert.equal(probation.json().passed,true,probation.body);assert.equal(probation.json().evidence.length,5);assert.equal(creates,0);
  assert.equal((await request('POST',`/api/employees/${employee.id}/deploy`,{},cookie)).statusCode,200);
  await storeSecret(orgId,userId,'jira',JSON.stringify({accessToken:'mock-jira-access-token',refreshToken:'mock-jira-refresh-token',expiresAt:Date.now()+3600000}),{cloudId:'site-12345678',projectKey:'OPS',sites:[{id:'site-12345678',name:'Test Jira',url:'https://crewos.atlassian.net'}]});
  const assigned=await request('POST','/api/workflows',{employeeId:employee.id,goal:'Create a Jira issue titled Support case with description Verify SOP.'},cookie,{'idempotency-key':'jira-pilot-case'});
  assert.equal(assigned.statusCode,202,assigned.body);const taskId=assigned.json().taskId;
  let workflow;
  for(let i=0;i<200;i++){workflow=await get('SELECT * FROM workflows WHERE id=?',taskId);if(['completed','failed','reconciliation_required'].includes(workflow.status))break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(workflow.status,'completed',workflow.error);assert.equal(creates,1);assert.ok(workflow.deployment_id);assert.equal(workflow.spec_version,1);
  const duplicate=await request('POST','/api/workflows',{employeeId:employee.id,goal:workflow.goal},cookie,{'idempotency-key':'jira-pilot-case'});
  assert.equal(duplicate.json().taskId,taskId);assert.equal(creates,1);
  const artifacts=await request('GET','/api/issues',null,cookie);
  assert.equal(artifacts.json()[0].external_id,'OPS-42');assert.match(artifacts.json()[0].url,/browse\/OPS-42$/);
  const operation=await get('SELECT id FROM tool_runs WHERE workflow_id=?',taskId);
  assert.equal((await verifyJiraIssue(orgId,'OPS-42',{title:'Wrong title',description:'Verify SOP.'},operation.id)).verified,false);
  // Approval records bind a decision to its exact action, including after transport changes.
  process.env.PROCESS_ROLE='api';
  const deploymentId=(await get('SELECT id FROM employee_deployments WHERE org_id=? AND employee_id=? ORDER BY created_at DESC,id DESC LIMIT 1',orgId,employee.id)).id;
  const waiting='task_approval_http';
  await run("INSERT INTO workflows(id,org_id,employee_id,created_by,goal,status,runtime_version,plan,spec_version,deployment_id,created_at,updated_at) VALUES(?,?,?,?,?,'input_required','langgraph-react-v1','[]',?,?,?,?)",waiting,orgId,employee.id,userId,'Create a Jira issue',employee.spec.version,deploymentId,now(),now());
  const requestKey='approval-0';
  const pending=await recordApproval(orgId,waiting,requestKey,{method:'elicitation/create',params:{tool:'jira.create_issue',input:{title:'Support case',description:'Verify SOP.'}}});
  await run('UPDATE workflows SET input_requests=? WHERE id=?',JSON.stringify({[requestKey]:pending}),waiting);
  assert.equal((await request('POST',`/api/workflows/${waiting}/approve`,{approved:true,approvalId:'stale'},cookie)).statusCode,409);
  const reviewed=await request('POST',`/api/workflows/${waiting}/approve`,{approved:true,approvalId:pending.approvalId},cookie);assert.equal(reviewed.statusCode,200,reviewed.body);
  const resumed=await get('SELECT input_requests,input_responses FROM workflows WHERE id=?',waiting);
  assert.ok(JSON.parse(resumed.input_requests)[requestKey]);assert.equal(JSON.parse(resumed.input_responses)[requestKey].approved,true);
  assert.equal((await request('POST',`/api/workflows/${waiting}/approve`,{approved:true,approvalId:pending.approvalId},cookie)).statusCode,409);
  const mcpWaiting='task_approval_mcp';
  await run("INSERT INTO workflows(id,org_id,employee_id,created_by,goal,status,runtime_version,plan,spec_version,deployment_id,created_at,updated_at) VALUES(?,?,?,?,?,'input_required','langgraph-react-v1','[]',?,?,?,?)",mcpWaiting,orgId,employee.id,userId,'Create a Jira issue',employee.spec.version,deploymentId,now(),now());
  const mcpApproval=await recordApproval(orgId,mcpWaiting,requestKey,{method:'elicitation/create',params:{tool:'jira.create_issue',input:{title:'Support case',description:'Verify SOP.'}}});
  await run('UPDATE workflows SET input_requests=? WHERE id=?',JSON.stringify({[requestKey]:mcpApproval}),mcpWaiting);
  const mcp=await request('POST','/mcp',{jsonrpc:'2.0',id:'approve',method:'tasks/update',params:{taskId:mcpWaiting,approvalId:mcpApproval.approvalId,inputResponses:{[requestKey]:{approved:true}},_meta:{'io.modelcontextprotocol/clientCapabilities':{extensions:{'io.modelcontextprotocol/tasks':{}}}}}},cookie,{'mcp-method':'tasks/update','mcp-name':mcpWaiting});
  assert.equal(mcp.json().error,undefined,mcp.body);
  const mcpResumed=await get('SELECT status,input_requests,input_responses FROM workflows WHERE id=?',mcpWaiting);
  assert.equal(mcpResumed.status,'queued');assert.ok(JSON.parse(mcpResumed.input_requests)[requestKey]);assert.equal(JSON.parse(mcpResumed.input_responses)[requestKey].approved,true);
  delete process.env.PROCESS_ROLE;
  let release;
  heldCreate=new Promise(resolve=>{release=resolve;});
  const cancelled=await request('POST','/api/workflows',{employeeId:employee.id,goal:'Create a Jira issue for the cancellation boundary.'},cookie);
  assert.equal(cancelled.statusCode,202,cancelled.body);
  const cancelledId=cancelled.json().taskId;
  try {
    for(let i=0;i<200 && creates<2;i++) await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(creates,2);
    const cancellation=await request('POST',`/api/workflows/${cancelledId}/cancel`,{},cookie);
    assert.equal(cancellation.statusCode,200,cancellation.body);
  } finally {release();heldCreate=null;}
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal((await get('SELECT status FROM workflows WHERE id=?',cancelledId)).status,'cancelled','a late provider response must not resurrect a cancelled task');
  assert.notEqual((await get('SELECT status FROM tool_runs WHERE workflow_id=?',cancelledId)).status,'completed','a stale worker must not commit the external result');
});
