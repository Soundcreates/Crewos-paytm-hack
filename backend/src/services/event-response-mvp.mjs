import { createHash } from 'node:crypto';

const TOOL = 'shopify.order.read_simulated';
const ALLOWED = Object.freeze([TOOL]);
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
const fail = (code, message) => Object.assign(new Error(message), { code });
const refIds = (value) => Array.isArray(value) ? value.map((ref) => typeof ref === 'string' ? ref : ref?.toolRunId).filter(Boolean).sort() : [];

/** Deterministic, local-only reasoner and worker for the hackathon event demo. */
export function createEventResponseMvpAdapters({ repository, get, run, transaction, newId, timestamp }) {
  if (!repository?.store || !repository?.authorityReads || ![get, run, transaction, newId, timestamp].every((fn) => typeof fn === 'function')) {
    throw new TypeError('Event response MVP adapters require the SQL event repository and database helpers.');
  }
  const reasoner = {
    async reason({ role, observation, event, employee, allowedTools }) {
      if (!Array.isArray(allowedTools) || allowedTools.length !== 1 || allowedTools[0] !== TOOL) throw fail('tool_not_allowed', 'The event demo permits only local simulated order reads.');
      const amount = `${observation.currency} ${(Number(observation.totalMinor) / (['JPY','KRW'].includes(observation.currency) ? 1 : 100)).toFixed(['JPY','KRW'].includes(observation.currency) ? 0 : 2)}`;
      const profileLabel = String(employee?.spec?.title ?? employee?.spec?.name ?? employee?.spec?.role ?? '').trim();
      const result = role === 'primary'
        ? { summary: `Paid order ${observation.remoteOrderId} was verified for ${amount}. A support coworker will review the order context.`, orderId: observation.remoteOrderId, paymentState: 'paid' }
        : { summary: `${profileLabel ? `${profileLabel} ` : ''}review completed for paid order ${observation.remoteOrderId} (${amount}). The event is simulated and no customer was contacted.`, orderId: observation.remoteOrderId, recommendation: 'No external follow-up was sent.' };
      return {
        steps: [{ tool: TOOL, input: { connectionId: event.connectionId, eventVersion: event.eventVersion, observationHash: hash(observation) } }],
        result,
        ...(role === 'primary' ? { collaborationRequest: { capability: 'support.case.triage', objective: 'Review this paid order as a support specialist and provide a concise observation for the primary employee.' } } : {}),
      };
    },
  };

  async function runWorkflow({ orgId, workflowId, expectedExecutionGeneration, dispatchLease, plan, allowedTools }) {
    if (!Array.isArray(allowedTools) || allowedTools.length !== 1 || allowedTools[0] !== TOOL
      || !Array.isArray(plan?.steps) || plan.steps.length !== 1 || plan.steps[0]?.tool !== TOOL) throw fail('tool_not_allowed', 'The event workflow attempted a tool outside the local simulation allowlist.');
    const workflow = await repository.store.getWorkflow({ orgId, workflowId });
    if (!workflow || workflow.runtimeVersion !== 'event-simulation-v1' || workflow.executionGeneration !== expectedExecutionGeneration) throw fail('execution_fence_conflict', 'Event workflow generation changed.');
    const dispatch = await repository.store.getDispatch({ orgId, dispatchId: workflow.provenance?.dispatchId });
    if (!dispatch || dispatch.orgId !== orgId || !(await repository.store.assertDispatchLease({ orgId, dispatchId: dispatch.id, lease: dispatchLease, now: timestamp() }))?.valid) throw fail('lease_lost', 'Event dispatch lease is no longer current.');
    const input = plan.steps[0].input;
    if (!input || input.connectionId !== dispatch.connectionId || input.eventVersion !== dispatch.eventId || input.observationHash !== workflow.observationHash) throw fail('event_input_binding_mismatch', 'The read request does not match the workflow event binding.');
    const event = await repository.authorityReads.verifyInboxEvent({ orgId, inboxId: dispatch.inboxId, eventId: dispatch.eventId, expectedTopic: dispatch.topic, expectedConnectionId: dispatch.connectionId });
    if (event?.verified !== true || hash(event.paidOrderObservation) !== input.observationHash) throw fail('event_observation_unverified', 'The paid order observation could not be verified.');
    const output = { observation: event.paidOrderObservation, observationHash: input.observationHash };
    const at = timestamp();
    const step = { tool: TOOL, input, output, toolRunRefs: [] };
    const toolRunId = await transaction(async () => {
      const current = await repository.store.getWorkflow({ orgId, workflowId });
      const lease = await repository.store.assertDispatchLease({ orgId, dispatchId: dispatch.id, lease: dispatchLease, now: at });
      if (!current || current.executionGeneration !== expectedExecutionGeneration || !lease?.valid) throw fail('execution_fence_conflict', 'Event read lost its execution fence.');
      let saved = await get('SELECT * FROM tool_runs WHERE org_id=? AND workflow_id=? AND step_index=0', orgId, workflowId);
      if (saved) {
        if (saved.tool !== TOOL || Number(saved.lease_generation) !== expectedExecutionGeneration || stable(parse(saved.input, {})) !== stable(input)) throw fail('tool_run_conflict', 'A different read already occupies this workflow step.');
        if (saved.status !== 'completed') {
          await run(`UPDATE tool_runs SET status='completed',output=?,verification=?,retry_at=NULL WHERE org_id=? AND id=? AND workflow_id=? AND lease_generation=?`,
            JSON.stringify(output), JSON.stringify({ verifier: 'event-response-sql-v1', observationHash: input.observationHash }), orgId, saved.id, workflowId, expectedExecutionGeneration);
        } else if (stable(parse(saved.output, {})) !== stable(output)) throw fail('tool_run_conflict', 'The verified read result changed on replay.');
        return saved.id;
      }
      const id = newId('toolrun');
      await run(`INSERT INTO tool_runs(id,org_id,workflow_id,step_index,tool,input,output,status,attempt_count,operation_id,lease_generation,verification,created_at)
        VALUES(?,?,?,0,?,?,?,'completed',1,NULL,?,?,?)`, id, orgId, workflowId, TOOL, JSON.stringify(input), JSON.stringify(output), expectedExecutionGeneration,
      JSON.stringify({ verifier: 'event-response-sql-v1', observationHash: input.observationHash }), at);
      return id;
    });
    step.toolRunRefs.push(toolRunId);
    return { output: { steps: [step], result: plan.result, continuation: plan.continuation ?? null, collaborationRequest: plan.collaborationRequest ?? null } };
  }

  async function resumeWorkflow({ orgId, workflowId, expectedExecutionGeneration, dispatchLease, slotId, expectedSlotGeneration, dependency, allowedTools }) {
    if (!Array.isArray(allowedTools) || allowedTools.length !== 1 || allowedTools[0] !== TOOL) throw fail('tool_not_allowed', 'The event workflow attempted a tool outside the local simulation allowlist.');
    return transaction(async () => {
      const at = timestamp();
      const workflow = await get('SELECT * FROM workflows WHERE org_id=? AND id=?', orgId, workflowId);
      if (!workflow || workflow.execution_role !== 'primary' || Number(workflow.execution_generation) !== Number(expectedExecutionGeneration)) return { updated: false };
      const dispatch = await get(`SELECT * FROM event_dispatch_records WHERE org_id=? AND id=? AND worker_owner=? AND lease_generation=?
        AND state IN ('checking','running') AND lease_expires_at>?`, orgId, workflow.provenance_json ? parse(workflow.provenance_json, {}).dispatchId : '', dispatchLease?.owner, dispatchLease?.generation, at);
      const slot = await get(`SELECT * FROM task_delegations WHERE org_id=? AND id=? AND parent_workflow_id=? AND state='resolved'
        AND legacy=0 AND slot_generation=? AND child_workflow_id=?`, orgId, slotId, workflowId, expectedSlotGeneration, dependency?.childWorkflowId);
      const child = slot && await get(`SELECT w.id,w.status,w.execution_generation,e.evidence_refs_json FROM workflows w
        JOIN event_workflow_evidence e ON e.org_id=w.org_id AND e.workflow_id=w.id AND e.execution_generation=w.execution_generation AND e.role='child'
        WHERE w.org_id=? AND w.id=? AND w.execution_role='child' AND w.status='completed'`, orgId, dependency.childWorkflowId);
      const task = await get('SELECT * FROM crew_tasks WHERE org_id=? AND workflow_id=?', orgId, workflowId);
      if (!dispatch || !slot || !child || !task || task.state !== 'waiting_dependency' || workflow.status !== 'waiting_dependency'
        || Number(child.execution_generation) !== Number(slot.child_execution_generation)
        || stable(refIds(parse(slot.evidence_json, []))) !== stable(refIds(dependency.evidenceRefs))
        || stable(refIds(parse(child.evidence_refs_json, []))) !== stable(refIds(dependency.evidenceRefs))
        || !dependency.result || !Array.isArray(dependency.evidenceRefs) || !dependency.evidenceRefs.length) return { updated: false };
      const original = parse(workflow.result, {});
      const finalResult = { ...original, collaboration: { childWorkflowId: child.id, result: dependency.result, evidenceRefs: dependency.evidenceRefs } };
      const updated = await run(`UPDATE workflows SET status='completed',result=?,finished_at=?,updated_at=?,worker_id=NULL,lease_expires_at=NULL
        WHERE org_id=? AND id=? AND status='waiting_dependency' AND execution_role='primary' AND execution_generation=? AND lease_generation=?`,
      JSON.stringify(finalResult), at, at, orgId, workflowId, expectedExecutionGeneration, workflow.lease_generation);
      if (Number(updated?.changes ?? updated?.rowCount ?? 0) !== 1) return { updated: false };
      const taskUpdated = await run(`UPDATE crew_tasks SET state='completed',result_json=?,worker_id=NULL,lease_expires_at=NULL,updated_at=?
        WHERE org_id=? AND workflow_id=? AND state='waiting_dependency' AND lease_generation=?`, JSON.stringify({ result: finalResult, evidenceRefs: dependency.evidenceRefs }), at, orgId, workflowId, task.lease_generation);
      if (Number(taskUpdated?.changes ?? taskUpdated?.rowCount ?? 0) !== 1) throw fail('execution_fence_conflict', 'Parent task could not be resumed.');
      return { updated: true };
    });
  }

  return { reasoner, worker: { runWorkflow, resumeWorkflow }, allowedTools: ALLOWED };
}
