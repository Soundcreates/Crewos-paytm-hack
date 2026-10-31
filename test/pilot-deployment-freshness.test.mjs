import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';

const directory=mkdtempSync(join(tmpdir(),'crewos-pilot-freshness-'));
const originalMcpVerifier=process.env.MCP_VERIFIER_MODULE;
const verifierModule=join(directory,'trusted-test-verifier.mjs');
writeFileSync(verifierModule,'export function canVerifyMcpPostcondition(context) { return context?.tool?.name === "lookup_record"; } export function verifyMcpPostcondition(context) { return { verified: true, evidence: { testFixture: true, tool: context.tool.name } }; }');
Object.assign(process.env,{NODE_ENV:'test',PILOT_MODE:'true',DATABASE_URL:'',NEON_AUTH_BASE_URL:'',DATABASE_FILE:join(directory,'pilot.sqlite'),APP_ORIGIN:'http://localhost:4173',APP_MASTER_KEY:'pilot-freshness-master-key-123456789',REQUEST_TRACE:'false',OPENROUTER_API_KEY:'mock-provider-key',OPENROUTER_MODEL:'planner',OPENROUTER_EVALUATOR_MODEL:'grader',MCP_VERIFIER_MODULE:verifierModule});
delete process.env.PINECONE_API_KEY;
delete process.env.PROCESS_ROLE;

const {handleHttpRequest,pollWorkerOnce}=await import('../backend/server.mjs');
const {get,run:runDb,closeDatabase}=await import('../backend/lib/db.mjs');
const {storeSecret}=await import('../backend/lib/secrets.mjs');
const originalFetch=globalThis.fetch;
let issue=null,creates=0;

function json(body){return new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});}
globalThis.fetch=async(input,options={})=>{
  const url=String(input),body=options.body && JSON.parse(options.body);
  if(url.endsWith('/embeddings')) return json({data:[]});
  if(url.endsWith('/chat/completions')) {
    if(body.model==='grader') return json({choices:[{message:{content:JSON.stringify({score:1,summary:'The fresh deployment completed and read back its Jira issue.'})}}]});
    if(body.response_format) return json({choices:[{message:{content:JSON.stringify({routes:['workspace_tools'],summary:'Use Jira.'})}}]});
    if(body.messages.some(message=>message.role==='tool')) return json({choices:[{message:{content:'The Jira issue was created and verified.'}}]});
    let requested={title:'Fresh support issue',description:'Verify the release freshness check.'};
    try {const task=JSON.parse(body.messages.find(message=>message.role==='user').content);if(task.input) requested=task.input;}catch{}
    return json({choices:[{message:{content:'',tool_calls:[{id:'jira-call',function:{name:body.tools[0].function.name,arguments:JSON.stringify(requested)}}]}}]});
  }
  if(url.includes('api.atlassian.com') && url.endsWith('/rest/api/3/issue') && options.method==='POST') {creates++;issue={key:'OPS-42',fields:body.fields};return json({key:issue.key});}
  if(url.includes('/rest/api/3/issue/OPS-42')) return json(issue);
  if(url.includes('/search/jql')) return json({issues:issue ? [{key:issue.key}] : []});
  throw new Error(`Unexpected provider request: ${url}`);
};

after(async()=>{globalThis.fetch=originalFetch;delete process.env.PROCESS_ROLE;if(originalMcpVerifier===undefined)delete process.env.MCP_VERIFIER_MODULE;else process.env.MCP_VERIFIER_MODULE=originalMcpVerifier;await closeDatabase();rmSync(directory,{recursive:true,force:true});});

async function request(method,path,{body,cookie,headers={}}={}) {
  const req=Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  Object.assign(req,{method,url:path,headers:{host:'localhost:4173',origin:'http://localhost:4173','content-type':'application/json',...(cookie ? {cookie} : {}),...headers},socket:{encrypted:false,remoteAddress:'127.0.0.1'}});
  const res={statusCode:200,headers:new Map(),setHeader(key,value){this.headers.set(key,value);},getHeader(key){return this.headers.get(key);},writeHead(status,headers={}){this.statusCode=status;for(const [key,value] of Object.entries(headers))this.headers.set(key,value);},end(body=''){this.body=String(body);},json(){return JSON.parse(this.body);}};
  await handleHttpRequest(req,res);return res;
}

async function waitForWorkflow(id,statuses) {
  let workflow;
  for(let attempt=0;attempt<300;attempt++) {
    workflow=await get('SELECT * FROM workflows WHERE id=?',id);
    if(workflow && statuses.includes(workflow.status)) return workflow;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail(`Workflow ${id} did not reach ${statuses.join(' or ')}; current status: ${workflow?.status || 'missing'}`);
}

async function assign(cookie,employeeId,goal) {
  return request('POST','/api/workflows',{cookie,body:{employeeId,goal}});
}

test('pilot work and approval resumes require the exact current probation deployment',async()=>{
  const signup=await request('POST','/api/auth/signup',{body:{name:'Pilot owner',email:'freshness@example.test',password:'pilot-password-123',organization:'Freshness pilot'}});
  assert.equal(signup.statusCode,201,signup.body);
  const cookie=signup.getHeader('set-cookie')[0].split(';')[0];
  const {organization,user}=signup.json();
  const hired=await request('POST','/api/employees',{cookie,body:{name:'Support',title:'Support specialist',mission:'Create support cases',responsibilities:['Verify the SOP'],tools:['jira.create_issue'],policies:[],successMetrics:[],capabilities:[],coworkers:[],evaluationPolicy:'Pass required probation'}});
  assert.equal(hired.statusCode,201,hired.body);
  const employee=hired.json();

  const firstProbation=await request('POST',`/api/employees/${employee.id}/probation`,{cookie,body:{}});
  assert.equal(firstProbation.statusCode,201,firstProbation.body);
  assert.equal(firstProbation.json().passed,true,firstProbation.body);
  assert.equal((await request('POST',`/api/employees/${employee.id}/deploy`,{cookie,body:{}})).statusCode,200);
  await storeSecret(organization.id,user.id,'jira',JSON.stringify({accessToken:'mock-jira-access-token',refreshToken:'mock-jira-refresh-token',expiresAt:Date.now()+3600000}),{cloudId:'site-12345678',projectKey:'OPS',sites:[{id:'site-12345678',name:'Test Jira',url:'https://crewos.atlassian.net'}]});

  const goal='Create a Jira issue titled Fresh support issue with description Verify the release freshness check.';
  process.env.PROCESS_ROLE='api';
  const queuedBeforeEdit=await assign(cookie,employee.id,goal);
  assert.equal(queuedBeforeEdit.statusCode,202,queuedBeforeEdit.body);
  const staleQueuedId=queuedBeforeEdit.json().taskId;
  delete process.env.PROCESS_ROLE;

  const approvalPolicy=await request('POST','/api/policies',{cookie,body:{name:'Approve Jira issue creation',tool:'jira.create_issue',effect:'REQUIRE_APPROVAL',condition:{}}});
  assert.equal(approvalPolicy.statusCode,201,approvalPolicy.body);
  const policyProbation=await request('POST',`/api/employees/${employee.id}/probation`,{cookie,body:{}});
  assert.equal(policyProbation.statusCode,201,policyProbation.body);
  assert.equal(policyProbation.json().passed,true,policyProbation.body);
  const policyDeployment=await request('POST',`/api/employees/${employee.id}/deploy`,{cookie,body:{}});
  assert.equal(policyDeployment.statusCode,200,policyDeployment.body);
  const currentDeployment=(await get('SELECT id FROM employee_deployments WHERE employee_id=? ORDER BY created_at DESC,id DESC LIMIT 1',employee.id)).id;

  process.env.PROCESS_ROLE='api';
  const approvedTaskResponse=await assign(cookie,employee.id,goal);
  const pendingTaskResponse=await assign(cookie,employee.id,goal);
  assert.equal(approvedTaskResponse.statusCode,202,approvedTaskResponse.body);
  assert.equal(pendingTaskResponse.statusCode,202,pendingTaskResponse.body);
  const approvedTaskId=approvedTaskResponse.json().taskId;
  const pendingTaskId=pendingTaskResponse.json().taskId;
  delete process.env.PROCESS_ROLE;
  await pollWorkerOnce();
  const approvedTask=await waitForWorkflow(approvedTaskId,['input_required']);
  await waitForWorkflow(pendingTaskId,['input_required']);

  process.env.PROCESS_ROLE='api';
  const approvedRequest=JSON.parse(approvedTask.input_requests)['approval-0'];
  const approved=await request('POST',`/api/workflows/${approvedTaskId}/approve`,{cookie,body:{approved:true,approvalId:approvedRequest.approvalId}});
  assert.equal(approved.statusCode,200,approved.body);
  assert.equal((await get('SELECT status,deployment_id FROM workflows WHERE id=?',approvedTaskId)).status,'queued');

  const deactivated=await request('PATCH',`/api/policies/${approvalPolicy.json().id}`,{cookie,body:{active:false}});
  assert.equal(deactivated.statusCode,200,deactivated.body);
  const staleNew=await assign(cookie,employee.id,goal);
  assert.equal(staleNew.statusCode,409,staleNew.body);
  assert.equal((await get('SELECT COUNT(*) AS count FROM workflows WHERE org_id=?',organization.id)).count,3);

  const pending=await get('SELECT input_requests,status FROM workflows WHERE id=?',pendingTaskId);
  const pendingApproval=JSON.parse(pending.input_requests)['approval-0'];
  const refused=await request('POST',`/api/workflows/${pendingTaskId}/approve`,{cookie,body:{approved:true,approvalId:pendingApproval.approvalId}});
  assert.equal(refused.statusCode,409,refused.body);
  assert.equal((await get('SELECT status FROM workflows WHERE id=?',pendingTaskId)).status,'input_required');
  assert.equal((await get('SELECT state FROM approvals WHERE id=?',pendingApproval.approvalId)).state,'pending');

  delete process.env.PROCESS_ROLE;
  await pollWorkerOnce();
  const [staleQueued,staleApproved]=await Promise.all([
    waitForWorkflow(staleQueuedId,['failed','completed','reconciliation_required']),
    waitForWorkflow(approvedTaskId,['failed','completed','reconciliation_required']),
  ]);
  assert.equal(staleQueued.status,'failed',staleQueued.error);
  assert.equal(staleApproved.status,'failed',staleApproved.error);
  assert.notEqual(staleQueued.deployment_id,currentDeployment);
  assert.equal(staleApproved.deployment_id,currentDeployment);
  assert.equal((await get('SELECT COUNT(*) AS count FROM tool_runs WHERE workflow_id IN (?,?)',staleQueuedId,approvedTaskId)).count,0);
  assert.equal(creates,0);

  const freshProbation=await request('POST',`/api/employees/${employee.id}/probation`,{cookie,body:{}});
  assert.equal(freshProbation.statusCode,201,freshProbation.body);
  assert.equal(freshProbation.json().passed,true,freshProbation.body);
  assert.equal((await request('POST',`/api/employees/${employee.id}/deploy`,{cookie,body:{}})).statusCode,200);
  const freshAssignment=await assign(cookie,employee.id,goal);
  assert.equal(freshAssignment.statusCode,202,freshAssignment.body);
  const completed=await waitForWorkflow(freshAssignment.json().taskId,['completed','failed','reconciliation_required']);
  assert.equal(completed.status,'completed',completed.error);
  assert.equal(creates,1);
  assert.equal((await get('SELECT deployment_id FROM workflows WHERE id=?',completed.id)).deployment_id,(await get('SELECT id FROM employee_deployments WHERE employee_id=? ORDER BY created_at DESC,id DESC LIMIT 1',employee.id)).id);

  // Race a real policy edit against real HTTP task assignment. Either the edit
  // wins and assignment is rejected, or assignment wins and the worker refuses
  // that now-stale deployment before the Jira adapter can create an issue.
  assert.equal((await request('PATCH',`/api/policies/${approvalPolicy.json().id}`,{cookie,body:{active:true}})).statusCode,200);
  const raceProbation=await request('POST',`/api/employees/${employee.id}/probation`,{cookie,body:{}});
  assert.equal(raceProbation.statusCode,201,raceProbation.body);
  assert.equal(raceProbation.json().passed,true,raceProbation.body);
  assert.equal((await request('POST',`/api/employees/${employee.id}/deploy`,{cookie,body:{}})).statusCode,200);
  const raceDeploymentId=(await get('SELECT id FROM employee_deployments WHERE employee_id=? ORDER BY created_at DESC,id DESC LIMIT 1',employee.id)).id;
  const workflowCountBeforeRace=(await get('SELECT COUNT(*) AS count FROM workflows WHERE org_id=?',organization.id)).count;
  const createsBeforeRace=creates;
  process.env.PROCESS_ROLE='api';
  let race;
  try {
    race=await Promise.all([
      assign(cookie,employee.id,goal),
      request('PATCH',`/api/policies/${approvalPolicy.json().id}`,{cookie,body:{active:false}}),
    ]);
  } finally { delete process.env.PROCESS_ROLE; }
  const [raceAssignment,racePolicyEdit]=race;
  assert.equal(racePolicyEdit.statusCode,200,racePolicyEdit.body);
  if (raceAssignment.statusCode===202) {
    const raceWorkflowId=raceAssignment.json().taskId;
    assert.equal((await get('SELECT deployment_id FROM workflows WHERE id=?',raceWorkflowId)).deployment_id,raceDeploymentId);
    await pollWorkerOnce();
    const refusedRaceTask=await waitForWorkflow(raceWorkflowId,['failed','completed','reconciliation_required']);
    assert.equal(refusedRaceTask.status,'failed',refusedRaceTask.error);
    assert.match(refusedRaceTask.error,/stale|probation/i);
    assert.equal((await get('SELECT COUNT(*) AS count FROM tool_runs WHERE workflow_id=?',raceWorkflowId)).count,0);
    assert.equal((await get('SELECT COUNT(*) AS count FROM workflow_artifacts WHERE workflow_id=?',raceWorkflowId)).count,0);
  } else {
    assert.equal(raceAssignment.statusCode,409,raceAssignment.body);
    assert.equal(raceAssignment.json().error,'pilot_deployment_stale',raceAssignment.body);
  }
  assert.equal((await get('SELECT COUNT(*) AS count FROM workflows WHERE org_id=?',organization.id)).count,workflowCountBeforeRace+(raceAssignment.statusCode===202?1:0));
  assert.equal(creates,createsBeforeRace,'a policy/assignment race must not create a Jira issue');

  // The two external-MCP input resume entrypoints must recheck the workflow's
  // deployment before reading connection credentials or attempting dispatch.
  const mcpConnectionId='mcp_stale_resume_test';
  const mcpWorkflowId='task_stale_mcp_input_resume';
  const mcpTool={name:'lookup_record',description:'Look up one record',inputSchema:{type:'object',properties:{accountId:{type:'string'}},additionalProperties:false},readOnly:true};
  const timestamp=new Date().toISOString();
  await runDb('INSERT INTO mcp_connections(id,org_id,name,endpoint,token_ciphertext,tools,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',mcpConnectionId,organization.id,'Stale resume test','https://127.0.0.1/mcp',null,JSON.stringify([mcpTool]),'connected',user.id,timestamp,timestamp);
  const requestKey='mcp-0';
  const inputRequest={method:'mcp.tasks/update',params:{taskId:'remote-task-stale',inputRequests:{customer_reference:{description:'Provide a customer reference.'}}}};
  await runDb("INSERT INTO workflows(id,org_id,employee_id,created_by,goal,status,runtime_version,plan,step_index,spec_version,deployment_id,input_requests,created_at,updated_at) VALUES(?,?,?,?,?,'input_required','langgraph-react-v1',?,0,?,?,?, ?,?)",mcpWorkflowId,organization.id,employee.id,user.id,'Look up the support record after a manager supplies its reference.',JSON.stringify([{tool:`mcp.${mcpConnectionId}.${mcpTool.name}`,input:{accountId:'acct-1'},expectation:'Confirm the matching record.'}]),employee.spec.version,raceDeploymentId,JSON.stringify({[requestKey]:inputRequest}),timestamp,timestamp);
  await runDb('INSERT INTO tool_runs(id,org_id,workflow_id,step_index,tool,input,output,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)','run_stale_mcp_input_resume',organization.id,mcpWorkflowId,0,`mcp.${mcpConnectionId}.${mcpTool.name}`,JSON.stringify({accountId:'acct-1'}),JSON.stringify({mcpTask:{taskId:'remote-task-stale',sessionId:'session-stale',protocolVersion:'2026-07-28',status:'input_required',pollIntervalMs:1500,inputRequests:inputRequest.params.inputRequests}}),'started',timestamp);
  const managerResponses={customer_reference:{reference:'CASE-77'}};
  const httpResume=await request('POST',`/api/workflows/${mcpWorkflowId}/approve`,{cookie,body:{approved:true,mcpResponses:managerResponses}});
  assert.equal(httpResume.statusCode,409,httpResume.body);
  assert.equal(httpResume.json().error,'pilot_deployment_stale');
  const mcpResume=await request('POST','/mcp',{cookie,body:{jsonrpc:'2.0',id:'resume-stale',method:'tasks/update',params:{taskId:mcpWorkflowId,inputResponses:managerResponses,_meta:{'io.modelcontextprotocol/clientCapabilities':{extensions:{'io.modelcontextprotocol/tasks':{}}}}}},headers:{'mcp-method':'tasks/update','mcp-name':mcpWorkflowId}});
  assert.equal(mcpResume.statusCode,200,mcpResume.body);
  assert.equal(mcpResume.json().error.code,-32603,mcpResume.body);
  assert.match(mcpResume.json().error.message,/Pilot deployment evidence is missing or stale/);
  assert.equal((await get('SELECT status,input_requests FROM workflows WHERE id=?',mcpWorkflowId)).status,'input_required');
  assert.equal((await get('SELECT status FROM tool_runs WHERE id=?','run_stale_mcp_input_resume')).status,'started');
  const afterStaleResume=await assign(cookie,employee.id,goal);
  assert.equal(afterStaleResume.statusCode,409,afterStaleResume.body);
  assert.equal(afterStaleResume.json().error,'pilot_deployment_stale');
});
