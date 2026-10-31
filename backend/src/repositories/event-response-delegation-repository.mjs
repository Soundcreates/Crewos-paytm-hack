import { createHash } from 'node:crypto';
import { organizationEngineV2Status } from '../services/feature-flags.mjs';

const parse = (value, fallback = null) => {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};
const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const hash = (value) => createHash('sha256').update(stable(value)).digest('hex');
const changed = (result) => Number(result?.changes ?? result?.rowCount ?? result?.count ?? 0) > 0;
const privileged = new Set(['owner', 'admin', 'manager']);
const SUPPORT_CAPABILITY = 'support.case.triage';
const SOURCE_CAPABILITY = 'commerce.order.analyze';
const LOCAL_RUNTIME = 'event-simulation-v1';
const FINAL_WORKFLOW = new Set(['completed', 'failed', 'cancelled']);
const BUSY_TASK_STATES = ['queued', 'running', 'waiting_approval', 'waiting_external', 'reconciling', 'planning'];

function capabilities(spec) {
  return (Array.isArray(spec?.capabilities) ? spec.capabilities : [])
    .map((value) => typeof value === 'string' ? value : value?.key ?? value?.name).filter(Boolean);
}
function scopeAllowsCoworker(spec, profileId) {
  return typeof profileId === 'string' && Array.isArray(spec?.coworkers) && spec.coworkers.map(String).includes(profileId);
}
function mapSlot(row) {
  if (!row) return null;
  const parsedTaskResult = parse(row.child_result_json, {});
  return {
    id: row.id,
    orgId: row.org_id,
    dispatchId: row.dispatch_id,
    parentWorkflowId: row.parent_workflow_id,
    parentTaskId: row.parent_task_id,
    childTaskId: row.child_task_id,
    childWorkflowId: row.child_workflow_id ?? null,
    childExecutionGeneration: row.child_execution_generation == null ? null : Number(row.child_execution_generation),
    slotKey: row.dispatch_slot_key,
    generation: Number(row.slot_generation ?? 0),
    state: row.state,
    employeeId: row.child_employee_id ?? null,
    grantId: row.grant_id ?? null,
    requestHash: row.request_hash,
    request: parse(row.request_json, null),
    evidenceRefs: parse(row.evidence_json, []),
    childResult: parsedTaskResult?.result ?? parsedTaskResult,
    resolution: parse(row.resolution_json, {}),
    legacy: Number(row.legacy) === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at ?? null,
  };
}

/** SQL-backed event delegation slot, child workflow, and evidence CAS operations. */
export function createEventResponseDelegationRepository({ all, get, run, transaction, newId, planDelegation, lockOrganization, lockEmployee } = {}) {
  if (![all, get, run, transaction, newId, planDelegation, lockOrganization, lockEmployee].every((fn) => typeof fn === 'function')) {
    throw new TypeError('Event delegation repository requires SQL helpers, organization and employee locks, and planDelegation.');
  }

  async function getSlot({ orgId, dispatchId, slotKey }) {
    const row = await get(`SELECT d.*,t.owner_employee_id AS child_employee_id,t.result_json AS child_result_json
      FROM task_delegations d
      LEFT JOIN crew_tasks t ON t.org_id=d.org_id AND t.id=d.child_task_id
      WHERE d.org_id=? AND d.dispatch_id=? AND d.dispatch_slot_key=?`, orgId, dispatchId, slotKey);
    return mapSlot(row);
  }

  async function activeDispatch({ orgId, dispatchId, lease, now }) {
    if (!lease?.owner || !Number.isInteger(lease.generation) || !now) return null;
    return get(`SELECT * FROM event_dispatch_records WHERE org_id=? AND id=? AND worker_owner=? AND lease_generation=?
      AND state IN ('checking','running') AND lease_expires_at>?`, orgId, dispatchId, lease.owner, lease.generation, now);
  }

  async function currentAuthority({ orgId, dispatch, parent, candidateEmployeeId, grantId, childSpec, now }) {
    const binding = parse(dispatch.outcome_json, {})?.acceptedBinding;
    const provenance = parse(parent.provenance_json, {});
    if (!organizationEngineV2Status(orgId).enabled || !binding || !provenance
      || dispatch.primary_workflow_id !== parent.id || Number(dispatch.lease_generation) < 1
      || parent.execution_role !== 'primary' || parent.runtime_version !== LOCAL_RUNTIME
      || parent.status !== 'waiting_dependency' || Number(parent.execution_generation) !== Number(childSpec.parentExecutionGeneration)
      || parent.idempotency_key !== `event-dispatch:${dispatch.id}`
      || provenance.dispatchId !== dispatch.id || provenance.orgId !== orgId
      || binding.orgId !== orgId || binding.inboxId !== dispatch.inbox_id || binding.subscriptionId !== dispatch.subscription_id
      || binding.principalId !== dispatch.service_principal_id || binding.managerUserId !== dispatch.manager_grant_user_id
      || binding.employeeId !== parent.employee_id || binding.connectionId !== provenance.connectionId
      || binding.eventType !== 'orders/paid' || binding.environment !== 'simulation' || Number(binding.simulated) !== 1
      || binding.sourceVersion !== provenance.eventId || binding.capability !== SOURCE_CAPABILITY
      || childSpec.orgId !== orgId || childSpec.role !== 'child' || childSpec.runtimeVersion !== LOCAL_RUNTIME
      || childSpec.employeeId !== candidateEmployeeId || childSpec.createdBy !== dispatch.manager_grant_user_id
      || childSpec.servicePrincipalId !== dispatch.service_principal_id || childSpec.subscriptionId !== dispatch.subscription_id
      || childSpec.connectionId !== provenance.connectionId || childSpec.capability !== SUPPORT_CAPABILITY
      || childSpec.parentWorkflowId !== parent.id || childSpec.slotKey !== `event-delegation:${dispatch.id}:primary`
      || childSpec.idempotencyKey !== `${parent.idempotency_key}:child:${childSpec.slotKey}`
      || childSpec.observationHash !== provenance.observationHash || stable(childSpec.provenance) !== stable(provenance)
      || !childSpec.authoritySnapshot || childSpec.authoritySnapshot.grantId !== grantId) return null;

    const [subscription, principal, connection, parentTask, primaryEvidence, grant, source, target, signer, policyRows] = await Promise.all([
      get(`SELECT * FROM event_subscriptions WHERE org_id=? AND id=? AND enabled=1 AND employee_id=? AND principal_id=?
        AND connection_id=? AND event_type='orders/paid' AND required_capability=? AND authorized_by=?`,
      orgId, dispatch.subscription_id, parent.employee_id, dispatch.service_principal_id, provenance.connectionId, SOURCE_CAPABILITY, dispatch.manager_grant_user_id),
      get("SELECT id FROM service_principals WHERE org_id=? AND id=? AND kind='org_service' AND status='active'", orgId, dispatch.service_principal_id),
      get("SELECT id,environment,status,config,revoked_at,credential_expires_at FROM provider_connections WHERE org_id=? AND id=? AND provider='shopify'", orgId, provenance.connectionId),
      get('SELECT * FROM crew_tasks WHERE org_id=? AND workflow_id=?', orgId, parent.id),
      get("SELECT id FROM event_workflow_evidence WHERE org_id=? AND dispatch_id=? AND workflow_id=? AND execution_generation=? AND role='primary'", orgId, dispatch.id, parent.id, parent.execution_generation),
      get(`SELECT * FROM employee_delegation_grants WHERE org_id=? AND id=? AND grant_scope='event' AND state='active'
        AND source_employee_id=? AND target_employee_id=? AND capability=? AND delegated_capability=?
        AND subscription_id=? AND principal_id=? AND connection_id=? AND environment='simulation'
        AND manager_signer_user_id=?`, orgId, grantId, parent.employee_id, candidateEmployeeId, SOURCE_CAPABILITY, SUPPORT_CAPABILITY,
      dispatch.subscription_id, dispatch.service_principal_id, provenance.connectionId, dispatch.manager_grant_user_id),
      get(`SELECT e.id,e.state,(SELECT c.id FROM coworkers c WHERE c.org_id=e.org_id AND c.employee_id=e.id ORDER BY c.updated_at DESC LIMIT 1) AS profile_id,es.version AS spec_version,es.data AS spec_data,d.id AS deployment_id,d.spec_version AS deployment_spec_version
        FROM employees e JOIN employee_specs es ON es.employee_id=e.id AND es.version=(SELECT MAX(v.version) FROM employee_specs v WHERE v.employee_id=e.id)
        JOIN employee_deployments d ON d.org_id=e.org_id AND d.employee_id=e.id AND d.spec_version=es.version
        WHERE e.org_id=? AND e.id=?`, orgId, parent.employee_id),
      get(`SELECT e.id,e.state,(SELECT c.id FROM coworkers c WHERE c.org_id=e.org_id AND c.employee_id=e.id ORDER BY c.updated_at DESC LIMIT 1) AS profile_id,es.version AS spec_version,es.data AS spec_data,d.id AS deployment_id,d.spec_version AS deployment_spec_version
        FROM employees e JOIN employee_specs es ON es.employee_id=e.id AND es.version=(SELECT MAX(v.version) FROM employee_specs v WHERE v.employee_id=e.id)
        JOIN employee_deployments d ON d.org_id=e.org_id AND d.employee_id=e.id AND d.spec_version=es.version
        WHERE e.org_id=? AND e.id=?`, orgId, candidateEmployeeId),
      get('SELECT role FROM memberships WHERE org_id=? AND user_id=?', orgId, dispatch.manager_grant_user_id),
      all('SELECT id,tool,effect,condition,active FROM policies WHERE org_id=? ORDER BY id', orgId),
    ]);
    const authorizer = grant && await get('SELECT role FROM memberships WHERE org_id=? AND user_id=?', orgId, grant.authorized_by_user_id);
    if (!subscription || !principal || !connection || !parentTask || !primaryEvidence || !grant || !source || !target
      || !privileged.has(String(signer?.role ?? '').toLowerCase()) || !privileged.has(String(authorizer?.role ?? '').toLowerCase())
      || connection.environment !== 'simulation' || connection.status !== 'connected' || connection.revoked_at
      || (connection.credential_expires_at && Date.parse(connection.credential_expires_at) <= Date.parse(now))
      || parentTask.id !== parent.id || parentTask.state !== 'waiting_dependency' || parentTask.owner_employee_id !== parent.employee_id
      || parentTask.capability !== SOURCE_CAPABILITY || parentTask.workflow_id !== parent.id
      || source.state !== 'active' || target.state !== 'active' || !target.profile_id
      || !scopeAllowsCoworker(parse(source.spec_data, {}), target.profile_id)
      || !capabilities(parse(source.spec_data, {})).includes(SOURCE_CAPABILITY)
      || !capabilities(parse(target.spec_data, {})).includes(SUPPORT_CAPABILITY)) return null;
    const connectionConfig = parse(connection.config, {});
    if (connectionConfig.fixture !== true || connectionConfig.identityVerified !== true || connectionConfig.effectsEnabled === true) return null;
    const policyVersion = createHash('sha256').update(JSON.stringify(policyRows)).digest('hex');
    const sourceSpecVersion = String(source.spec_version);
    const targetSpecVersion = String(target.spec_version);
    if (grant.source_spec_revision !== sourceSpecVersion || grant.source_deployment_revision !== source.deployment_id
      || grant.target_spec_revision !== targetSpecVersion || grant.target_deployment_revision !== target.deployment_id
      || childSpec.authoritySnapshot.capabilityVersion !== targetSpecVersion
      || childSpec.authoritySnapshot.deploymentId !== target.deployment_id
      || childSpec.authoritySnapshot.policyVersion !== policyVersion) return null;
    // The current child action is a local simulated observation only. Active
    // deployment, exact profile/grant bindings and policy revision above are
    // sufficient for this MVP; no provider write capability is involved.
    return { binding, provenance, subscription, principal, connection, parentTask, primaryEvidence, grant, source, target, policyVersion };
  }

  async function getWorkflow(orgId, workflowId) {
    return get(`SELECT * FROM workflows WHERE org_id=? AND id=?`, orgId, workflowId);
  }

  async function getChildTask(orgId, taskId) {
    return get(`SELECT * FROM crew_tasks WHERE org_id=? AND id=?`, orgId, taskId);
  }

  async function isEmployeeBusy(orgId, employeeId, now, excludingTaskId = null) {
    const lock = await get(`SELECT workflow_id FROM employee_execution_locks WHERE org_id=? AND employee_id=? AND lease_expires_at>?
      AND task_id<>COALESCE(?, '') LIMIT 1`, orgId, employeeId, now, excludingTaskId);
    if (lock) return true;
    const stateMarks = BUSY_TASK_STATES.map(() => '?').join(',');
    const active = await get(`SELECT id FROM crew_tasks WHERE org_id=? AND owner_employee_id=? AND state IN (${stateMarks})
      AND id<>COALESCE(?, '') LIMIT 1`, orgId, employeeId, ...BUSY_TASK_STATES, excludingTaskId);
    return Boolean(active);
  }

  async function insertChildWorkflow({ orgId, dispatch, parent, slotKey, childSpec, task, childTaskId, existingTask, now }) {
    const existingWorkflow = await get('SELECT * FROM workflows WHERE org_id=? AND idempotency_key=?', orgId, childSpec.idempotencyKey);
    let workflowId = existingWorkflow?.id;
    const authoritySnapshot = childSpec.authoritySnapshot;
    const origin = {
      type: 'event_response', version: 1, dispatchId: dispatch.id, role: 'child', connectionId: childSpec.connectionId,
      subscriptionId: childSpec.subscriptionId, servicePrincipalId: childSpec.servicePrincipalId,
      managerUserId: childSpec.createdBy, parentWorkflowId: parent.id, slotKey, request: childSpec.request,
      authoritySnapshot, provenance: childSpec.provenance, observation: childSpec.observation, observationHash: childSpec.observationHash,
    };
    if (existingWorkflow) {
      const oldOrigin = parse(existingWorkflow.origin, {});
      if (existingWorkflow.execution_role !== 'child' || existingWorkflow.runtime_version !== LOCAL_RUNTIME
        || existingWorkflow.employee_id !== childSpec.employeeId || existingWorkflow.created_by !== childSpec.createdBy
        || existingWorkflow.created_by_principal_id !== childSpec.servicePrincipalId
        || existingWorkflow.origin_subscription_id !== childSpec.subscriptionId || existingWorkflow.goal !== childSpec.goal
        || existingWorkflow.idempotency_key !== childSpec.idempotencyKey
        || Number(existingWorkflow.execution_generation) < 1
        || stable(parse(existingWorkflow.provenance_json, {})) !== stable(childSpec.provenance)
        || stable(oldOrigin.authoritySnapshot) !== stable(authoritySnapshot)
        || oldOrigin.parentWorkflowId !== parent.id || oldOrigin.slotKey !== slotKey
        || stable(oldOrigin.request) !== stable(childSpec.request)) return null;
      if (existingTask?.workflow_id && existingTask.workflow_id !== workflowId) return null;
      if (!existingTask) return null;
      if (!existingTask.workflow_id) {
        const link = await run(`UPDATE crew_tasks SET workflow_id=?,state='queued',updated_at=? WHERE org_id=? AND id=?
          AND workflow_id IS NULL AND state='waiting_dependency' AND owner_employee_id=? AND idempotency_key=?`,
        workflowId, now, orgId, childTaskId, childSpec.employeeId, childSpec.idempotencyKey);
        if (!changed(link)) return null;
      }
      return { workflowId, executionGeneration: Number(existingWorkflow.execution_generation), created: false };
    }

    workflowId = newId('workflow');
    const workflowInsert = await run(`INSERT INTO workflows(id,org_id,employee_id,created_by,goal,status,runtime_version,plan,created_at,updated_at,
      spec_version,deployment_id,idempotency_key,origin,created_by_principal_id,origin_subscription_id,lease_generation,
      execution_generation,execution_role,provenance_json,continuation_json)
      VALUES(?,?,?,?,?,'queued',?,'[]',?,?,?,?,?,?,?,?,0,1,'child',?,'{}') ON CONFLICT DO NOTHING`,
    workflowId, orgId, childSpec.employeeId, childSpec.createdBy, childSpec.goal, LOCAL_RUNTIME, now, now,
    Number(authoritySnapshot.capabilityVersion), authoritySnapshot.deploymentId, childSpec.idempotencyKey, JSON.stringify(origin),
    childSpec.servicePrincipalId, childSpec.subscriptionId, JSON.stringify(childSpec.provenance));
    if (!changed(workflowInsert)) {
      const winner = await get('SELECT * FROM workflows WHERE org_id=? AND idempotency_key=?', orgId, childSpec.idempotencyKey);
      const winnerTask = existingTask ?? await get('SELECT * FROM crew_tasks WHERE org_id=? AND idempotency_key=?', orgId, childSpec.idempotencyKey);
      return winner ? insertChildWorkflow({ orgId, dispatch, parent, slotKey, childSpec, task, childTaskId: winnerTask?.id ?? childTaskId, existingTask: winnerTask, now }) : null;
    }
    if (existingTask) {
      if (existingTask.workflow_id) return null;
      const link = await run(`UPDATE crew_tasks SET workflow_id=?,state='queued',updated_at=? WHERE org_id=? AND id=?
        AND workflow_id IS NULL AND state='waiting_dependency' AND owner_employee_id=? AND idempotency_key=?`,
      workflowId, now, orgId, childTaskId, childSpec.employeeId, childSpec.idempotencyKey);
      if (!changed(link)) return null;
    } else {
      const taskId = childTaskId;
      const taskInsert = await run(`INSERT INTO crew_tasks(id,org_id,workflow_id,parent_task_id,owner_employee_id,capability,goal,input_refs,success_criteria,
        state,priority,idempotency_key,correlation_id,spec_version,runtime_version,lease_generation,attempts,deadline_at,queue_owner,event_inbox_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'queued',80,?,?,?,? ,0,0,?,'event_response_v1',?,?,?) ON CONFLICT DO NOTHING`,
      taskId, orgId, workflowId, parent.id, childSpec.employeeId, task.capability, childSpec.goal,
      JSON.stringify([{ type: 'delegation_request', requestHash: hash(childSpec.request), request: childSpec.request },
        { type: 'primary_evidence', workflowId: parent.id }]),
      JSON.stringify(['independently verified child result']), childSpec.idempotencyKey, dispatch.id,
      Number(authoritySnapshot.capabilityVersion), LOCAL_RUNTIME, dispatch.dispatch_deadline_at ?? dispatch.recovery_deadline_at ?? null,
      dispatch.inbox_id, now, now);
      if (!changed(taskInsert)) return null;
    }
    const workflow = await getWorkflow(orgId, workflowId);
    const savedTask = await getChildTask(orgId, childTaskId);
    if (!workflow || !savedTask || savedTask.workflow_id !== workflowId || workflow.execution_role !== 'child'
      || Number(workflow.execution_generation) !== 1 || savedTask.owner_employee_id !== childSpec.employeeId
      || savedTask.parent_task_id !== parent.id || savedTask.capability !== SUPPORT_CAPABILITY) return null;
    return { workflowId, executionGeneration: 1, created: true };
  }

  async function ensureChildFenced(args) {
    const { orgId, dispatchId, lease, parentWorkflow, parentExecutionGeneration, slotKey, existingSlot,
      expectedSlotGeneration, requestHash, candidateEmployeeId, grantId, childSpec, task, plan, limits, now } = args;
    if (!orgId || !dispatchId || !lease || !slotKey || !requestHash || !candidateEmployeeId || !grantId || !childSpec || !now) return { updated: false };
    try {
      return await transaction(async () => {
        if (!await lockOrganization(orgId)) return { updated: false };
        const employeeIds = [parentWorkflow?.employeeId, candidateEmployeeId].filter(Boolean).sort();
        for (const employeeId of employeeIds) if (!await lockEmployee(orgId, employeeId)) return { updated: false };
        const dispatch = await activeDispatch({ orgId, dispatchId, lease, now });
        if (!dispatch) return { updated: false };
        const parent = await getWorkflow(orgId, parentWorkflow?.id);
        if (!parent || parent.id !== dispatch.primary_workflow_id || parentWorkflow?.id !== parent.id
          || Number(parent.execution_generation) !== Number(parentExecutionGeneration)
          || Number(parent.execution_generation) !== Number(parentWorkflow.executionGeneration)) return { updated: false };
        const authority = await currentAuthority({ orgId, dispatch, parent, candidateEmployeeId, grantId,
          childSpec: { ...childSpec, parentExecutionGeneration }, now });
        if (!authority) return { updated: false };
        if (!plan || plan.allowed !== true || plan.cycle === true || plan.widthExceeded === true || plan.depthExceeded === true
          || plan.budgetExceeded === true || plan.sameEmployeeConcurrent === true) return { updated: false };
        const refreshedPlan = await planDelegation({ orgId, parentWorkflowId: parent.id, parentEmployeeId: parent.employee_id,
          childEmployeeId: candidateEmployeeId, taskGraph: parentWorkflow?.taskGraph ?? null, limits: limits ?? {} });
        if (!refreshedPlan || refreshedPlan.allowed !== true || refreshedPlan.cycle === true || refreshedPlan.widthExceeded === true
          || refreshedPlan.depthExceeded === true || refreshedPlan.budgetExceeded === true || refreshedPlan.sameEmployeeConcurrent === true) return { updated: false };
        const existing = await getSlot({ orgId, dispatchId, slotKey });
        if (existing) {
          if (!existingSlot || existing.id !== existingSlot.id || existing.generation !== Number(expectedSlotGeneration)
            || existing.slotKey !== slotKey || existing.requestHash !== requestHash || stable(existing.request) !== stable(childSpec.request)
            || existing.employeeId !== candidateEmployeeId || existing.grantId !== grantId || existing.state !== 'waiting') return { updated: false };
        } else if (existingSlot || expectedSlotGeneration !== null && expectedSlotGeneration !== undefined) return { updated: false };
        if (existing?.childWorkflowId) {
          const child = await getWorkflow(orgId, existing.childWorkflowId);
          const childTask = await getChildTask(orgId, existing.childTaskId);
          if (!child || !childTask || child.employee_id !== candidateEmployeeId || child.execution_role !== 'child'
            || Number(child.execution_generation) !== existing.childExecutionGeneration || child.idempotency_key !== childSpec.idempotencyKey
            || childTask.workflow_id !== child.id || childTask.state === 'failed') return { updated: false };
          return { updated: true, slot: existing, workflow: child, replay: true };
        }

        const activeCount = await get(`SELECT COUNT(*) AS count FROM task_delegations WHERE org_id=? AND dispatch_id=? AND legacy=0
          AND state IN ('waiting','resolved')`, orgId, dispatchId);
        if (!existing && Number(activeCount?.count ?? 0) >= 3) return { updated: false };
        const busy = await isEmployeeBusy(orgId, candidateEmployeeId, now, existing?.childTaskId ?? null);
        let childTaskId = existing?.childTaskId ?? newId('task');
        let slotId = existing?.id;
        if (!slotId) {
          // The task row must exist before its delegation FK can be inserted. A busy
          // collaborator gets a durable, non-runnable reservation task in the same
          // transaction; a later recovery pass attaches its workflow without reassigning.
          const taskState = 'waiting_dependency';
          const taskInsert = await run(`INSERT INTO crew_tasks(id,org_id,workflow_id,parent_task_id,owner_employee_id,capability,goal,input_refs,success_criteria,
            state,priority,idempotency_key,correlation_id,spec_version,runtime_version,lease_generation,attempts,deadline_at,queue_owner,event_inbox_id,created_at,updated_at)
            VALUES(?,?,NULL,?,?,?,?,?,?,?,80,?,?,?,?,0,0,?,'event_response_v1',?,?,?) ON CONFLICT DO NOTHING`,
          childTaskId, orgId, parent.id, candidateEmployeeId, SUPPORT_CAPABILITY,
          childSpec.goal, JSON.stringify([{ type: 'delegation_request', requestHash, request: childSpec.request }, { type: 'primary_evidence', workflowId: parent.id }]),
          JSON.stringify(['independently verified child result']), taskState, childSpec.idempotencyKey, dispatch.id,
          Number(childSpec.authoritySnapshot.capabilityVersion), LOCAL_RUNTIME,
          dispatch.dispatch_deadline_at ?? dispatch.recovery_deadline_at ?? null, dispatch.inbox_id, now, now);
          if (!changed(taskInsert)) return { updated: false };
          slotId = newId('delegation');
          const slotInsert = await run(`INSERT INTO task_delegations(id,org_id,parent_task_id,child_task_id,delegation_slot,request_hash,state,evidence_json,resolution_json,
            dispatch_id,created_at,updated_at,dispatch_slot_key,slot_generation,parent_workflow_id,grant_id,child_workflow_id,child_execution_generation,request_json,legacy)
            VALUES(?,?,?,?,? ,?,'waiting','[]','{}',?,?,?,?,1,?,?,NULL,NULL,?,0) ON CONFLICT DO NOTHING`,
          slotId, orgId, parent.id, childTaskId, slotKey, requestHash, dispatchId, now, now, slotKey, parent.id, grantId, JSON.stringify(childSpec.request));
          if (!changed(slotInsert)) return { updated: false };
        } else {
          const taskRow = await getChildTask(orgId, childTaskId);
          if (!taskRow || taskRow.workflow_id || taskRow.state !== 'waiting_dependency' || taskRow.owner_employee_id !== candidateEmployeeId
            || taskRow.idempotency_key !== childSpec.idempotencyKey || taskRow.capability !== SUPPORT_CAPABILITY) return { updated: false };
        }
        await run('DELETE FROM employee_execution_locks WHERE org_id=? AND workflow_id=? AND task_id=?', orgId, parent.id, parent.id);
        if (busy) return { updated: true, state: 'busy', slot: await getSlot({ orgId, dispatchId, slotKey }) };

        const child = await insertChildWorkflow({ orgId, dispatch, parent, slotKey, childSpec, task, childTaskId,
          existingTask: await getChildTask(orgId, childTaskId), now });
        if (!child) return { updated: false };
        const bind = await run(`UPDATE task_delegations SET child_workflow_id=?,child_execution_generation=?,updated_at=?
          WHERE org_id=? AND id=? AND dispatch_id=? AND dispatch_slot_key=? AND state='waiting' AND legacy=0
            AND slot_generation=? AND child_workflow_id IS NULL AND grant_id=?`,
        child.workflowId, child.executionGeneration, now, orgId, slotId, dispatchId, slotKey, existing?.generation ?? 1, grantId);
        if (!changed(bind)) return { updated: false };
        const currentParent = await getWorkflow(orgId, parent.id);
        if (currentParent.status !== 'waiting_dependency' || Number(currentParent.execution_generation) !== Number(parentExecutionGeneration)) return { updated: false };
        const slot = await getSlot({ orgId, dispatchId, slotKey });
        const workflow = await getWorkflow(orgId, child.workflowId);
        if (!slot || !workflow) return { updated: false };
        return { updated: true, slot, workflow, replay: !child.created };
      });
    } catch (error) {
      // Unique slot/idempotency races are safe to retry from the durable row;
      // other SQL failures must remain visible to the caller.
      if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE' || error?.code === '23505') {
        const winner = await getSlot({ orgId, dispatchId, slotKey });
        if (winner && winner.requestHash === requestHash && winner.employeeId === candidateEmployeeId && winner.grantId === grantId) {
          return { updated: true, state: winner.childWorkflowId ? undefined : 'busy', slot: winner,
            ...(winner.childWorkflowId ? { workflow: await getWorkflow(orgId, winner.childWorkflowId) } : {}) };
        }
        return { updated: false };
      }
      throw error;
    }
  }

  async function resolveFenced(args) {
    const { orgId, dispatchId, lease, slotId, expectedSlotGeneration, childWorkflowId,
      childExecutionGeneration, evidenceRefs, now } = args;
    if (!orgId || !dispatchId || !slotId || !Array.isArray(evidenceRefs) || !evidenceRefs.length || !now) return { updated: false };
    try {
      return await transaction(async () => {
        const dispatch = await activeDispatch({ orgId, dispatchId, lease, now });
        if (!dispatch) return { updated: false };
        const slotRow = await get(`SELECT * FROM task_delegations WHERE org_id=? AND id=? AND dispatch_id=? AND state='waiting'
          AND legacy=0 AND slot_generation=? AND child_workflow_id=? AND child_execution_generation=?`,
        orgId, slotId, dispatchId, expectedSlotGeneration, childWorkflowId, childExecutionGeneration);
        if (!slotRow || slotRow.parent_workflow_id !== dispatch.primary_workflow_id) return { updated: false };
        const parent = await get('SELECT * FROM workflows WHERE org_id=? AND id=? AND execution_role=? AND status=?', orgId, slotRow.parent_workflow_id, 'primary', 'waiting_dependency');
        const child = await get(`SELECT * FROM workflows WHERE org_id=? AND id=? AND execution_role='child' AND status='completed'
          AND execution_generation=? AND runtime_version=?`, orgId, childWorkflowId, childExecutionGeneration, LOCAL_RUNTIME);
        const childTask = await get(`SELECT * FROM crew_tasks WHERE org_id=? AND id=? AND workflow_id=? AND owner_employee_id=?
          AND capability=? AND state='completed'`, orgId, slotRow.child_task_id, childWorkflowId, child?.employee_id, SUPPORT_CAPABILITY);
        const evidence = await get(`SELECT * FROM event_workflow_evidence WHERE org_id=? AND dispatch_id=? AND workflow_id=?
          AND execution_generation=? AND role='child'`, orgId, dispatchId, childWorkflowId, childExecutionGeneration);
        if (!parent || Number(parent.execution_generation) < 1 || !child || !childTask || !evidence
          || evidence.connection_id !== parse(parent.provenance_json, {}).connectionId
          || evidence.source_event_id !== parse(parent.provenance_json, {}).eventId
          || evidence.event_version !== parse(parent.provenance_json, {}).eventVersion
          || evidence.observation_hash !== parse(parent.provenance_json, {}).observationHash) return { updated: false };
        const parentProvenance = parse(parent.provenance_json, {});
        const childProvenance = parse(child.provenance_json, {});
        const childOrigin = parse(child.origin, {});
        const childAuthoritySnapshot = childOrigin.authoritySnapshot;
        const childSpec = {
          orgId, role: 'child', employeeId: child.employee_id, createdBy: child.created_by,
          servicePrincipalId: child.created_by_principal_id, subscriptionId: child.origin_subscription_id,
          connectionId: parentProvenance.connectionId, capability: childTask.capability, goal: child.goal,
          runtimeVersion: child.runtime_version, idempotencyKey: child.idempotency_key,
          provenance: childProvenance, observation: childOrigin.observation, observationHash: childProvenance.observationHash,
          authoritySnapshot: childAuthoritySnapshot, parentWorkflowId: parent.id, slotKey: slotRow.dispatch_slot_key,
          request: parse(slotRow.request_json, null), parentExecutionGeneration: Number(parent.execution_generation),
        };
        if (stable(childProvenance) !== stable(parentProvenance) || childAuthoritySnapshot?.grantId !== slotRow.grant_id
          || stable(childSpec.request) !== stable(parse(slotRow.request_json, null))
          || hash(childSpec.request) !== slotRow.request_hash || child.idempotency_key !== `${parent.idempotency_key}:child:${slotRow.dispatch_slot_key}`) return { updated: false };
        const current = await currentAuthority({ orgId, dispatch, parent, candidateEmployeeId: child.employee_id,
          grantId: slotRow.grant_id, childSpec, now });
        if (!current) return { updated: false };
        const storedRefs = parse(evidence.evidence_refs_json, []).map((ref) => typeof ref === 'string' ? ref : ref?.toolRunId).filter(Boolean).sort();
        const requestedRefs = evidenceRefs.map((ref) => typeof ref === 'string' ? ref : ref?.toolRunId).filter(Boolean).sort();
        if (!requestedRefs.length || stable(storedRefs) !== stable(requestedRefs)) return { updated: false };
        const evidenceBindings = parse(evidence.bindings_json, {});
        if (!evidence.verifier_id || evidenceBindings.orgId !== orgId || evidenceBindings.connectionId !== current.provenance.connectionId
          || evidenceBindings.eventVersion !== current.provenance.eventVersion || evidenceBindings.workflowId !== childWorkflowId
          || Number(evidenceBindings.executionGeneration) !== Number(childExecutionGeneration)
          || evidenceBindings.observationHash !== current.provenance.observationHash
          || evidenceBindings.verifierId !== evidence.verifier_id || !evidence.step_input_hash
          || evidenceBindings.stepInputHash !== evidence.step_input_hash) return { updated: false };
        for (const toolRunId of requestedRefs) {
          const verifiedRun = await get(`SELECT tr.id FROM event_workflow_evidence_runs er
            JOIN tool_runs tr ON tr.org_id=er.org_id AND tr.id=er.tool_run_id
            WHERE er.org_id=? AND er.evidence_id=? AND er.tool_run_id=? AND tr.workflow_id=?
              AND tr.status='completed' AND tr.tool='shopify.order.read_simulated' AND tr.lease_generation=?`,
          orgId, evidence.id, toolRunId, childWorkflowId, childExecutionGeneration);
          if (!verifiedRun) return { updated: false };
        }
        const resultJson = JSON.stringify({ childWorkflowId, childExecutionGeneration, evidenceId: evidence.id, evidenceRefs: requestedRefs });
        const slotUpdate = await run(`UPDATE task_delegations SET state='resolved',evidence_json=?,resolution_json=?,slot_generation=slot_generation+1,
          resolved_at=?,updated_at=? WHERE org_id=? AND id=? AND dispatch_id=? AND state='waiting' AND legacy=0
          AND slot_generation=? AND child_workflow_id=? AND child_execution_generation=? AND grant_id=?`,
        JSON.stringify(requestedRefs), resultJson, now, now, orgId, slotId, dispatchId, expectedSlotGeneration,
        childWorkflowId, childExecutionGeneration, slotRow.grant_id);
        if (!changed(slotUpdate)) return { updated: false };
        // Parent remains in waiting_dependency until the workflow adapter performs
        // the separately fenced resume. The resolved edge is durable, so a crash
        // between these writes is recovered by replaying this exact slot.
        return { updated: true, slot: await getSlot({ orgId, dispatchId, slotKey: slotRow.dispatch_slot_key }) };
      });
    } catch (error) {
      if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE' || error?.code === '23505') return { updated: false };
      throw error;
    }
  }

  return Object.freeze({ getSlot, planDelegation, ensureChildFenced, resolveFenced });
}
