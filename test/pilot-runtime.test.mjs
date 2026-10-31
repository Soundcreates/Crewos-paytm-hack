import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';
import { MemorySaver } from '@langchain/langgraph';
import { createReActWorkflowGraph } from '../backend/workflows/langgraph/graph.mjs';
import { buildEmployeeToolRegistry } from '../backend/workflows/langgraph/tool-registry.mjs';
import { validateTaskOutcome } from '../backend/workflows/outcome.mjs';

const directory=mkdtempSync(join(tmpdir(),'crewos-pilot-'));
Object.assign(process.env,{NODE_ENV:'test',DATABASE_URL:'',NEON_AUTH_BASE_URL:'',DATABASE_FILE:join(directory,'pilot.sqlite'),APP_ORIGIN:'http://localhost:4173',APP_MASTER_KEY:'pilot-test-master-key-123456789',REQUEST_TRACE:'false'});
delete process.env.OPENROUTER_API_KEY;
delete process.env.PINECONE_API_KEY;
const {handleHttpRequest,pollWorkerOnce}=await import('../backend/server.mjs');
const {all,get,run,now,closeDatabase}=await import('../backend/lib/db.mjs');
const {verifySlackRequest}=await import('../backend/lib/slack.mjs');
const {encryptSecret}=await import('../backend/lib/secrets.mjs');
const originalFetch=globalThis.fetch;
after(async()=>{globalThis.fetch=originalFetch;await closeDatabase();rmSync(directory,{recursive:true,force:true});});

function response() {
  return {headers:new Map(),statusCode:200,body:'',setHeader(key,value){this.headers.set(key,value);},getHeader(key){return this.headers.get(key);},writeHead(status,headers={}){this.statusCode=status;for(const [key,value] of Object.entries(headers))this.headers.set(key,value);},end(body=''){this.body=String(body);},json(){return JSON.parse(this.body);}};
}
async function request(method,path,{body,cookie,raw,headers={}}={}) {
  const payload=raw || (body ? Buffer.from(JSON.stringify(body)) : null);
  const req=Readable.from(payload ? [payload] : []);
  Object.assign(req,{method,url:path,headers:{host:'localhost:4173',origin:'http://localhost:4173',...(body ? {'content-type':'application/json'} : {}),...(cookie ? {cookie} : {}),...headers},socket:{encrypted:false,remoteAddress:'127.0.0.1'}});
  const res=response();await handleHttpRequest(req,res);return res;
}
const registry=buildEmployeeToolRegistry([{key:'solari.sandbox.echo',label:'Echo'}],['solari.sandbox.echo']);
const options={registry,authorizeTool:async()=>({decision:'ALLOW'}),executeTool:async()=>({ok:true}),verifyTool:async()=>({verified:true,evidence:{confirmed:true}}),onProposedTool:async()=>{},onVerifiedTool:async()=>{},onEvent:async()=>{}};

test('the tool budget is enforced even if the model returns a call after tools are removed',async()=>{
  let executions=0;
  const graph=createReActWorkflowGraph({...options,maxToolCalls:1,executeTool:async()=>{executions++;return {ok:true};},modelCall:async()=>({content:'',tool_calls:[{id:'again',function:{name:registry[0].name,arguments:'{"message":"hello"}'}}]})});
  await assert.rejects(graph.invoke({messages:[{role:'user',content:'Run checks'}]}),error=>error.code === 'tool_budget_exhausted');
  assert.equal(executions,1);
});

test('task completion requires evidence and a matching Jira artifact for issue creation',()=>{
  assert.throws(()=>validateTaskOutcome('Create a Jira issue',[],{tools:['jira.create_issue']}),/no verified/);
  assert.throws(()=>validateTaskOutcome('Create a Jira issue',[{tool:'tinyfish.search',evidence:{sources:[]}}],{tools:['jira.create_issue']}),/requires a verified Jira/);
  assert.equal(validateTaskOutcome('Create a Jira issue',[{tool:'jira.create_issue',evidence:{matched:true}}],{tools:['jira.create_issue']}).verified,true);
});

test('the production runner resumes an approval from SQLite after a real process restart',()=>{
  const dbFile=join(directory,'restart.sqlite');
  const script=`
    import {runReActWorkflow,reactApprovalRequest} from './backend/workflows/langgraph/runner.mjs';
    import {buildEmployeeToolRegistry} from './backend/workflows/langgraph/tool-registry.mjs';
    import {get,run,closeDatabase} from './backend/lib/db.mjs';
    const registry=buildEmployeeToolRegistry([{key:'solari.sandbox.echo',label:'Echo'}],['solari.sandbox.echo']);
    const workflow={id:'restart-proof',input_requests:process.env.RESUME ? reactApprovalRequest({kind:'policy_approval',requestKey:'approval-0',tool:'solari.sandbox.echo',input:{message:'hello'}}) : {},input_responses:process.env.RESUME ? {'approval-0':{approved:true}} : {}};
    const result=await runReActWorkflow({workflow,registry,systemPrompt:'Check',userPrompt:'hello',modelCall:async messages=>messages.some(message=>message.role==='tool') ? {content:'Verified hello'} : {content:'',tool_calls:[{id:'call',function:{name:registry[0].name,arguments:'{"message":"hello"}'}}]},authorizeTool:async()=>({decision:'REQUIRE_APPROVAL',reason:'Review'}),executeTool:async()=>{await run("INSERT INTO service_leases(name,owner,expires_at) VALUES('executed','once','proof')");return {ok:true};},verifyTool:async()=>({verified:true,evidence:{}}),onProposedTool:async()=>{},onVerifiedTool:async()=>{},onEvent:async()=>{}});
    console.log(JSON.stringify({status:result.status,executions:(await get("SELECT COUNT(*) AS count FROM service_leases WHERE name='executed'")).count}));
    await closeDatabase();
  `;
  const child=resume=>spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),encoding:'utf8',env:{...process.env,DATABASE_FILE:dbFile,...(resume ? {RESUME:'1'} : {})}});
  const first=child(false);assert.equal(first.status,0,first.stderr);assert.deepEqual(JSON.parse(first.stdout),{status:'input_required',executions:0});
  const second=child(true);assert.equal(second.status,0,second.stderr);assert.deepEqual(JSON.parse(second.stdout),{status:'completed',executions:1});
});

test('Slack signatures bind the raw body and reject expired or malformed requests',()=>{
  const raw=Buffer.from('team_id=T123&text=run+emp_a+hello');
  const timestamp=String(Math.floor(Date.now()/1000));
  const secret='test-signing-secret';
  const signature=`v0=${createHmac('sha256',secret).update(`v0:${timestamp}:`).update(raw).digest('hex')}`;
  assert.equal(verifySlackRequest(raw,timestamp,signature,secret),true);
  assert.equal(verifySlackRequest(Buffer.from('changed'),timestamp,signature,secret),false);
  assert.equal(verifySlackRequest(raw,timestamp,signature,secret,Date.now()+301000),false);
  assert.equal(verifySlackRequest(raw,timestamp,'v0=no',secret),false);
});

test('Slack commands are tenant-bound, durable, deduplicated, and create a normal task',async()=>{
  const signup=await request('POST','/api/auth/signup',{body:{name:'Pilot owner',email:'pilot@example.test',password:'pilot-password-123',organization:'Pilot'}});
  assert.equal(signup.statusCode,201,signup.body);
  const cookies=signup.headers.get('set-cookie');
  const cookie=(Array.isArray(cookies)?cookies:[cookies]).find(value=>value.startsWith('crewos_session=')).split(';')[0];
  const orgId=signup.json().organization.id,userId=signup.json().user.id;
  const created=await request('POST','/api/employees',{cookie,body:{name:'Support',title:'Support specialist',mission:'Record support cases',responsibilities:['Follow the SOP'],tools:['payments.refund'],policies:[],capabilities:[],coworkers:[],successMetrics:[],evaluationPolicy:'Pass probation'}});
  assert.equal(created.statusCode,201,created.body);
  const employee=created.json();
  await run("UPDATE employees SET state='active' WHERE id=?",employee.id);
  await run('INSERT INTO slack_installations(org_id,team_id,team_name,bot_token,channel_ids,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',orgId,'T123','Test team',encryptSecret('xoxb-test-bot-token'),'["C123"]',now(),now());
  await run('INSERT INTO slack_users(team_id,slack_user_id,org_id,user_id) VALUES(?,?,?,?)','T123','U123',orgId,userId);
  process.env.SLACK_SIGNING_SECRET='signed-pilot-secret';
  const timestamp=String(Math.floor(Date.now()/1000));
  const raw=Buffer.from(new URLSearchParams({team_id:'T123',channel_id:'C123',user_id:'U123',text:`run ${employee.id} Process the simulated refund for case PILOT.`}).toString());
  const signature=`v0=${createHmac('sha256',process.env.SLACK_SIGNING_SECRET).update(`v0:${timestamp}:`).update(raw).digest('hex')}`;
  const send=()=>request('POST','/api/slack/commands',{raw,headers:{'content-type':'application/x-www-form-urlencoded','x-slack-request-timestamp':timestamp,'x-slack-signature':signature}});
  const started=Date.now();const accepted=await send();assert.equal(accepted.statusCode,200,accepted.body);assert.ok(Date.now()-started<3000);
  await send();
  assert.equal((await get("SELECT COUNT(*) AS count FROM background_jobs WHERE kind='slack.command'")).count,1);
  const invalid=await request('POST','/api/slack/commands',{raw,headers:{'x-slack-request-timestamp':timestamp,'x-slack-signature':'forged'}});assert.equal(invalid.statusCode,401);
  globalThis.fetch=async input=>{assert.equal(String(input),'https://slack.com/api/chat.postMessage');return new Response(JSON.stringify({ok:true,ts:'1'}),{headers:{'content-type':'application/json'}});};
  // The first poll consumes the command. Task execution remains in the normal queue.
  await pollWorkerOnce();
  for(let index=0;index<100;index++){if(await get('SELECT id FROM workflows WHERE org_id=?',orgId))break;await new Promise(resolve=>setTimeout(resolve,10));}
  const workflow=await get('SELECT * FROM workflows WHERE org_id=?',orgId);
  assert.equal(workflow.employee_id,employee.id);assert.equal(workflow.spec_version,1);assert.equal(JSON.parse(workflow.origin).type,'slack');
  const other=await request('POST','/api/auth/signup',{body:{name:'Other',email:'other-pilot@example.test',password:'pilot-password-123',organization:'Other'}});
  const otherCookies=other.headers.get('set-cookie');const otherCookie=(Array.isArray(otherCookies)?otherCookies:[otherCookies])[0].split(';')[0];
  const job=await get("SELECT id FROM background_jobs WHERE kind='slack.command'");
  assert.equal((await request('GET',`/api/jobs/${job.id}`,{cookie:otherCookie})).statusCode,404);
});

test('document imports run as durable jobs and reject conflicting idempotency keys',async()=>{
  const login=await request('POST','/api/auth/login',{body:{email:'pilot@example.test',password:'pilot-password-123'}});
  assert.equal(login.statusCode,200,login.body);
  const cookie=login.headers.get('set-cookie')[0].split(';')[0];
  const body={filename:'pilot-sop.txt',contentBase64:Buffer.from('Support SOP: verify the customer case, then record the issue in the approved project.').toString('base64')};
  const headers={prefer:'respond-async','idempotency-key':'pilot-sop'};
  const first=await request('POST','/api/documents',{body,cookie,headers});assert.equal(first.statusCode,202,first.body);
  const duplicate=await request('POST','/api/documents',{body,cookie,headers});assert.equal(duplicate.json().jobId,first.json().jobId);
  const conflict=await request('POST','/api/documents',{body:{...body,filename:'different.txt'},cookie,headers});assert.equal(conflict.statusCode,409);
  let job;
  for(let i=0;i<150;i++) {
    await pollWorkerOnce();
    job=await get('SELECT * FROM background_jobs WHERE id=?',first.json().jobId);
    if(['completed','failed'].includes(job.status))break;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(job.status,'completed',job.error);
  assert.equal(JSON.parse(job.result).filename,'pilot-sop.txt');
  assert.equal(job.payload,'{}','completed operations must not retain original uploads');
  assert.equal((await get('SELECT COUNT(*) AS count FROM documents WHERE filename=?','pilot-sop.txt')).count,1);
});
