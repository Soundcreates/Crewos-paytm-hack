import { getWorkflowCheckpointer } from './checkpointer.mjs';
import { Command, createReActWorkflowGraph } from './graph.mjs';

function publicSource(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.toString();
  } catch { return null; }
}

function collectSources(results) {
  const seen = new Set();
  const sources = [];
  for (const result of results || []) {
    if (result.skipped) continue;
    const output = result.output || {};
    const candidates = result.tool === 'tinyfish.search'
      ? (Array.isArray(output.results) ? output.results : [])
      : String(result.tool || '').startsWith('solari.browser.')
        ? [{ url: result.evidence?.url || output.url, title: result.evidence?.title || output.title }]
        : [];
    for (const candidate of candidates) {
      const url = publicSource(candidate?.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      sources.push({ url, title: String(candidate?.title || url).slice(0, 240) });
      if (sources.length >= 30) break;
    }
    if (sources.length >= 30) break;
  }
  return sources.slice(0, 30);
}

function pendingApproval(workflow) {
  const requests = workflow.input_requests && typeof workflow.input_requests === 'object' ? workflow.input_requests : {};
  const responses = workflow.input_responses && typeof workflow.input_responses === 'object' ? workflow.input_responses : {};
  const requestKey = Object.keys(requests).find((key) => key.startsWith('approval-'));
  return requestKey && responses[requestKey] ? responses[requestKey] : null;
}

export async function runReActWorkflow(options) {
  const checkpointer = options.checkpointer || await getWorkflowCheckpointer();
  const graph = createReActWorkflowGraph({ ...options, checkpointer });
  // A root graph stores checkpoints in the empty namespace. Runtime version is
  // application metadata, not a subgraph checkpoint namespace.
  const config = { configurable: { thread_id: options.workflow.id } };
  const checkpoint = await checkpointer.getTuple(config);
  const approval = pendingApproval(options.workflow);
  const input = checkpoint
    ? (approval ? new Command({ resume: approval }) : null)
    : { messages: [
      { role: 'system', content: options.systemPrompt },
      { role: 'user', content: options.userPrompt },
    ] };
  const recursionLimit = Math.max(25, (Number(options.maxToolCalls) || 8) * 5 + 20);
  const state = await graph.invoke(input, { ...config, recursionLimit });
  const interrupt = Array.isArray(state?.__interrupt__) ? state.__interrupt__[0] : null;
  if (interrupt) return { status: 'input_required', interrupt: interrupt.value };
  if (state?.status !== 'completed' || typeof state.finalAnswer !== 'string' || !state.finalAnswer.trim()) {
    throw new Error('The agent graph stopped without producing a final answer.');
  }
  return {
    status: 'completed',
    answer: state.finalAnswer.trim(),
    steps: Array.isArray(state.toolResults) ? state.toolResults : [],
    sources: collectSources(state.toolResults),
  };
}

export function reactApprovalRequest(interruptValue) {
  if (!interruptValue || interruptValue.kind !== 'policy_approval' || typeof interruptValue.requestKey !== 'string') {
    throw new Error('The task graph interrupted without a valid policy approval request.');
  }
  return {
    [interruptValue.requestKey]: {
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: `${String(interruptValue.reason || 'Workspace policy requires review').slice(0, 300)}. Review this action before it runs.`,
        requestedSchema: {
          type: 'object',
          properties: { approved: { type: 'boolean', title: 'Approve action' }, note: { type: 'string', title: 'Review note' } },
          required: ['approved'],
        },
        tool: interruptValue.tool,
        input: interruptValue.input,
      },
    },
  };
}
