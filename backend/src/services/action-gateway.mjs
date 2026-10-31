import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = (value) => createHash('sha256').update(stable(value)).digest('hex');
const highRisk = new Set(['shopify.product.set','shopify.theme.publish','vercel.deploy.production','customer.message.send','payments.transfer','payments.refund']);

/** Policy floor applies even when no ordinary policy rows exist. */
export function mandatoryRiskDecision(action, environment) {
  if (!highRisk.has(action)) return { decision: 'ordinary_policy' };
  // The legacy `payments.refund` tool is explicitly implemented as a local
  // simulated ledger write. External payment handlers must pass their trusted
  // connection environment through this gateway and still require approval.
  if (action === 'payments.refund' && environment === 'simulation') return { decision: 'ordinary_policy' };
  if (environment === 'production') return { decision: 'REQUIRE_APPROVAL', reason: 'mandatory_high_risk_approval' };
  return { decision: 'REQUIRE_APPROVAL', reason: 'mandatory_high_risk_approval' };
}

/** Registers identity for an existing tool_runs effect record; it cannot dispatch. */
export function createActionGateway({ repository, newId, timestamp }) {
  return {
    async register(request) {
      if (!request?.orgId || !request?.taskId || !request?.workflowId || !request?.toolRunId || !request?.connectionId || !request?.environment || !request?.action || !request?.idempotencyKey || !request?.policyRevision || !request?.input || typeof request.input !== 'object' || Array.isArray(request.input)) throw new Error('Action request is missing a required immutable binding.');
      const bindings = await repository.findActionBindings(request.orgId, request.workflowId, request.toolRunId, request.connectionId);
      if (!bindings || bindings.org_id !== request.orgId || bindings.workflow_id !== request.workflowId || bindings.tool_run_id !== request.toolRunId || bindings.connection_id !== request.connectionId) throw new Error('Action ownership binding was not found.');
      if (bindings.environment !== request.environment) throw new Error('Action environment does not match its provider connection.');
      if (bindings.connection_state !== 'connected') throw new Error('Provider connection is not connected.');
      let recordedInput;
      try { recordedInput = JSON.parse(bindings.input); } catch { throw new Error('Existing tool_runs input is invalid.'); }
      if (!isDeepStrictEqual(recordedInput, request.input) || bindings.tool !== request.action) throw new Error('Action must match the immutable tool_runs input and tool.');
      const task = await repository.findTaskByOrgAndId(request.orgId, request.taskId);
      if (!task || task.workflow_id !== request.workflowId) throw new Error('Task does not own the linked workflow in this organization.');
      const inputHash = digest(request.input);
      const prior = await repository.findOperationByIdempotency(request.orgId, request.connectionId, request.environment, request.idempotencyKey);
      if (prior) {
        if (prior.input_hash !== inputHash || prior.tool_run_id !== request.toolRunId || prior.action !== request.action || prior.task_id !== request.taskId || prior.policy_revision !== request.policyRevision) throw Object.assign(new Error('Idempotency key conflicts with a different immutable action.'), { code: 'idempotency_conflict' });
        return prior;
      }
      const now = timestamp();
      await repository.insertExternalOperation(newId('op'),request.orgId,request.workflowId,request.toolRunId,request.connectionId,request.environment,request.taskId || null,request.action,inputHash,request.idempotencyKey,request.policyRevision,now,now,request.orgId,request.toolRunId,request.workflowId,request.connectionId);
      const result = await repository.findOperationByIdempotency(request.orgId, request.connectionId, request.environment, request.idempotencyKey);
      if (!result) throw new Error('Operation could not be bound to the existing tool run.');
      if (result.input_hash !== inputHash || result.tool_run_id !== request.toolRunId || result.task_id !== request.taskId || result.policy_revision !== request.policyRevision) throw Object.assign(new Error('Idempotency key conflicts with a different immutable action.'), { code: 'idempotency_conflict' });
      return result;
    },
    async retryDisposition(operation) {
      const row = await repository.findActionBindings(operation.org_id, operation.workflow_id, operation.tool_run_id, operation.connection_id);
      if (!row) throw new Error('Operation binding no longer resolves.');
      if (['started','reconciliation_required'].includes(row.tool_state)) return 'reconcile_before_retry';
      return row.tool_state === 'completed' ? 'already_completed' : 'existing_tool_run_controls_retry';
    },
  };
}
