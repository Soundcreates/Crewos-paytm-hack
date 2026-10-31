import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const mode = process.argv[2];
if (mode === 'model') {
  // A controlled local model, reachable only on the disposable internal Docker
  // network. This validates execution plumbing without a paid provider call.
  createServer(async (req,res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text || '{}');
    let message;
    if (body.response_format) message = {content:JSON.stringify({routes:['workspace_tools'],summary:'Use the granted simulated refund tool.'})};
    else if (body.messages?.some(item => item.role === 'tool')) message = {content:'The simulated refund was recorded and independently verified.'};
    else {
      const tool = body.tools?.find(item => /simulated customer refund/i.test(item.function.description));
      if (!tool) { res.writeHead(422); res.end('{}'); return; }
      message = {content:'',tool_calls:[{id:'controlled-refund',type:'function',function:{name:tool.function.name,arguments:JSON.stringify({amount:1,currency:'USD',caseId:'PG-ACCEPTANCE'})}}]};
    }
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({choices:[{message}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
  }).listen(8080,'0.0.0.0');
} else {
  const { all,get,run,now,closeDatabase } = await import('../backend/lib/db.mjs');
  const { createScheduleService } = await import('../backend/src/services/schedules.mjs');
  const orgId = 'org_pg_acceptance', userId = 'user_pg_acceptance';
  const context = {org:{id:orgId,role:'owner'},user:{id:userId}};
  const schedules = createScheduleService({
    async createWorkflow(org,employee,user,goal,plan,submission) {
      const id = 'task_pg_schedule';
      await run(`INSERT INTO workflows(id,org_id,employee_id,created_by,goal,status,runtime_version,plan,spec_version,origin,created_at,updated_at)
        VALUES(?,?,?,?,?,'queued','langgraph-react-v1','[]',1,?,?,?)`,id,org,employee,user,goal,JSON.stringify(submission.origin),now(),now());
      return {id};
    },
    async event() {},
  });
  try {
    if (mode === 'seed') {
      await run('INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)',orgId,'Disposable acceptance',now());
      await run('INSERT INTO users(id,name,email,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)',userId,'Acceptance owner','acceptance@example.test','unused','unused',now());
      await run('INSERT INTO memberships(org_id,user_id,role,created_at) VALUES(?,?,?,?)',orgId,userId,'owner',now());
      for (let i=0;i<13;i++) {
        const employeeId=`emp_pg_${i}`;
        await run('INSERT INTO employees(id,org_id,name,title,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',employeeId,orgId,`Worker ${i}`,'Acceptance analyst','active',now(),now());
        const spec={id:employeeId,version:1,identity:{name:`Worker ${i}`,title:'Acceptance analyst',departmentId:'Operations',managerId:userId,avatarId:'QA'},mission:'Verify simulated refund outcomes',responsibilities:['Follow workspace policy'],tools:['payments.refund'],policies:[],capabilities:[],coworkers:[],successMetrics:[],evaluationPolicy:'Controlled acceptance only',provenance:[]};
        await run('INSERT INTO employee_specs(id,employee_id,version,data,created_by,created_at) VALUES(?,?,1,?,?,?)',`spec_pg_${i}`,employeeId,JSON.stringify(spec),userId,now());
        if (i<12) await run(`INSERT INTO workflows(id,org_id,employee_id,created_by,goal,status,runtime_version,plan,spec_version,created_at,updated_at) VALUES(?,?,?,?,?,'queued','langgraph-react-v1','[]',1,?,?)`,`task_pg_${i}`,orgId,employeeId,userId,'Run the simulated USD $1 refund for case PG-ACCEPTANCE.',now(),now());
      }
      const schedule=await schedules.create(context,{name:'Postgres schedule',employeeId:'emp_pg_12',goal:'Run a simulated USD $1 refund for case PG-ACCEPTANCE.',kind:'interval',intervalMinutes:60,timezone:'UTC'});
      await run('UPDATE work_schedules SET next_run_at=? WHERE id=?',new Date(Date.now()-1000).toISOString(),schedule.id);
      console.log(JSON.stringify({migrations:(await all('SELECT version FROM schema_migrations')).length,queued:12}));
    } else if (mode === 'schedule') {
      await schedules.poll();
    } else if (mode === 'pause') {
      assert.equal((await get('SELECT COUNT(*) AS count FROM schedule_runs')).count,1);
      assert.equal((await get("SELECT COUNT(*) AS count FROM workflows WHERE id='task_pg_schedule'")).count,1);
      const [schedule]=await schedules.list(context);
      await schedules.setStatus(context,schedule.id,'paused',schedule.revision);
      console.log(JSON.stringify({competingSchedulers:'pass',occurrences:1}));
    } else if (mode === 'verify') {
      const deadline=Date.now()+45000;
      let rows;
      do {
        rows=await all('SELECT id,status,error,lease_generation FROM workflows ORDER BY id');
        if (rows.every(row=>['completed','failed'].includes(row.status))) break;
        await new Promise(resolve=>setTimeout(resolve,200));
      } while (Date.now()<deadline);
      assert.equal(rows.length,13);
      assert.ok(rows.every(row=>row.status==='completed'),JSON.stringify(rows));
      assert.ok(rows.every(row=>row.lease_generation===1),'every workflow should have exactly one claimant');
      assert.equal((await get('SELECT COUNT(*) AS count FROM simulated_refunds')).count,13);
      assert.equal((await get('SELECT COUNT(*) AS count FROM tool_runs')).count,13);
      const duplicates=await all('SELECT workflow_id,step_index,COUNT(*) AS count FROM tool_runs GROUP BY workflow_id,step_index HAVING COUNT(*)>1');
      assert.equal(duplicates.length,0);
      const checkpointTables=await all("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE '%checkpoint%'");
      assert.ok(checkpointTables.length>=3);
      console.log(JSON.stringify({workers:2,completed:13,verifiedRefunds:13,toolRuns:13,duplicateEffects:0,checkpointTables:checkpointTables.length,model:'controlled local fixture'}));
    } else if (mode === 'checkpoint-first' || mode === 'checkpoint-resume') {
      const {runReActWorkflow,reactApprovalRequest}=await import('../backend/workflows/langgraph/runner.mjs');
      const {buildEmployeeToolRegistry}=await import('../backend/workflows/langgraph/tool-registry.mjs');
      const registry=buildEmployeeToolRegistry([{key:'solari.sandbox.echo',label:'Echo'}],['solari.sandbox.echo']);
      const resume=mode==='checkpoint-resume';
      const request=reactApprovalRequest({kind:'policy_approval',requestKey:'approval-0',tool:'solari.sandbox.echo',input:{message:'postgres-restart'}});
      const workflow={id:'pg-checkpoint-restart',input_requests:resume?request:{},input_responses:resume?{'approval-0':{approved:true}}:{}};
      const result=await runReActWorkflow({workflow,registry,systemPrompt:'Verify recovery',userPrompt:'Echo postgres-restart',
        modelCall:async messages=>messages.some(item=>item.role==='tool')?{content:'Verified'}:{content:'',tool_calls:[{id:'pg-call',function:{name:registry[0].name,arguments:'{"message":"postgres-restart"}'}}]},
        authorizeTool:async()=>({decision:'REQUIRE_APPROVAL',reason:'Review'}),
        executeTool:async()=>{await run("INSERT INTO service_leases(name,owner,expires_at) VALUES('pg-restart-effect','once','proof')");return {ok:true};},
        verifyTool:async()=>({verified:true,evidence:{confirmed:true}}),onProposedTool:async()=>{},onVerifiedTool:async()=>{},onEvent:async()=>{},
      });
      assert.equal(result.status,resume?'completed':'input_required');
      assert.equal((await get("SELECT COUNT(*) AS count FROM service_leases WHERE name='pg-restart-effect'")).count,resume?1:0);
      console.log(JSON.stringify({postgresCheckpointRestart:result.status,effects:resume?1:0}));
    } else throw new Error('Unknown acceptance operation.');
  } finally { await closeDatabase(); }
}
