import { parseJson } from './values.mjs';

export function workflowTask(workflow) {
  const task = {
    resultType: 'complete',
    taskId: workflow.id,
    status: workflow.status === 'queued' ? 'working' : workflow.status,
    createdAt: workflow.created_at,
    lastUpdatedAt: workflow.updated_at,
    ttlMs: null,
    pollIntervalMs: 1500,
  };

  if (workflow.status === 'input_required') task.inputRequests = parseJson(workflow.input_requests, {});
  if (workflow.status === 'completed') {
    task.result = {
      content: [{ type: 'text', text: JSON.stringify(parseJson(workflow.result, {})) }],
      isError: false,
    };
  }
  if (workflow.status === 'failed') {
    task.error = { code: -32000, message: workflow.error || 'Workflow failed.' };
  }

  return task;
}
