import { repositories } from '../src/repositories/index.mjs';
import { safeTaskTraceValue } from './trace-sanitizer.mjs';

const SNAPSHOT_VERSION = 1;
const maxSnapshotBytes = 32 * 1024 * 1024;
const snapshotLimits = { maxArrayItems: 5000, maxStringLength: maxSnapshotBytes };

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export async function persistWorkflowSnapshot(orgId, workflowId) {
  const workflow = await repositories.workflows.findOneWorkflowByIdAndOrgIdSelectWEmployeeName(workflowId, orgId);
  if (!workflow || !['completed', 'failed', 'cancelled'].includes(workflow.status)) return null;
  const [toolRuns, events] = await Promise.all([
    repositories.workflows.findManyToolRunByOrgIdAndWorkflowIdSelectIdStepIndexToolOrderedByStepIndex(orgId, workflowId),
    repositories.workflows.findManyEventByOrgIdAndWorkflowIdSelectIdKindDetail(orgId, workflowId),
  ]);
  const result = parseJson(workflow.result, null);
  const traceWorkflow = safeTaskTraceValue({
    id: workflow.id, goal: workflow.goal, status: workflow.status, runtime_version: workflow.runtime_version,
    error: workflow.error, step_index: workflow.step_index, started_at: workflow.started_at,
    finished_at: workflow.finished_at, updated_at: workflow.updated_at, plan: parseJson(workflow.plan, []), result,
  }, 0, snapshotLimits);
  if (traceWorkflow.result && typeof result?.answer === 'string') traceWorkflow.result.answer = result.answer.slice(0, 24000);
  const snapshot = {
    version: SNAPSHOT_VERSION,
    capturedAt: new Date().toISOString(),
    workflow: safeTaskTraceValue({ id: workflow.id, goal: workflow.goal, status: workflow.status, error: workflow.error, employee_name: workflow.employee_name, result }, 0, snapshotLimits),
    trace: {
      workflow: traceWorkflow,
      toolRuns: toolRuns.map((row) => safeTaskTraceValue({ ...row, input: parseJson(row.input, null), output: parseJson(row.output, null) }, 0, snapshotLimits)),
      events: events.map((row) => safeTaskTraceValue({ ...row, detail: parseJson(row.detail, {}) }, 0, snapshotLimits)),
    },
  };
  const serialized = JSON.stringify(snapshot);
  if (Buffer.byteLength(serialized, 'utf8') > maxSnapshotBytes) throw new Error('Workflow snapshot exceeded the 32 MB storage limit.');
  const capturedAt = snapshot.capturedAt;
  await repositories.workflows.insertWorkflowSnapshot(workflowId, orgId, SNAPSHOT_VERSION, serialized, capturedAt, capturedAt);
  return { version: SNAPSHOT_VERSION, capturedAt };
}

export async function getWorkflowSnapshot(orgId, workflowId) {
  const row = await repositories.workflows.findOneWorkflowSnapshotByOrgIdAndWorkflowId(orgId, workflowId);
  if (!row) return null;
  const snapshot = parseJson(row.snapshot, null);
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.trace) return null;
  return { ...snapshot, version: Number(row.schema_version) || snapshot.version, capturedAt: row.updated_at || row.created_at };
}
