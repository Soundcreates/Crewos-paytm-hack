import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { availableTaskRoutes, filterToolsForTaskRoute, normalizeTaskRoute, routeAllowsTool } from './decision-agent.mjs';

const TaskState = Annotation.Root({
  messages: Annotation({ reducer: (left, right) => left.concat(right), default: () => [] }),
  pendingCalls: Annotation({ reducer: (_, next) => next, default: () => [] }),
  callCursor: Annotation({ reducer: (_, next) => next, default: () => 0 }),
  toolCallCount: Annotation({ reducer: (_, next) => next, default: () => 0 }),
  authorizedCall: Annotation({ reducer: (_, next) => next, default: () => null }),
  lastExecution: Annotation({ reducer: (_, next) => next, default: () => null }),
  toolResults: Annotation({ reducer: (_, next) => next, default: () => [] }),
  taskRoute: Annotation({ reducer: (_, next) => next, default: () => ({ routes: [], summary: '' }) }),
  finalAnswer: Annotation({ reducer: (_, next) => next, default: () => '' }),
  status: Annotation({ reducer: (_, next) => next, default: () => 'working' }),
});

function parseToolArguments(call) {
  const raw = call?.function?.arguments;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || raw.length > 10000) throw new Error('The model returned missing or oversized tool arguments.');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('The model returned invalid JSON tool arguments.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The model returned tool arguments that are not a JSON object.');
  return parsed;
}

function contentForTool(value) {
  const content = JSON.stringify(value);
  return content.length > 12000 ? `${content.slice(0, 12000)}… tool output shortened for the next model step` : content;
}

function routeAfterAgent(state) {
  if (state.pendingCalls.length) return 'authorize';
  return state.finalAnswer.trim() ? 'finalize' : END;
}

function routeAfterVerify(state) {
  return state.callCursor < state.pendingCalls.length ? 'authorize' : 'agent';
}

export function createReActWorkflowGraph({ checkpointer, registry, routeTask, modelCall, authorizeTool, executeTool, verifyTool, validateOutcome, onProposedTool, onVerifiedTool, onEvent, maxToolCalls = 8 }) {
  const byName = new Map(registry.map((tool) => [tool.name, tool]));

  const decideRoute = async (state) => {
    const availableRoutes = availableTaskRoutes(registry);
    await onEvent('agent.route.started', { availableRoutes: availableRoutes.map(({ key, tools }) => ({ route: key, tools })) });
    const proposed = routeTask
      ? await routeTask({ messages: state.messages, availableRoutes, emit: onEvent })
      : { routes: availableRoutes.map((route) => route.key), summary: 'Routing is handled by the ReAct tool selector.' };
    const taskRoute = normalizeTaskRoute(proposed, availableRoutes);
    await onEvent('agent.route.selected', { routes: taskRoute.routes, summary: taskRoute.summary });
    return {
      taskRoute,
      messages: [{ role: 'system', content: `Task routing decision: ${taskRoute.routes.join(', ') || 'no employee tools'}; ${taskRoute.summary} Use only the tools in these selected route families. This routing summary is not a tool result.` }],
    };
  };

  const agent = async (state) => {
    const routedRegistry = filterToolsForTaskRoute(registry, state.taskRoute?.routes);
    const useTools = state.toolCallCount < maxToolCalls ? routedRegistry.map((tool) => tool.openRouterTool) : [];
    await onEvent('agent.model.started', { stepIndex: state.toolCallCount, toolsAvailable: useTools.length });
    const response = await modelCall(state.messages, useTools);
    const rawCalls = Array.isArray(response.tool_calls) ? response.tool_calls : [];
    if (rawCalls.length && state.toolCallCount >= maxToolCalls) {
      throw Object.assign(new Error('The task exhausted its tool budget.'), { code: 'tool_budget_exhausted' });
    }
    if (rawCalls.length > 1) throw new Error('The model returned parallel tool calls; this runtime executes one approved action at a time.');
    const pendingCalls = rawCalls.map((call) => ({
      id: String(call?.id || ''),
      name: String(call?.function?.name || ''),
      input: parseToolArguments(call),
    }));
    if (pendingCalls.some((call) => !call.id || call.id.length > 200)) throw new Error('The model returned a tool call without a valid call ID.');
    const assistantMessage = {
      role: 'assistant',
      content: typeof response.content === 'string' ? response.content : '',
      ...(rawCalls.length ? { tool_calls: rawCalls } : {}),
    };
    if (!pendingCalls.length && !assistantMessage.content.trim()) throw new Error('The agent returned an empty final answer.');
    if (pendingCalls.length) {
      const tool = byName.get(pendingCalls[0].name);
      await onProposedTool({
        tool: tool || null,
        rawName: pendingCalls[0].name,
        input: pendingCalls[0].input,
        stepIndex: state.toolCallCount,
      });
    }
    await onEvent(pendingCalls.length ? 'agent.tool.proposed' : 'agent.answer.drafted', {
      stepIndex: state.toolCallCount,
      ...(pendingCalls.length ? { tool: byName.get(pendingCalls[0].name)?.key || 'unknown' } : {}),
    });
    return {
      messages: [assistantMessage],
      pendingCalls,
      callCursor: 0,
      finalAnswer: pendingCalls.length ? '' : assistantMessage.content.trim(),
    };
  };

  const authorize = async (state) => {
    if (state.toolCallCount >= maxToolCalls) throw Object.assign(new Error('The task exhausted its tool budget.'), { code: 'tool_budget_exhausted' });
    const call = state.pendingCalls[state.callCursor];
    const tool = byName.get(call?.name);
    if (!tool) {
      await onEvent('agent.tool.rejected', { stepIndex: state.toolCallCount, requestedName: String(call?.name || '').slice(0, 100), reason: 'Tool is not in this employee’s preflight registry.' });
      throw Object.assign(new Error('The agent requested a tool that is not in this employee’s allowed tool registry.'), { code: 'tool_not_granted' });
    }
    if (!routeAllowsTool(tool.key, state.taskRoute?.routes)) {
      await onEvent('agent.tool.rejected', { stepIndex: state.toolCallCount, tool: tool.key, reason: 'This tool is outside the selected task route.' });
      throw Object.assign(new Error('The agent requested a tool outside the selected task route.'), { code: 'tool_route_blocked' });
    }
    const decision = await authorizeTool(tool, call.input, state.toolCallCount);
    if (decision.decision === 'DENY') throw Object.assign(new Error(`Policy blocked ${tool.key}: ${decision.reason}`), { code: 'policy_denied', httpStatus: 403 });
    if (decision.decision === 'REQUIRE_APPROVAL') {
      const requestKey = `approval-${state.toolCallCount}`;
      const approval = interrupt({
        kind: 'policy_approval', requestKey, tool: tool.key, input: call.input, reason: decision.reason,
      });
      if (!approval || approval.approved !== true) {
        throw Object.assign(new Error(approval?.note || 'A manager rejected this action.'), { code: 'approval_rejected', httpStatus: 403 });
      }
    }
    return { authorizedCall: { ...call, tool: tool.key, input: call.input, expectation: tool.description || tool.label } };
  };

  const execute = async (state) => {
    const call = state.authorizedCall;
    if (!call) throw new Error('The graph reached execution without an authorized tool call.');
    const output = await executeTool(call.tool, call.input, state.toolCallCount, call.expectation);
    return { lastExecution: { call, output } };
  };

  const verify = async (state) => {
    const execution = state.lastExecution;
    if (!execution?.call) throw new Error('The graph reached verification without a tool result.');
    let result;
    if (execution.output?.sourceFailed === true) {
      result = {
        step: state.toolCallCount,
        tool: execution.call.tool,
        skipped: true,
        source: execution.output.url || null,
        httpStatus: execution.output.httpStatus,
      };
      await onEvent('workflow.source_skipped', { stepIndex: state.toolCallCount, url: execution.output.url, httpStatus: execution.output.httpStatus, reason: execution.output.error });
    } else {
      const verification = await verifyTool(execution.call.tool, execution.output, execution.call.input, execution.call.expectation);
      if (!verification?.verified) {
        await onEvent('verifier.failed', { stepIndex: state.toolCallCount, tool: execution.call.tool, evidence: verification?.evidence || null });
        throw Object.assign(new Error(`The verifier could not confirm the result from ${execution.call.tool}.`), { code: 'verification_failed' });
      }
      result = { step: state.toolCallCount, tool: execution.call.tool, output: execution.output, evidence: verification.evidence };
      await onEvent('verifier.passed', { stepIndex: state.toolCallCount, tool: execution.call.tool, evidence: verification.evidence });
    }
    const results = [...state.toolResults, result];
    const nextCursor = state.callCursor + 1;
    const toolContent = execution.output?.sourceFailed
      ? { error: execution.output.error, source: execution.output.url, httpStatus: execution.output.httpStatus, instruction: 'This source could not be opened; continue with another allowed public source if useful.' }
      : { output: execution.output, verifiedEvidence: result.evidence };
    await onVerifiedTool({ result, results, nextStepIndex: state.toolCallCount + 1 });
    await onEvent('agent.tool.verified', { stepIndex: state.toolCallCount, tool: execution.call.tool, skipped: result.skipped === true });
    return {
      messages: [{ role: 'tool', tool_call_id: execution.call.id, content: contentForTool(toolContent) }],
      toolResults: results,
      toolCallCount: state.toolCallCount + 1,
      callCursor: nextCursor,
      authorizedCall: null,
      lastExecution: null,
    };
  };

  const finalize = async (state) => {
    const finalAnswer = String(state.finalAnswer || '').trim();
    if (!finalAnswer) throw new Error('The task cannot complete without a final answer.');
    if (validateOutcome) await validateOutcome({ answer: finalAnswer, steps: state.toolResults });
    await onEvent('agent.answer.completed', { characterCount: finalAnswer.length, sourceCount: state.toolResults.filter((item) => !item.skipped).length });
    return { finalAnswer, status: 'completed' };
  };

  return new StateGraph(TaskState)
    .addNode('decision_agent', decideRoute)
    .addNode('agent', agent)
    .addNode('authorize', authorize)
    .addNode('execute', execute)
    .addNode('verify', verify)
    .addNode('finalize', finalize)
    .addEdge(START, 'decision_agent')
    .addEdge('decision_agent', 'agent')
    .addConditionalEdges('agent', routeAfterAgent, { authorize: 'authorize', finalize: 'finalize', [END]: END })
    .addEdge('authorize', 'execute')
    .addEdge('execute', 'verify')
    .addConditionalEdges('verify', routeAfterVerify, { authorize: 'authorize', agent: 'agent' })
    .addEdge('finalize', END)
    .compile({ checkpointer });
}

export { Command };
