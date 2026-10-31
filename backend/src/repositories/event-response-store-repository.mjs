import { createHash } from 'node:crypto';
import { normalizeShopifyOrderEvent } from '../integrations/shopify-events.mjs';
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
const FENCE_LOST = Symbol('event-response-fence-lost');
const PRIVILEGED = new Set(['owner', 'admin', 'manager']);

function paidObservation(row, { orgId, connectionId, eventVersion, expectedObservation } = {}) {
  if (!row || row.org_id !== orgId || row.connection_id !== connectionId || row.external_event_id !== eventVersion
    || row.provider !== 'shopify' || row.event_type !== 'orders/paid' || row.environment !== 'simulation' || Number(row.simulated) !== 1) return null;
  const raw = parse(row.normalized);
  const projection = raw?._projection;
  if (!projection || projection.paidVerified !== true || projection.simulated !== true || !projection.orderId) return null;
  let normalized;
  try { normalized = normalizeShopifyOrderEvent(row.event_type, raw, 'simulation'); } catch { return null; }
  if (!normalized || normalized.paymentState !== 'paid') return null;
  const observation = { ...normalized, orderId: projection.orderId, paidVerified: true, simulated: true };
  if (expectedObservation && stable(observation) !== stable(expectedObservation)) return null;
  return observation;
}

/** Org-scoped SQL store for the durable event-response coordinator. */
export function createEventResponseStoreRepository({ all, get, run, transaction, newId, verifyEvidence } = {}) {
  if (![all, get, run, transaction, newId].every((fn) => typeof fn === 'function')) {
    throw new TypeError('Event response store requires all, get, run, transaction, and newId.');
  }

  async function rawDispatch(orgId, dispatchId) {
    return get(`SELECT r.*,i.provider,i.external_event_id,i.event_type,i.environment AS inbox_environment,i.simulated,i.normalized,i.connection_id,
        s.employee_id,s.required_capability,s.principal_id,s.authorized_by,s.enabled,s.event_type AS subscription_event_type,
        p.kind AS principal_kind,p.status AS principal_status,pc.environment AS connection_environment,pc.status AS connection_status,
        pc.config AS connection_config,pc.granted_scopes,pc.revoked_at,pc.credential_expires_at,
        e.state AS employee_state,es.version AS spec_version,es.data AS spec_data,d.id AS deployment_id,d.policy_revision AS deployment_policy_revision
      FROM event_dispatch_records r
      JOIN event_inbox i ON i.org_id=r.org_id AND i.id=r.inbox_id
      JOIN event_subscriptions s ON s.org_id=r.org_id AND s.id=r.subscription_id
      JOIN service_principals p ON p.org_id=s.org_id AND p.id=s.principal_id
      JOIN provider_connections pc ON pc.org_id=s.org_id AND pc.id=s.connection_id
      JOIN employees e ON e.org_id=s.org_id AND e.id=s.employee_id
      LEFT JOIN employee_specs es ON es.employee_id=e.id AND es.version=(SELECT MAX(es2.version) FROM employee_specs es2 WHERE es2.employee_id=e.id)
      LEFT JOIN employee_deployments d ON d.org_id=e.org_id AND d.employee_id=e.id AND d.spec_version=es.version
      WHERE r.org_id=? AND r.id=?`, orgId, dispatchId);
  }

  async function getDispatch({ orgId, dispatchId }) {
    const row = await rawDispatch(orgId, dispatchId);
    if (!row) return undefined;
    const acceptedBinding = parse(row.outcome_json, {})?.acceptedBinding ?? null;
    return {
      id: row.id, orgId: row.org_id, inboxId: row.inbox_id, subscriptionId: row.subscription_id,
      principalId: row.service_principal_id, managerUserId: row.manager_grant_user_id,
      employeeId: row.employee_id, connectionId: row.connection_id,
      provider: row.provider, topic: row.event_type, eventId: row.external_event_id,
      eventVersion: row.external_event_id, environment: row.inbox_environment,
      simulated: Number(row.simulated) === 1, requiredCapability: row.required_capability,
      state: row.state, owner: row.worker_owner, generation: Number(row.lease_generation),
      leaseExpiresAt: row.lease_expires_at, deadlineAt: row.dispatch_deadline_at ?? row.recovery_deadline_at ?? null,
      primaryWorkflowId: row.primary_workflow_id ?? null, taskId: row.task_id ?? null,
      attempts: Number(row.attempts ?? 0), acceptedBinding,
    };
  }

  async function getInbox({ orgId, inboxId }) {
    const row = await get('SELECT * FROM event_inbox WHERE org_id=? AND id=?', orgId, inboxId);
    if (!row) return undefined;
    const normalized = parse(row.normalized, {});
    return {
      id: row.id, orgId: row.org_id, provider: row.provider, connectionId: row.connection_id,
      eventId: row.external_event_id, topic: row.event_type, eventType: row.event_type,
      environment: row.environment, simulated: Number(row.simulated) === 1,
      occurredAt: row.occurred_at, receivedAt: row.received_at, normalized,
      state: row.state, leaseGeneration: Number(row.lease_generation ?? 0),
    };
  }

  async function getWorkflow({ orgId, workflowId, idempotencyKey }) {
    const row = workflowId
      ? await get('SELECT * FROM workflows WHERE org_id=? AND id=?', orgId, workflowId)
      : idempotencyKey ? await get('SELECT * FROM workflows WHERE org_id=? AND idempotency_key=?', orgId, idempotencyKey) : undefined;
    if (!row) return undefined;
    const provenance = parse(row.provenance_json, {});
    const origin = parse(row.origin, {});
    const evidence = await get(`SELECT * FROM event_workflow_evidence WHERE org_id=? AND workflow_id=? AND execution_generation=?`, orgId, row.id, Number(row.execution_generation ?? 0));
    const savedOutput = parse(evidence?.result_json, {});
    const refs = parse(evidence?.evidence_refs_json, []);
    const task = await get('SELECT * FROM crew_tasks WHERE org_id=? AND workflow_id=?', orgId, row.id);
    return {
      id: row.id, orgId: row.org_id, employeeId: row.employee_id, createdBy: row.created_by,
      goal: row.goal, status: row.status, runtimeVersion: row.runtime_version,
      plan: parse(row.plan, []), result: parse(row.result, savedOutput?.result ?? null),
      error: row.error, executionGeneration: Number(row.execution_generation ?? 0),
      role: row.execution_role ?? 'legacy', capability: task?.capability ?? null, idempotencyKey: row.idempotency_key,
      servicePrincipalId: row.created_by_principal_id ?? null, subscriptionId: row.origin_subscription_id ?? null,
      connectionId: provenance.connectionId ?? origin.connectionId ?? null,
      observationHash: provenance.observationHash ?? null,
      provenance, authoritySnapshot: origin.authoritySnapshot ?? null,
      parentWorkflowId: origin.parentWorkflowId ?? null, delegationSlotKey: origin.slotKey ?? null,
      request: origin.request ?? null,
      output: savedOutput && Object.keys(savedOutput).length ? savedOutput : null,
      steps: savedOutput?.steps ?? [], evidenceRefs: refs,
      toolRunRefs: refs.map((ref) => typeof ref === 'string' ? ref : ref?.toolRunId).filter(Boolean),
      continuation: parse(row.continuation_json, savedOutput?.continuation ?? null),
      taskGraph: task ? { taskId: task.id, state: task.state, inputRefs: parse(task.input_refs, []), successCriteria: parse(task.success_criteria, []) } : null,
      deploymentId: row.deployment_id ?? null, specVersion: Number(row.spec_version ?? 0),
      workerId: row.worker_id ?? null, leaseExpiresAt: row.lease_expires_at ?? null,
    };
  }

  async function getPaidOrderSnapshot({ orgId, connectionId, observation, eventVersion }) {
    const inbox = await get('SELECT * FROM event_inbox WHERE org_id=? AND connection_id=? AND external_event_id=?', orgId, connectionId, eventVersion);
    const verified = paidObservation(inbox, { orgId, connectionId, eventVersion, expectedObservation: observation });
    if (!verified) return undefined;
    const receipt = await get('SELECT order_id FROM order_event_receipts WHERE connection_id=? AND external_event_id=?', connectionId, eventVersion);
    const order = receipt && await get(`SELECT id,org_id,connection_id,remote_order_id,environment,simulated FROM canonical_orders
      WHERE org_id=? AND connection_id=? AND id=?`, orgId, connectionId, receipt.order_id);
    if (!order || order.id !== verified.orderId || order.remote_order_id !== verified.remoteOrderId
      || order.environment !== 'simulation' || Number(order.simulated) !== 1) return undefined;
    return {
      orgId, connectionId, eventVersion, orderId: order.id, remoteOrderId: order.remote_order_id,
      environment: 'simulation', simulated: true, paymentState: 'paid', observationHash: hash(verified), observation: verified,
    };
  }

  async function assertDispatchLease({ orgId, dispatchId, lease, now }) {
    if (!lease?.owner || !Number.isInteger(lease.generation) || !now) return { valid: false };
    const row = await get(`SELECT id FROM event_dispatch_records WHERE org_id=? AND id=? AND worker_owner=?
      AND lease_generation=? AND state IN ('checking','running') AND lease_expires_at>?`, orgId, dispatchId, lease.owner, lease.generation, now);
    return { valid: Boolean(row) };
  }

  async function validateCurrentPrimaryBinding(orgId, dispatch, lease, spec, now) {
    if (!organizationEngineV2Status(orgId).enabled || !dispatch || dispatch.worker_owner !== lease.owner
      || Number(dispatch.lease_generation) !== lease.generation || !['checking', 'running'].includes(dispatch.state)
      || !dispatch.lease_expires_at || Date.parse(dispatch.lease_expires_at) <= Date.parse(now)) return false;
    const accepted = parse(dispatch.outcome_json, {})?.acceptedBinding;
    const provenance = spec.provenance;
    if (!accepted || !provenance || accepted.orgId !== orgId || accepted.inboxId !== dispatch.inbox_id
      || accepted.subscriptionId !== dispatch.subscription_id || accepted.principalId !== dispatch.service_principal_id
      || accepted.managerUserId !== dispatch.manager_grant_user_id || accepted.employeeId !== spec.employeeId
      || accepted.connectionId !== provenance.connectionId || accepted.provider !== 'shopify'
      || accepted.eventType !== 'orders/paid' || accepted.environment !== 'simulation' || accepted.simulated !== 1
      || accepted.sourceVersion !== provenance.eventId || accepted.capability !== 'commerce.order.analyze'
      || provenance.kind !== 'shopify_paid_order_observation' || provenance.dispatchId !== dispatch.id
      || provenance.inboxId !== dispatch.inbox_id || provenance.eventId !== accepted.sourceVersion
      || provenance.subscriptionId !== dispatch.subscription_id || provenance.principalId !== dispatch.service_principal_id
      || provenance.managerUserId !== dispatch.manager_grant_user_id || provenance.connectionId !== accepted.connectionId
      || provenance.environment !== 'simulation' || provenance.topic !== 'orders/paid'
      || spec.role !== 'primary' || spec.runtimeVersion !== 'event-simulation-v1'
      || spec.idempotencyKey !== `event-dispatch:${dispatch.id}` || spec.capability !== 'commerce.order.analyze'
      || spec.createdBy !== dispatch.manager_grant_user_id || spec.servicePrincipalId !== dispatch.service_principal_id
      || spec.subscriptionId !== dispatch.subscription_id || spec.connectionId !== accepted.connectionId
      || spec.observationHash !== hash(spec.observation) || spec.observationHash !== provenance.observationHash
      || typeof spec.goal !== 'string' || !spec.goal.trim()) return false;
    const subscription = await get(`SELECT * FROM event_subscriptions WHERE org_id=? AND id=? AND enabled=1
      AND employee_id=? AND principal_id=? AND connection_id=? AND event_type='orders/paid'
      AND required_capability='commerce.order.analyze' AND authorized_by=?`, orgId, dispatch.subscription_id,
      spec.employeeId, dispatch.service_principal_id, provenance.connectionId, dispatch.manager_grant_user_id);
    const principal = await get("SELECT id FROM service_principals WHERE org_id=? AND id=? AND kind='org_service' AND status='active'", orgId, dispatch.service_principal_id);
    const connection = await get("SELECT id,config,environment,status,revoked_at,credential_expires_at FROM provider_connections WHERE org_id=? AND id=?", orgId, provenance.connectionId);
    const manager = await get('SELECT role FROM memberships WHERE org_id=? AND user_id=?', orgId, dispatch.manager_grant_user_id);
    const employee = await get(`SELECT e.state,es.version AS spec_version,es.data AS spec_data,d.id AS deployment_id
      FROM employees e
      JOIN employee_specs es ON es.employee_id=e.id AND es.version=(SELECT MAX(v.version) FROM employee_specs v WHERE v.employee_id=e.id)
      JOIN employee_deployments d ON d.org_id=e.org_id AND d.employee_id=e.id AND d.spec_version=es.version
      WHERE e.org_id=? AND e.id=?`, orgId, spec.employeeId);
    if (!subscription || !principal || !connection || !employee || employee.state !== 'active'
      || !PRIVILEGED.has(String(manager?.role ?? '').toLowerCase()) || connection.environment !== 'simulation'
      || connection.status !== 'connected' || connection.revoked_at
      || (connection.credential_expires_at && Date.parse(connection.credential_expires_at) <= Date.parse(now))) return false;
    const config = parse(connection.config, {});
    if (config.fixture !== true || config.identityVerified !== true || config.effectsEnabled === true) return false;
    const currentCapabilities = Array.isArray(parse(employee.spec_data, {})?.capabilities)
      ? parse(employee.spec_data, {}).capabilities.map((value) => typeof value === 'string' ? value : value?.key ?? value?.name) : [];
    if (Number(employee.spec_version) !== Number(spec.authoritySnapshot?.capabilityVersion)
      || employee.deployment_id !== spec.authoritySnapshot?.deploymentId || !currentCapabilities.includes('commerce.order.analyze')) return false;
    const policyRows = await all('SELECT id,tool,effect,condition,active FROM policies WHERE org_id=? ORDER BY id', orgId);
    const policyVersion = createHash('sha256').update(JSON.stringify(policyRows)).digest('hex');
    if (policyVersion !== spec.authoritySnapshot?.policyVersion) return false;
    // The event MVP only executes the local simulated order-read tool. Its
    // capability, deployment, manager grant and current policy are checked
    // above; provider-tool probation is reserved for future live adapters.
    return true;
  }

  async function ensurePrimaryFenced({ orgId, dispatchId, lease, spec, task, publication, now }) {
    try {
      return await transaction(async () => {
        const dispatch = await get('SELECT * FROM event_dispatch_records WHERE org_id=? AND id=?', orgId, dispatchId);
        if (!(await validateCurrentPrimaryBinding(orgId, dispatch, lease, spec, now))) return { updated: false };
        const existing = await get('SELECT * FROM workflows WHERE org_id=? AND idempotency_key=?', orgId, spec.idempotencyKey);
        if (existing) {
          const origin = parse(existing.origin, {});
          const provenance = parse(existing.provenance_json, {});
          const companion = await get('SELECT * FROM crew_tasks WHERE org_id=? AND workflow_id=?', orgId, existing.id);
          if (!companion || existing.execution_role !== 'primary' || Number(existing.execution_generation) < 1
            || existing.employee_id !== spec.employeeId || existing.created_by !== spec.createdBy
            || existing.created_by_principal_id !== spec.servicePrincipalId || existing.origin_subscription_id !== spec.subscriptionId
            || existing.goal !== spec.goal || existing.runtime_version !== spec.runtimeVersion
            || stable(provenance) !== stable(spec.provenance) || stable(origin.authoritySnapshot) !== stable(spec.authoritySnapshot)
            || companion.owner_employee_id !== spec.employeeId || companion.capability !== 'commerce.order.analyze'
            || companion.idempotency_key !== spec.idempotencyKey || Number(dispatch.primary_workflow_id && dispatch.primary_workflow_id !== existing.id)) return { updated: false };
          if (!dispatch.primary_workflow_id) {
            const published = await run(`UPDATE event_dispatch_records SET primary_workflow_id=?,task_id=?,state='running',updated_at=?
              WHERE org_id=? AND id=? AND worker_owner=? AND lease_generation=? AND state IN ('checking','running') AND lease_expires_at>? AND primary_workflow_id IS NULL`,
            existing.id, companion.id, now, orgId, dispatchId, lease.owner, lease.generation, now);
            if (!changed(published)) throw FENCE_LOST;
          }
          return { updated: true, workflow: await getWorkflow({ orgId, workflowId: existing.id }) };
        }
        if (dispatch.primary_workflow_id) return { updated: false };
        const workflowId = newId('workflow');
        const taskId = workflowId;
        const specVersion = Number(spec.authoritySnapshot.capabilityVersion);
        const origin = { type: 'event_response', version: 1, dispatchId, role: 'primary', connectionId: spec.connectionId,
          subscriptionId: spec.subscriptionId, servicePrincipalId: spec.servicePrincipalId, managerUserId: spec.createdBy,
          authoritySnapshot: spec.authoritySnapshot, provenance: spec.provenance, observation: spec.observation,
          observationHash: spec.observationHash };
        const inserted = await run(`INSERT INTO workflows(id,org_id,employee_id,created_by,goal,status,runtime_version,plan,created_at,updated_at,
          spec_version,deployment_id,idempotency_key,origin,created_by_principal_id,origin_subscription_id,lease_generation,
          execution_generation,execution_role,provenance_json,continuation_json)
          VALUES(?,?,?,?,?,'queued','event-simulation-v1','[]',?,?,?,?,?,?,?,?,0,1,'primary',?,'{}')
          ON CONFLICT DO NOTHING`, workflowId, orgId, spec.employeeId, spec.createdBy, spec.goal,
        now, now, specVersion, spec.authoritySnapshot.deploymentId, spec.idempotencyKey, JSON.stringify(origin),
        spec.servicePrincipalId, spec.subscriptionId, JSON.stringify(spec.provenance));
        if (!changed(inserted)) throw FENCE_LOST;
        const taskInsert = await run(`INSERT INTO crew_tasks(id,org_id,workflow_id,parent_task_id,owner_employee_id,capability,goal,input_refs,success_criteria,
          state,priority,idempotency_key,correlation_id,spec_version,runtime_version,lease_generation,attempts,deadline_at,queue_owner,event_inbox_id,created_at,updated_at)
          VALUES(?,?,?,NULL,?,?,?,?,'["independently verified event evidence"]','queued',80,?,?,?,'event-simulation-v1',0,0,?,'event_response_v1',?,?,?)`,
        taskId, orgId, workflowId, spec.employeeId, task.capability, spec.goal,
        JSON.stringify([{ type: 'paid_order_observation', inboxId: dispatch.inbox_id, observationHash: spec.observationHash }]),
        spec.idempotencyKey, dispatchId, specVersion, dispatch.recovery_deadline_at ?? dispatch.dispatch_deadline_at ?? null,
        dispatch.inbox_id, now, now);
        if (!changed(taskInsert)) throw FENCE_LOST;
        const published = await run(`UPDATE event_dispatch_records SET primary_workflow_id=?,task_id=?,state='running',updated_at=?
          WHERE org_id=? AND id=? AND worker_owner=? AND lease_generation=? AND state IN ('checking','running')
            AND lease_expires_at>? AND primary_workflow_id IS NULL AND task_id IS NULL`,
        workflowId, taskId, now, orgId, dispatchId, lease.owner, lease.generation, now);
        if (!changed(published)) throw FENCE_LOST;
        const workflow = await getWorkflow({ orgId, workflowId });
        if (!workflow || workflow.role !== 'primary' || workflow.employeeId !== spec.employeeId || workflow.provenance?.dispatchId !== dispatchId) throw FENCE_LOST;
        // Queue publication is the atomic insertion of its event-owned crew_tasks row.
        if (publication?.queue !== 'event-simulation-local' || !Array.isArray(publication.toolAllowlist)
          || publication.toolAllowlist.length !== 1 || publication.toolAllowlist[0] !== 'shopify.order.read_simulated') throw FENCE_LOST;
        return { updated: true, workflow };
      });
    } catch (error) {
      if (error === FENCE_LOST) return { updated: false };
      throw error;
    }
  }

  async function recordWorkflowEvidenceFenced(args) {
    try {
      return await transaction(async () => {
        const { orgId, dispatchId, lease, workflowId, executionGeneration, role, result, output, continuation, evidenceRefs, status, now } = args;
        const dispatchOk = await get(`SELECT id FROM event_dispatch_records WHERE org_id=? AND id=? AND worker_owner=? AND lease_generation=?
          AND state IN ('checking','running') AND lease_expires_at>?`, orgId, dispatchId, lease?.owner, lease?.generation, now);
        const workflow = await get('SELECT * FROM workflows WHERE org_id=? AND id=?', orgId, workflowId);
        if (!dispatchOk || !workflow || workflow.execution_role !== role || Number(workflow.execution_generation) !== Number(executionGeneration)
          || !['queued', 'working', 'running', 'waiting_dependency', 'completed'].includes(workflow.status)) throw FENCE_LOST;
        const provenance = parse(workflow.provenance_json, {});
        const steps = output?.steps;
        if (!Array.isArray(steps) || !steps.length || !Array.isArray(evidenceRefs) || !evidenceRefs.length || !provenance.connectionId || !provenance.eventVersion) throw FENCE_LOST;
        const stepInputHash = hash(steps.map(({ tool, input }) => ({ tool, input })));
        const verify = verifyEvidence ?? (() => ({ verified: false }));
        const checked = await verify({ orgId, connectionId: provenance.connectionId, eventVersion: provenance.eventVersion,
          workflowId, executionGeneration, steps, stepInputHash, toolRunRefs: evidenceRefs,
          observation: parse(parse(workflow.origin, {}).observation, parse(workflow.origin, {}).observation),
          observationHash: provenance.observationHash, role, now });
        if (checked?.verified !== true || !checked.verifierId || checked.bindings?.orgId !== orgId
          || checked.bindings?.connectionId !== provenance.connectionId || checked.bindings?.workflowId !== workflowId
          || checked.bindings?.eventVersion !== provenance.eventVersion || checked.bindings?.executionGeneration !== executionGeneration
          || checked.bindings?.stepInputHash !== stepInputHash || checked.bindings?.observationHash !== provenance.observationHash
          || checked.bindings?.verifierId !== checked.verifierId || !Array.isArray(checked.refs) || !checked.refs.length) throw FENCE_LOST;
        if (args.verifierId && args.verifierId !== checked.verifierId) throw FENCE_LOST;
        if (args.evidenceBindings && stable(args.evidenceBindings) !== stable(checked.bindings)) throw FENCE_LOST;
        const refs = checked.refs.map((ref) => typeof ref === 'string' ? { toolRunId: ref } : { toolRunId: ref?.toolRunId });
        if (refs.some((ref) => !ref.toolRunId) || refs.length !== evidenceRefs.length) throw FENCE_LOST;
        const encodedOutput = JSON.stringify({ ...output, result, continuation: continuation ?? output.continuation ?? null });
        const existingEvidence = await get('SELECT * FROM event_workflow_evidence WHERE org_id=? AND workflow_id=? AND execution_generation=?', orgId, workflowId, executionGeneration);
        if (existingEvidence) {
          const identical = existingEvidence.dispatch_id === dispatchId && existingEvidence.connection_id === provenance.connectionId
            && existingEvidence.source_event_id === provenance.eventId && existingEvidence.event_version === provenance.eventVersion
            && existingEvidence.observation_hash === provenance.observationHash && existingEvidence.step_input_hash === stepInputHash
            && existingEvidence.role === role && existingEvidence.verifier_id === checked.verifierId
            && stable(parse(existingEvidence.bindings_json, {})) === stable(checked.bindings)
            && stable(parse(existingEvidence.evidence_refs_json, [])) === stable(refs)
            && stable(parse(existingEvidence.result_json, {})) === stable(parse(encodedOutput, {}));
          if (!identical) throw FENCE_LOST;
        } else {
          const evidenceId = newId('event_evidence');
          const inserted = await run(`INSERT INTO event_workflow_evidence(id,org_id,dispatch_id,workflow_id,connection_id,source_event_id,event_version,
            observation_hash,step_input_hash,execution_generation,role,verifier_id,bindings_json,evidence_refs_json,result_json,continuation_json,verified_at,created_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(org_id,workflow_id,execution_generation) DO NOTHING`,
          evidenceId, orgId, dispatchId, workflowId, provenance.connectionId, provenance.eventId, provenance.eventVersion,
          provenance.observationHash, stepInputHash, executionGeneration, role, checked.verifierId, JSON.stringify(checked.bindings),
          JSON.stringify(refs), encodedOutput, JSON.stringify(continuation ?? {}), now, now);
          if (!changed(inserted)) throw FENCE_LOST;
          for (const ref of refs) {
            const runRow = await get(`SELECT id FROM tool_runs WHERE org_id=? AND workflow_id=? AND id=? AND status='completed'
              AND tool='shopify.order.read_simulated' AND lease_generation=?`, orgId, workflowId, ref.toolRunId, executionGeneration);
            if (!runRow) throw FENCE_LOST;
            const runInsert = await run(`INSERT INTO event_workflow_evidence_runs(org_id,evidence_id,tool_run_id) VALUES(?,?,?) ON CONFLICT DO NOTHING`, orgId, evidenceId, ref.toolRunId);
            if (!changed(runInsert)) {
              const prior = await get('SELECT tool_run_id FROM event_workflow_evidence_runs WHERE org_id=? AND evidence_id=? AND tool_run_id=?', orgId, evidenceId, ref.toolRunId);
              if (!prior) throw FENCE_LOST;
            }
          }
        }
        const taskState = status === 'completed' ? 'completed' : status === 'waiting_dependency' ? 'waiting_dependency' : 'running';
        const task = await get('SELECT * FROM crew_tasks WHERE org_id=? AND workflow_id=?', orgId, workflowId);
        if (!task || task.org_id !== orgId || task.owner_employee_id !== workflow.employee_id
          || task.queue_owner !== 'event_response_v1' || Number(task.lease_generation) !== Number(workflow.lease_generation)) throw FENCE_LOST;
        const updateWorkflow = await run(`UPDATE workflows SET status=?,result=?,continuation_json=?,finished_at=?,updated_at=?,
          lease_generation=CASE WHEN ?='waiting_dependency' AND status<>'waiting_dependency' THEN lease_generation+1 ELSE lease_generation END,
          worker_id=CASE WHEN ? IN ('waiting_dependency','completed') THEN NULL ELSE worker_id END,
          lease_expires_at=CASE WHEN ? IN ('waiting_dependency','completed') THEN NULL ELSE lease_expires_at END
          WHERE org_id=? AND id=? AND execution_generation=? AND execution_role=? AND status IN ('queued','working','running','waiting_dependency','completed')`,
        status, JSON.stringify(result ?? null), JSON.stringify(continuation ?? {}), status === 'completed' ? now : null, now,
        status, status, status, orgId, workflowId, executionGeneration, role);
        if (!changed(updateWorkflow)) throw FENCE_LOST;
        const updateTask = await run(`UPDATE crew_tasks SET state=?,result_json=?,updated_at=?,
          lease_generation=CASE WHEN ?='waiting_dependency' AND state<>'waiting_dependency' THEN lease_generation+1 ELSE lease_generation END,
          worker_id=NULL,lease_expires_at=NULL WHERE org_id=? AND workflow_id=? AND state IN ('queued','running','waiting_dependency','retry','completed')
            AND lease_generation=?`, taskState, JSON.stringify({ result: result ?? null, evidenceRefs: refs, executionGeneration }), now,
        taskState, orgId, workflowId, task.lease_generation);
        if (!changed(updateTask)) throw FENCE_LOST;
        if (taskState === 'waiting_dependency' || taskState === 'completed') {
          await run('DELETE FROM employee_execution_locks WHERE org_id=? AND workflow_id=? AND task_id=?', orgId, workflowId, task.id);
        }
        return { updated: true, workflow: await getWorkflow({ orgId, workflowId }) };
      });
    } catch (error) {
      if (error === FENCE_LOST) return { updated: false };
      throw error;
    }
  }

  async function saveContinuationFenced({ orgId, dispatchId, lease, workflowId, executionGeneration, continuation, now }) {
    try {
      return await transaction(async () => {
        const dispatchOk = await get(`SELECT id FROM event_dispatch_records WHERE org_id=? AND id=? AND worker_owner=? AND lease_generation=?
          AND state IN ('checking','running') AND lease_expires_at>?`, orgId, dispatchId, lease?.owner, lease?.generation, now);
        if (!dispatchOk) throw FENCE_LOST;
        const updated = await run(`UPDATE workflows SET continuation_json=?,updated_at=? WHERE org_id=? AND id=?
          AND execution_generation=? AND execution_role IN ('primary','child') AND status IN ('queued','working','running','waiting_dependency')`,
        JSON.stringify(continuation ?? {}), now, orgId, workflowId, executionGeneration);
        if (!changed(updated)) throw FENCE_LOST;
        return { updated: true, workflow: await getWorkflow({ orgId, workflowId }) };
      });
    } catch (error) {
      if (error === FENCE_LOST) return { updated: false };
      throw error;
    }
  }

  async function completeDispatchFenced(args) {
    try {
      return await transaction(async () => {
        const { orgId, dispatchId, lease, primaryWorkflowId, primaryExecutionGeneration, result, evidenceRefs, delegationSlotId, delegationSlotGeneration, now } = args;
        const dispatch = await get(`SELECT * FROM event_dispatch_records WHERE org_id=? AND id=? AND worker_owner=? AND lease_generation=?
          AND state IN ('checking','running') AND lease_expires_at>? AND primary_workflow_id=?`, orgId, dispatchId, lease?.owner, lease?.generation, now, primaryWorkflowId);
        const primary = await get("SELECT id FROM workflows WHERE org_id=? AND id=? AND execution_role='primary' AND execution_generation=? AND status='completed'", orgId, primaryWorkflowId, primaryExecutionGeneration);
        const evidence = await get("SELECT id FROM event_workflow_evidence WHERE org_id=? AND dispatch_id=? AND workflow_id=? AND execution_generation=? AND role='primary'", orgId, dispatchId, primaryWorkflowId, primaryExecutionGeneration);
        if (!dispatch || !primary || !evidence) throw FENCE_LOST;
        if (delegationSlotId) {
          const slot = await get(`SELECT id FROM task_delegations WHERE org_id=? AND id=? AND dispatch_id=? AND legacy=0
            AND state='resolved' AND slot_generation=? AND parent_workflow_id=?`, orgId, delegationSlotId, dispatchId, delegationSlotGeneration, primaryWorkflowId);
          if (!slot) throw FENCE_LOST;
        }
        const outcome = { ...(parse(dispatch.outcome_json, {}) || {}), result: result ?? null, evidenceRefs: evidenceRefs ?? [], completedAt: now };
        const saved = await run(`UPDATE event_dispatch_records SET state='completed',blocked_reason=NULL,outcome_json=?,lease_expires_at=NULL,next_attempt_at=NULL,updated_at=?
          WHERE org_id=? AND id=? AND worker_owner=? AND lease_generation=? AND state IN ('checking','running') AND lease_expires_at>? AND primary_workflow_id=?`,
        JSON.stringify(outcome), now, orgId, dispatchId, lease.owner, lease.generation, now, primaryWorkflowId);
        if (!changed(saved)) throw FENCE_LOST;
        return { updated: true, dispatch: await getDispatch({ orgId, dispatchId }) };
      });
    } catch (error) {
      if (error === FENCE_LOST) return { updated: false };
      throw error;
    }
  }

  async function retryDispatchFenced(args) {
    try {
      return await transaction(async () => {
        const { orgId, dispatchId, lease, maxAttempts, backoff, deadlineAt, now } = args;
        const dispatch = await get(`SELECT * FROM event_dispatch_records WHERE org_id=? AND id=? AND worker_owner=? AND lease_generation=?
          AND state IN ('checking','running') AND lease_expires_at>?`, orgId, dispatchId, lease?.owner, lease?.generation, now);
        if (!dispatch) throw FENCE_LOST;
        const attempts = Number(dispatch.attempts ?? 0);
        const persistedDeadline = dispatch.dispatch_deadline_at ?? dispatch.recovery_deadline_at ?? deadlineAt ?? null;
        const delay = Math.min(Number(backoff?.maxDelayMs ?? 300_000), Number(backoff?.baseDelayMs ?? 1_000) * (2 ** Math.max(0, attempts - 1)));
        const nextAt = new Date(Date.parse(now) + delay).toISOString();
        const exhausted = attempts >= Number(maxAttempts ?? 6) || (persistedDeadline && Date.parse(nextAt) >= Date.parse(persistedDeadline));
        const state = exhausted ? 'dead_letter' : 'retry';
        const reason = String(args.reason ?? args.error?.message ?? (args.pending ? 'response_pending' : 'transient_failure')).slice(0, 300);
        const saved = await run(`UPDATE event_dispatch_records SET state=?,next_attempt_at=?,blocked_reason=?,lease_expires_at=NULL,updated_at=?
          WHERE org_id=? AND id=? AND worker_owner=? AND lease_generation=? AND state IN ('checking','running') AND lease_expires_at>?`,
        state, exhausted ? null : nextAt, reason, now, orgId, dispatchId, lease.owner, lease.generation, now);
        if (!changed(saved)) throw FENCE_LOST;
        return { updated: true, state, dispatch: await getDispatch({ orgId, dispatchId }) };
      });
    } catch (error) {
      if (error === FENCE_LOST) return { updated: false };
      throw error;
    }
  }

  async function failChainFenced(args) {
    try {
      return await transaction(async () => {
        const { orgId, dispatchId, lease, slotId, expectedSlotGeneration, code, message, now } = args;
        const dispatch = await get(`SELECT * FROM event_dispatch_records WHERE org_id=? AND id=? AND worker_owner=? AND lease_generation=?
          AND state IN ('checking','running') AND lease_expires_at>?`, orgId, dispatchId, lease?.owner, lease?.generation, now);
        if (!dispatch) throw FENCE_LOST;
        if (slotId) {
          const slot = await get(`SELECT * FROM task_delegations WHERE org_id=? AND id=? AND dispatch_id=? AND state='waiting'
            AND legacy=0 AND slot_generation=?`, orgId, slotId, dispatchId, expectedSlotGeneration);
          if (slot) {
            const slotUpdate = await run(`UPDATE task_delegations SET state='failed',slot_generation=slot_generation+1,
              resolution_json=?,resolved_at=?,updated_at=? WHERE org_id=? AND id=? AND state='waiting' AND slot_generation=? AND legacy=0`,
            JSON.stringify({ code, message }), now, now, orgId, slotId, expectedSlotGeneration);
            if (!changed(slotUpdate)) throw FENCE_LOST;
            await run("UPDATE crew_tasks SET state='failed',last_error=?,updated_at=? WHERE org_id=? AND id=? AND state IN ('queued','running','waiting_dependency','retry')", message, now, orgId, slot.child_task_id);
          }
        }
        if (dispatch.primary_workflow_id) {
          const workflow = await get('SELECT id,execution_generation,status FROM workflows WHERE org_id=? AND id=?', orgId, dispatch.primary_workflow_id);
          if (workflow && !['completed', 'failed', 'cancelled'].includes(workflow.status)) {
            const failed = await run(`UPDATE workflows SET status='failed',error=?,finished_at=?,updated_at=? WHERE org_id=? AND id=?
              AND execution_generation=? AND status NOT IN ('completed','failed','cancelled')`, String(message).slice(0, 300), now, now, orgId, workflow.id, workflow.execution_generation);
            if (!changed(failed)) throw FENCE_LOST;
            await run("UPDATE crew_tasks SET state='failed',last_error=?,worker_id=NULL,lease_expires_at=NULL,updated_at=? WHERE org_id=? AND workflow_id=? AND state IN ('queued','running','waiting_dependency','retry')", String(message).slice(0, 300), now, orgId, workflow.id);
          }
        }
        const outcome = { ...(parse(dispatch.outcome_json, {}) || {}), terminalError: { code, message: String(message).slice(0, 300) } };
        const failed = await run(`UPDATE event_dispatch_records SET state='failed',blocked_reason=?,outcome_json=?,lease_expires_at=NULL,next_attempt_at=NULL,updated_at=?
          WHERE org_id=? AND id=? AND worker_owner=? AND lease_generation=? AND state IN ('checking','running') AND lease_expires_at>?`,
        String(code).slice(0, 300), JSON.stringify(outcome), now, orgId, dispatchId, lease.owner, lease.generation, now);
        if (!changed(failed)) throw FENCE_LOST;
        return { updated: true, dispatch: await getDispatch({ orgId, dispatchId }) };
      });
    } catch (error) {
      if (error === FENCE_LOST) return { updated: false };
      throw error;
    }
  }

  return {
    getDispatch, getInbox, getWorkflow, getPaidOrderSnapshot, assertDispatchLease,
    ensurePrimaryFenced, recordWorkflowEvidenceFenced, saveContinuationFenced,
    completeDispatchFenced, retryDispatchFenced, failChainFenced,
  };
}
