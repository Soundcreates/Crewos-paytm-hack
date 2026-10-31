import { repositories } from '../src/repositories/index.mjs';
import { runtimeRevision } from './revision.mjs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { MemorySaver } from '@langchain/langgraph';
import { id, now, transaction } from '../lib/db.mjs';
import { getSecret } from '../lib/secrets.mjs';
import { getLlmModel } from '../lib/llm-provider.mjs';
import { buildEmployeeToolRegistry } from './langgraph/tool-registry.mjs';
import { callLlmTools } from './langgraph/llm-client.mjs';
import { Command, createReActWorkflowGraph } from './langgraph/graph.mjs';
import { organizationEngineV2Status } from '../src/services/feature-flags.mjs';

export const pilotMode = () => process.env.PILOT_MODE === 'true' || (process.env.NODE_ENV === 'production' && process.env.PILOT_MODE !== 'false');
export const pilotTools = new Set(['jira.create_issue','payments.refund','tinyfish.search']);

async function shopifyFixtureProbationReadiness(orgId){
  if(pilotMode()||!organizationEngineV2Status(orgId).enabled)return null;
  const revision=await policyRevision(orgId),connections=await repositories.foundation.findSimulationShopifyConnections(orgId);
  for(const connection of connections){
    const config=JSON.parse(connection.config||'{}'),scopes=JSON.parse(connection.granted_scopes||'[]');
    if(connection.status!=='connected'||config.fixture!==true||config.identityVerified!==true||!scopes.includes('read_products')||!scopes.includes('write_products'))continue;
    const readiness=await repositories.foundation.findReadinessForEventCapability(orgId,'shopify.product.set',connection.id);
    if(readiness?.readiness_state==='ready'&&readiness.probation_state==='passed'&&readiness.policy_revision===revision&&readiness.handler_id==='shopify-fixture-product-set-v1'&&readiness.verifier_id==='shopify-fixture-readback-v1'&&['read_products','write_products'].every(scope=>JSON.parse(readiness.required_scopes||'[]').includes(scope)))return {connectionId:connection.id,state:'ready',connectionStatus:'connected',credentialState:'fixture',environment:'simulation',requiredScopes:['read_products','write_products'],grantedScopes:scopes,handlerId:readiness.handler_id,verifierId:readiness.verifier_id,policyRevision:revision};
  }
  return null;
}

export async function policyRevision(orgId) {
  const rows=await repositories.policies.findManyPolicyByOrgIdSelectIdToolEffect(orgId);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export async function ensureRequiredProbation(orgId,employee,userId) {
  const spec=employee.spec;
  if (!spec) throw Object.assign(new Error('Create an employee spec first.'),{status:409});
  const unsupported=spec.tools.filter(tool=>!pilotTools.has(tool)&&!(tool==='shopify.product.set'&&!pilotMode()));
  if (!spec.tools.length || unsupported.length) throw Object.assign(new Error('Employee probation includes an unsupported capability grant.'),{status:409});
  if(spec.tools.includes('shopify.product.set')&&!await shopifyFixtureProbationReadiness(orgId))throw Object.assign(new Error('Shopify product-set probation requires a verified simulation fixture with current readiness.'),{status:409,code:'readiness_required'});
  const simulationId=`sim_required_${employee.id}_${spec.version}`;
  const scenario={pilotContract:true,runtimeVersion:'langgraph-react-v1',tools:spec.tools,objective:'Verify deployed duties, approvals, denials, and provider failure handling in controlled adapters.'};
  await transaction(async () => {
    await repositories.simulations.insertSimulationWithIdOrgIdName(simulationId, orgId, `Required probation · ${employee.name} v${spec.version}`, scenario.objective, JSON.stringify(scenario), '[]', userId, now(), now());
    await repositories.simulations.insertProbationRequirement(orgId, employee.id, spec.version, simulationId);
  });
  return simulationId;
}

export async function runRequiredProbation({orgId,employee,userId,catalog,checkPolicy,jobId}) {
  const simulationId=await ensureRequiredProbation(orgId,employee,userId);
  const runId=jobId ? `simrun_${jobId}` : id('simrun');
  const existing=await repositories.simulations.findOneSimulationRunByIdAndOrgId(runId, orgId);
  if (existing) return {...existing,passed:Boolean(existing.passed),evidence:JSON.parse(existing.evidence)};
  const revision=await policyRevision(orgId);
  // New provider-backed tools are omitted unless the registry receives a live,
  // connected readiness proof plus a passing representative probation snapshot.
  // Pilot mode remains an unconditional restriction for those tools.
  const shopifyReadiness=employee.spec.tools.includes('shopify.product.set')?await shopifyFixtureProbationReadiness(orgId):null;
  const registry=buildEmployeeToolRegistry(catalog,employee.spec.tools,{pilotMode:pilotMode(),providerReadiness:entry=>entry.key==='shopify.product.set'?shopifyReadiness:null,providerProbation:entry=>entry.key==='shopify.product.set'&&shopifyReadiness?{passed:true,policyRevision:shopifyReadiness.policyRevision}:null});
  const apiKey=await getSecret(orgId,'openrouter');
  if (pilotMode() && !apiKey) throw Object.assign(new Error('Configure the LLM provider before pilot probation.'),{status:503});
  const evidence=[];
  for (const tool of registry) {
    const input=tool.key === 'jira.create_issue' ? {title:'Probation support case',description:'Verify the SOP and record the support case.'}
      : tool.key === 'payments.refund' ? {amount:42,currency:'USD',caseId:'PROBATION'}
        : tool.key==='shopify.product.set'?{connectionId:shopifyReadiness.connectionId,idempotencyKey:`probation-${employee.id}-${employee.spec.version}`,products:[{title:'Probation catalog item',variants:[{sku:'PROBATION-ITEM',priceMinor:100,currency:'USD'}]}]}
          : {query:'support escalation policy'};
    for (const mode of ['success','approval','rejection','denial','provider_failure']) {
      let executed=0;
      let authorized=false;
      const policy=await checkPolicy(orgId,employee.spec,tool.key,input);
      // Success uses the real workspace policy; other cases inject a stricter
      // boundary or provider failure, never an external side effect.
      const decision=mode === 'denial' ? 'DENY' : ['approval','rejection'].includes(mode) ? 'REQUIRE_APPROVAL' : policy.decision;
      const config={configurable:{thread_id:`${runId}:${tool.key}:${mode}`},recursionLimit:60};
      const graph=createReActWorkflowGraph({
        checkpointer:new MemorySaver(),registry:[tool],maxToolCalls:1,
        modelCall: apiKey ? (messages,tools) => callLlmTools({apiKey,messages,tools}) : async messages => messages.some(message => message.role === 'tool') ? {content:'The controlled action is verified.'} : {content:'',tool_calls:[{id:'fixture',function:{name:tool.name,arguments:JSON.stringify(input)}}]},
        authorizeTool:async (_tool,proposed) => { if (!isDeepStrictEqual(proposed,input)) throw new Error('The model did not reproduce the requested case fields.'); authorized=true; return {decision,reason:'Required probation boundary'}; },
        executeTool:async () => {executed++;if(mode === 'provider_failure') throw Object.assign(new Error('Injected provider failure'),{code:'injected_failure'});return {ok:true,simulated:true,input};},
        verifyTool:async (_key,output) => ({verified:output.simulated === true && isDeepStrictEqual(output.input,input),evidence:{simulated:true,matched:true}}),
        validateOutcome:async ({steps}) => {if(steps.length !== 1) throw new Error('The controlled task has no execution evidence.');},
        onProposedTool:async()=>{},onVerifiedTool:async()=>{},onEvent:async()=>{},
      });
      let passed=false,observed='';
      try {
        let state=await graph.invoke({messages:[{role:'system',content:'Execute exactly the requested tool and input using the supplied tool. After its result, provide a concise answer. Do not invent success.'},{role:'user',content:JSON.stringify({tool:tool.key,input})}]},config);
        if(state.__interrupt__?.length) state=await graph.invoke(new Command({resume:{approved:mode !== 'rejection'}}),config);
        passed=state.status === 'completed' && executed === 1 && !['denial','rejection','provider_failure'].includes(mode);
        observed=state.status;
      } catch(error) {
        observed=error.code || 'error';
        passed=authorized && ((mode === 'denial' && error.code === 'policy_denied' && executed === 0)
          || (mode === 'rejection' && error.code === 'approval_rejected' && executed === 0)
          || (mode === 'provider_failure' && error.code === 'injected_failure' && executed === 1)
          || (decision === 'DENY' && mode === 'success' && error.code === 'policy_denied' && executed === 0));
      }
      evidence.push({criterion:`${tool.key}: ${mode}`,tool:tool.key,input,passed,points:1,plannerMode:apiKey ? 'llm' : 'fixture',observedDecision:observed,simulated:true,executionCount:executed});
    }
  }
  const passed=revision === await policyRevision(orgId) && evidence.length>0 && evidence.every(item => item.passed);
  const score=evidence.length ? evidence.filter(item => item.passed).length/evidence.length : 0;
  const snapshot={pilotContract:true,runtimeVersion:'langgraph-react-v1',runtimeRevision,policyRevision:revision,tools:employee.spec.tools};
  await repositories.simulations.insertSimulationRunWithIdOrgIdSimulationId(runId, orgId, simulationId, JSON.stringify(snapshot), employee.id, employee.spec.version, score, Number(passed), JSON.stringify(evidence), now(), now());
  return {id:runId,simulationId,passed,score,evidence,status:'completed'};
}

export async function deploymentEvidence(orgId,employee) {
  if (pilotMode() && (!employee.spec?.tools?.length || employee.spec.tools.some(tool=>!pilotTools.has(tool)))) throw Object.assign(new Error('Pilot employees support Jira creation, simulated refunds, and public search. Remove unsupported grants before probation.'),{status:409});
  const requirements=await repositories.simulations.findManyProbationRequirementByOrgIdAndEmployeeIdAndSpecVersion(orgId, employee.id, employee.spec.version);
  if (!requirements.length) throw Object.assign(new Error('Run required probation for this employee before deploying.'),{status:409});
  const revision=await policyRevision(orgId);
  const evidence=[];
  for (const requirement of requirements) {
    const latest=await repositories.simulations.findOneSimulationRunByOrgIdAndEmployeeIdAndSpecVersionSelectIdPassedSuiteSnapshot(orgId, employee.id, employee.spec.version, requirement.simulation_id, requirement.version);
    const snapshot=latest && JSON.parse(latest.suite_snapshot);
    if (!latest?.passed || snapshot.runtimeVersion !== 'langgraph-react-v1' || snapshot.runtimeRevision !== runtimeRevision || snapshot.policyRevision !== revision) throw Object.assign(new Error('Required probation is missing, failed, or stale after a policy change.'),{status:409});
    evidence.push({simulationId:requirement.simulation_id,suiteVersion:requirement.version,runId:latest.id});
  }
  return {evidence,policyRevision:revision};
}

function evidenceKey(evidence) {
  return (Array.isArray(evidence) ? evidence : [])
    .map(item => `${item.simulationId}:${item.suiteVersion}:${item.runId}`)
    .sort()
    .join('|');
}

function readEvidence(value) {
  try { return JSON.parse(value || '[]'); }
  catch { return null; }
}

export async function assertCurrentPilotDeployment(orgId, employee, expectedDeploymentId) {
  if (!pilotMode()) return null;
  if (!employee?.spec) throw Object.assign(new Error('Create an employee spec before assigning pilot work.'),{status:409});
  let accepted;
  try { accepted=await deploymentEvidence(orgId,employee); }
  catch (error) {
    if (error.status===409) throw Object.assign(new Error('Pilot deployment evidence is missing or stale for the current spec, runtime, or policy. Run probation and deploy again.'),{status:409,code:'pilot_deployment_stale',cause:error});
    throw error;
  }
  const deployment=await repositories.employees.findOneEmployeeDeploymentByOrgIdAndEmployeeIdAndSpecVersion(orgId,employee.id,employee.spec.version);
  if (!deployment
    || deployment.runtime_version!==runtimeRevision
    || deployment.policy_revision!==accepted.policyRevision
    || evidenceKey(readEvidence(deployment.evidence))!==evidenceKey(accepted.evidence)
    || (expectedDeploymentId!==undefined && deployment.id!==expectedDeploymentId)) {
    throw Object.assign(new Error('Pilot deployment evidence is missing or stale for the current spec, runtime, or policy. Run probation and deploy again.'),{status:409,code:'pilot_deployment_stale'});
  }
  return deployment;
}

// Presentation uses the same evidence gate as deployment, without changing state.
export async function deploymentReadiness(orgId, employee) {
  const version=employee.spec?.version;
  const blocked=(reason)=>({canDeploy:false,currentSpecVersion:version ?? null,reason});
  if (!employee.spec) return blocked('Save a role before running probation.');
  if (employee.state==='archived') return blocked('Restore this employee before deploying.');
  if (pilotMode() && (!employee.spec.tools?.length || employee.spec.tools.some(tool=>!pilotTools.has(tool)))) return blocked('Choose supported pilot tools before running probation.');
  if (pilotMode()) {
    try { const proof=await deploymentEvidence(orgId,employee); return {canDeploy:true,currentSpecVersion:version,reason:`Required checks passed for version ${version}.`,evidence:proof.evidence}; }
    catch(error) {
      if (error.status!==409) throw error;
      const past=await repositories.simulations.findOneSimulationRunByOrgIdAndEmployeeIdAndPassed(orgId, employee.id);
      if (past && Number(past.spec_version)!==Number(version)) return blocked(`Version ${version} needs probation. The latest passing run is for version ${past.spec_version}.`);
      return blocked(past ? 'Rerun required probation for the current role, policy, and runtime.' : `Run required probation for version ${version} before deploying.`);
    }
  }
  const proof=await repositories.simulations.findOneSimulationRunByOrgIdAndEmployeeIdAndSpecVersion(orgId, employee.id, version);
  if (proof) return {canDeploy:true,currentSpecVersion:version,reason:`Probation passed for version ${version}.`,evidence:[{runId:proof.id}]};
  const past=await repositories.simulations.findOneSimulationRunByOrgIdAndEmployeeIdAndPassed(orgId, employee.id);
  return blocked(past ? `Version ${version} needs probation. The latest passing run is for version ${past.spec_version}.` : `Run and pass probation for version ${version} before deploying.`);
}
