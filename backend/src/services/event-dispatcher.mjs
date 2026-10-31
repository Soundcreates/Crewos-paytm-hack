import { createHash } from 'node:crypto';
import { organizationEngineV2Status } from './feature-flags.mjs';

const parse = (value, fallback = []) => { try { return JSON.parse(value ?? ''); } catch { return fallback; } };
const privileged = new Set(['owner','admin','manager']);
export const capabilityGrantFingerprint = (capability,specVersion) => createHash('sha256').update(`${capability}\u0000${Number(specVersion)}`).digest('hex');

/** Local-only dispatcher foundation. It validates authorization and records a blocked result;
 * there is deliberately no workflow enqueue or effect adapter in this tranche. */
export function createEventDispatcher({ repository, transaction = async (fn) => fn(), timestamp, newId, checkPolicy, riskFloor, currentPolicyRevision, enqueueSimulationWorkflow, startSimulationWorkflow, executeEventResponse, env = process.env, owner = 'event-dispatcher', workerAdapterEnabled = false, leaseMs = 30_000, maxAttempts = 8 }) {
  const deny = (reason, details = {}) => ({ allowed:false, reason, details });
  async function authorize(row) {
    if (!row) return deny('dispatch_binding_missing');
    const accepted=parse(row.outcome_json,{}).acceptedBinding;
    if (!accepted || accepted.orgId!==row.org_id || accepted.inboxId!==row.inbox_id || accepted.subscriptionId!==row.subscription_id
      || accepted.principalId!==row.service_principal_id || accepted.managerUserId!==row.manager_grant_user_id
      || accepted.employeeId!==row.employee_id || accepted.connectionId!==row.connection_id || accepted.provider!==row.provider
      || accepted.eventType!==row.event_type || accepted.environment!==row.inbox_environment || accepted.simulated!==Number(row.simulated)
      || accepted.sourceVersion!==row.external_event_id || accepted.capability!==row.required_capability
      || accepted.specVersion!==Number(row.spec_version) || accepted.deploymentId!==row.deployment_id) return deny('accepted_binding_changed');
    if (!organizationEngineV2Status(row.org_id,env).enabled) return deny('organization_engine_v2_disabled');
    const subscription = await repository.findActiveSubscriptionForDispatch(row.org_id,row.subscription_id);
    if (!subscription || !Number(subscription.enabled)) return deny('subscription_disabled');
    if (subscription.principal_kind !== 'org_service' || subscription.principal_status !== 'active') return deny('service_principal_invalid');
    const roleResult = await repository.findMembershipRole(row.org_id,subscription.authorized_by);
    const managerRole = (typeof roleResult==='string' ? roleResult : roleResult?.role)?.toLowerCase();
    if (!privileged.has(managerRole)) return deny('subscription_manager_grant_invalid');
    if (row.simulated && subscription.environment === 'production') return deny('fixture_production_blocked');
    if (subscription.environment !== row.inbox_environment || subscription.connection_id!==row.connection_id || subscription.event_type!==row.event_type || subscription.employee_id!==row.employee_id || subscription.principal_id!==row.service_principal_id || subscription.authorized_by!==row.manager_grant_user_id) return deny('binding_mismatch');
    if (row.provider!=='shopify'||subscription.environment!=='simulation'||Number(row.simulated)!==1) return deny('simulation_shopify_fixture_required');
    if (subscription.connection_status !== 'connected' || subscription.revoked_at) return deny('connection_unavailable');
    if (subscription.credential_expires_at && Date.parse(subscription.credential_expires_at) <= Date.parse(timestamp())) return deny('connection_credential_expired');
    const connectionScopes = parse(subscription.granted_scopes);
    const requiredScopes = parse(subscription.required_scopes);
    if (!Array.isArray(connectionScopes) || !Array.isArray(requiredScopes) || requiredScopes.some(scope => !connectionScopes.includes(scope))) return deny('connection_scope_missing');
    if (subscription.employee_state !== 'active' || !subscription.deployment_id || !subscription.spec_data) return deny('employee_not_deployed');
    const spec = parse(subscription.spec_data,{});
    if (!['commerce.order.analyze','support.case.triage'].includes(subscription.required_capability)) return deny('simulation_capability_not_allowlisted');
    const toolGrants = Array.isArray(spec.tools) ? spec.tools : [];
    const capabilities=Array.isArray(spec.capabilities)?spec.capabilities.map(item=>typeof item==='string'?item:item?.key||item?.name).filter(Boolean):[];
    if (!toolGrants.includes(subscription.required_capability)&&!capabilities.includes(subscription.required_capability)) return deny('employee_capability_missing');
    if (subscription.capability_grant_hash && subscription.capability_grant_hash !== capabilityGrantFingerprint(subscription.required_capability,subscription.spec_version)) return deny('capability_grant_stale');
    // This path only reads a signed, local Shopify fixture. Current employee
    // deployment, grants and policy are checked below; external provider
    // readiness/probation is not required for this hackathon simulation.
    if (subscription.connection_config) {
      const config = parse(subscription.connection_config, {});
      if (config.fixture !== true || config.identityVerified !== true || config.effectsEnabled === true) return deny('simulation_connection_not_fixture');
    }
    if (typeof checkPolicy!=='function' || typeof riskFloor!=='function') return deny('policy_or_risk_verifier_unavailable');
    const policy = await checkPolicy({ orgId:row.org_id, employeeId:subscription.employee_id, capability:subscription.required_capability, environment:subscription.environment });
    const floor = await riskFloor(subscription.required_capability,subscription.environment);
    if (!policy || !['ALLOW','ordinary_policy'].includes(policy.decision)) return deny('current_policy_denied',{decision:policy?.decision || 'missing'});
    if (!floor || !['ALLOW','ordinary_policy'].includes(floor.decision)) return deny('mandatory_risk_approval_unavailable',{decision:floor?.decision || 'missing'});
    if (!workerAdapterEnabled || (typeof executeEventResponse !== 'function' && typeof enqueueSimulationWorkflow !== 'function')) return deny('worker_adapter_disabled');
    return { allowed:true, subscription, policy };
  }
  async function createForInbox(orgId,inboxId) {
    const inbox = await repository.findInboxById(orgId,inboxId);
    if (!inbox || inbox.org_id !== orgId) throw Object.assign(new Error('Verified inbox event was not found in this organization.'),{code:'event_tenant_mismatch'});
    const subscriptions = await repository.findSubscriptionsForInbox(orgId,inboxId);
    const created=[];
    for (const item of subscriptions) {
      if (!item.principal_id || !item.authorized_by) continue;
      const subscription=await repository.findEventDelegationSubscription(orgId,item.id);
      if(!subscription)continue;
      const normalized=parse(inbox.normalized,{});
      const acceptedBinding={orgId,inboxId,subscriptionId:item.id,principalId:item.principal_id,managerUserId:item.authorized_by,employeeId:subscription.employee_id,connectionId:inbox.connection_id,provider:inbox.provider,eventType:inbox.event_type,environment:inbox.environment,simulated:Number(inbox.simulated),sourceVersion:inbox.external_event_id,capability:subscription.required_capability,specVersion:Number(subscription.spec_version),deploymentId:subscription.deployment_id,sourceOccurredAt:normalized.occurred_at||normalized.occurredAt||null};
      const at=timestamp();
      const result = await repository.insertEventDispatchRecord(newId('dispatch'),orgId,inboxId,item.id,item.principal_id,item.authorized_by,null,JSON.stringify({acceptedBinding}),at,at);
      const record = await repository.findDispatchByEventSubscription(orgId,inboxId,item.id);
      if (record) created.push({ record, inserted:Boolean(result?.changes) });
    }
    return created;
  }
  async function dispatch(orgId,dispatchId) {
    const acquiredAt=timestamp(),leaseExpiresAt=new Date(Date.now()+leaseMs).toISOString();
    const claim=await transaction(async()=>{
      const leased=await repository.claimEventDispatch(orgId,dispatchId,owner,leaseExpiresAt,acquiredAt);
      if(!leased?.changes)return null;
      const claimedRow=await repository.findDispatchById(orgId,dispatchId);
      if(!claimedRow||claimedRow.worker_owner!==owner||claimedRow.state!=='checking'||claimedRow.lease_expires_at!==leaseExpiresAt)return null;
      return {owner,generation:Number(claimedRow.lease_generation),expiresAt:leaseExpiresAt};
    });
    if (!claim) return { state:'not_claimed' };
    const row=await repository.findDispatchInputs(orgId,dispatchId);
    const generation=claim.generation;
    try {
      const authorization=await authorize(row);
      let state='blocked',reason=authorization.reason||null,taskLink=null;
      const outcome={ checkedAt:timestamp(), authorization:authorization.allowed ? 'authorized' : 'blocked', reason, workerAdapterEnabled:Boolean(workerAdapterEnabled), taskCreated:false, workflowEnqueued:false, effectExecuted:false };
      if(authorization.allowed){
        const current=await repository.findDispatchInputs(orgId,dispatchId);const rechecked=await authorize(current);
        if(!rechecked.allowed)reason=rechecked.reason;
        else if (typeof executeEventResponse === 'function') {
          // The event-response coordinator owns primary/child workflow creation,
          // verified evidence and terminal dispatch transitions. It runs after
          // the dispatch claim and outside the transaction, using that claim.
          const response = await executeEventResponse({ orgId, dispatchId, lease: claim });
          return { state: response?.state ?? 'pending', reason: response?.error?.message ?? null, outcome: response };
        }
        else {
          await transaction(async()=>{
            const at=timestamp();
            const leaseRow=await repository.findDispatchById(orgId,dispatchId);
            if(!leaseRow||leaseRow.worker_owner!==claim.owner||Number(leaseRow.lease_generation)!==claim.generation||leaseRow.state!=='checking'||leaseRow.lease_expires_at!==claim.expiresAt||Date.parse(leaseRow.lease_expires_at)<=Date.parse(at))throw Object.assign(new Error('Dispatch lease is no longer current.'),{code:'dispatch_lease_lost'});
            const fresh=await repository.findDispatchInputs(orgId,dispatchId),finalAuth=await authorize(fresh);
            if(!finalAuth.allowed)throw Object.assign(new Error(`Dispatch authorization changed: ${finalAuth.reason}`),{code:'dispatch_authorization_changed'});
            taskLink=await enqueueSimulationWorkflow({orgId,dispatchId,row:fresh,subscription:finalAuth.subscription,policy:finalAuth.policy,lease:claim});
            if(!taskLink?.taskId||!taskLink?.workflowId)throw Object.assign(new Error(taskLink?.blockedReason||'simulation_workflow_adapter_unavailable'),{code:'simulation_workflow_adapter_unavailable'});
            const linked=await repository.linkEventDispatchTask(orgId,dispatchId,taskLink.taskId,claim.owner,claim.generation,claim.expiresAt,at);
            if(linked?.changes!==1)throw Object.assign(new Error('Dispatch lease was lost before task linkage.'),{code:'dispatch_lease_lost'});
            state='enqueued';reason=null;outcome.taskCreated=true;outcome.workflowEnqueued=true;outcome.taskId=taskLink.taskId;outcome.workflowId=taskLink.workflowId;
            outcome.acceptedBinding=parse(fresh.outcome_json,{}).acceptedBinding;
            const saved=await repository.finishEventDispatch(orgId,dispatchId,claim.owner,claim.generation,state,reason,outcome,timestamp());
            if(saved?.changes!==1)throw Object.assign(new Error('Dispatch state could not be atomically published.'),{code:'dispatch_lease_lost'});
          });
        }
      }
      outcome.authorization=state==='enqueued'?'authorized':authorization.allowed?'blocked':authorization.decision||'blocked';outcome.reason=reason;
      if(state!=='enqueued'){
        const saved=await repository.finishEventDispatch(orgId,dispatchId,owner,generation,state,reason,{...outcome,acceptedBinding:parse(row.outcome_json,{}).acceptedBinding},timestamp());
        if (saved?.changes !== 1) return { state:'lease_lost' };
      }
      if(state==='enqueued'){
        if(typeof startSimulationWorkflow==='function')await startSimulationWorkflow({orgId,workflowId:taskLink.workflowId,taskId:taskLink.taskId});
        return {state,reason:null,outcome};
      }
      return { state, reason, outcome };
    } catch (error) {
      const latest=await repository.findDispatchById?.(orgId,dispatchId);
      const attempts=Number(latest?.attempts || row?.attempts || 1);
      const dead=attempts>=maxAttempts;
      await repository.retryEventDispatch(orgId,dispatchId,owner,generation,dead?null:new Date(Date.now()+Math.min(300_000,1000*2**Math.max(0,attempts-1))).toISOString(),String(error?.message || 'dispatch_check_failed').slice(0,300),timestamp(),dead?'dead_letter':'retry');
      throw error;
    }
  }
  async function processOutbox(orgId,outboxId,durableDelivery) {
    const leased=await durableDelivery.claimOutbox(outboxId);
    if (!leased || leased.org_id!==orgId || leased.type!=='webhook.received') return { state:'not_claimed' };
    let payload;
    try { payload=JSON.parse(leased.payload); } catch { await durableDelivery.failOutbox(outboxId,leased.lease_generation,leased.attempts,'invalid_outbox_payload'); return {state:'dead_letter'}; }
    try {
      if (!payload?.inboxId) throw new Error('outbox_inbox_missing');
      const inbox=await durableDelivery.claimInbox(orgId,payload.inboxId);
      if (!inbox) {
        const current=await repository.findInboxById(orgId,payload.inboxId);
        if (current?.state==='processed') {
          const done=await durableDelivery.finishOutbox(outboxId,leased.lease_generation);
          return {state:done?.changes===1?'delivered':'lease_lost',dispatches:0};
        }
        throw new Error('inbox_lease_unavailable');
      }
      const rows=await createForInbox(orgId,payload.inboxId);
      // API ingress records durable work only. The worker poller claims and runs
      // the response chain so request handling never owns employee execution.
      if (typeof executeEventResponse !== 'function') {
        for (const item of rows) await dispatch(orgId,item.record.id);
      }
      const inboxDone=await durableDelivery.finishInbox(orgId,payload.inboxId,inbox.lease_generation);
      if (inboxDone?.changes!==1) throw new Error('inbox_lease_lost');
      const result=await durableDelivery.finishOutbox(outboxId,leased.lease_generation);
      return {state:result?.changes===1?'delivered':'lease_lost',dispatches:rows.length};
    } catch (error) {
      await durableDelivery.failOutbox(outboxId,leased.lease_generation,leased.attempts,error?.message || 'dispatch_failed');
      throw error;
    }
  }
  async function processReady(limit = 10) {
    if (!workerAdapterEnabled || typeof executeEventResponse !== 'function' || typeof repository.findReadyEventDispatches !== 'function') return [];
    const rows = await repository.findReadyEventDispatches(timestamp(), limit);
    const results = [];
    for (const row of rows) {
      try { results.push(await dispatch(row.org_id, row.id)); }
      catch (error) { results.push({ state: 'retry', id: row.id, error: error?.code || 'dispatch_failed' }); }
    }
    return results;
  }
  return { authorize, createForInbox, dispatch, processOutbox, processReady };
}
