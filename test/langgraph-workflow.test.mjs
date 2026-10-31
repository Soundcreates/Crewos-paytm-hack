import assert from 'node:assert/strict';
import { MemorySaver } from '@langchain/langgraph';
import test from 'node:test';
import { buildEmployeeToolRegistry, validateEmployeeToolInput } from '../backend/workflows/langgraph/tool-registry.mjs';
import { fallbackTaskRoute } from '../backend/workflows/langgraph/decision-agent.mjs';
import { Command, createReActWorkflowGraph } from '../backend/workflows/langgraph/graph.mjs';

const workflow = { id: 'wf_graph_test', input_requests: {}, input_responses: {} };

function registryFor(...keys) {
  const catalog = keys.map((key) => ({ key, label: key, description: key, mcpTool: null }));
  return buildEmployeeToolRegistry(catalog, keys);
}

function graphOptions(overrides = {}) {
  return {
    registry: registryFor('solari.sandbox.echo'),
    modelCall: async () => ({ role: 'assistant', content: 'Done.' }),
    authorizeTool: async () => ({ decision: 'ALLOW' }),
    executeTool: async () => ({ ok: true }),
    verifyTool: async () => ({ verified: true, evidence: { confirmed: true } }),
    onProposedTool: async () => {},
    onVerifiedTool: async () => {},
    onEvent: async () => {},
    ...overrides,
  };
}

test('employee registry exposes only granted supported tools and validates the full input schema', () => {
  const registry = buildEmployeeToolRegistry(
    [
      { key: 'tinyfish.search', label: 'Search the web', mcpTool: null },
      { key: 'solari.browser.open', label: 'Open browser', mcpTool: null },
      { key: 'solari.browser.interact', label: 'Interact', mcpTool: null },
      { key: 'payments.refund', label: 'Refund', mcpTool: null },
    ],
    ['solari.browser.open', 'solari.browser.interact'],
    { readOnlyResearch: true },
  );

  assert.deepEqual(registry.map((tool) => tool.key), ['tinyfish.search']);
  assert.notEqual(registry[0].openRouterTool.function.name, 'solari.browser.open');
  assert.doesNotThrow(() => validateEmployeeToolInput(registry[0], { query: 'market research' }));
  assert.throws(() => validateEmployeeToolInput(registry[0], { query: 'market research', bypass: true }), /unsupported field/i);
});

test('a Solari browser grant exposes TinyFish search while keeping Solari available for non-research browser work', () => {
  const registry = buildEmployeeToolRegistry(
    [
      { key: 'tinyfish.search', label: 'Search the web', mcpTool: null },
      { key: 'solari.browser.open', label: 'Open browser', mcpTool: null },
      { key: 'solari.browser.interact', label: 'Interact', mcpTool: null },
    ],
    ['solari.browser.open', 'solari.browser.interact'],
  );
  assert.deepEqual(registry.map((tool) => tool.key), ['tinyfish.search', 'solari.browser.open', 'solari.browser.interact']);
});

test('decision agent routes web research, interactive sites, and desktop requests to their runtime', () => {
  const routes = [
    { key: 'public_search', tools: ['tinyfish.search'] },
    { key: 'browser', tools: ['solari.browser.open', 'solari.browser.interact'] },
    { key: 'desktop', tools: ['solari.desktop.exec'] },
    { key: 'workspace_tools', tools: ['jira.create_issue'] },
  ];
  assert.deepEqual(fallbackTaskRoute('Research current market demand for AI fitness trackers', routes).routes, ['public_search']);
  assert.deepEqual(fallbackTaskRoute('Review and comment on a GitHub pull request', routes).routes, ['browser']);
  assert.deepEqual(fallbackTaskRoute('Run a command in the employee desktop VM', routes).routes, ['desktop']);
});

test('decision agent only exposes tools from the selected route to the ReAct agent', async () => {
  const registry = registryFor('tinyfish.search', 'solari.browser.open', 'solari.browser.interact');
  const graph = createReActWorkflowGraph(graphOptions({
    registry,
    routeTask: async () => ({ routes: ['public_search'], summary: 'Use public search.' }),
    modelCall: async (_messages, tools) => {
      assert.equal(tools.length, 1);
      assert.equal(tools[0].function.name, registry.find((tool) => tool.key === 'tinyfish.search').name);
      return { role: 'assistant', content: 'Here is the research summary.' };
    },
  }));
  const state = await graph.invoke({ messages: [{ role: 'user', content: 'Research public information.' }] });
  assert.deepEqual(state.taskRoute.routes, ['public_search']);
  assert.equal(state.status, 'completed');
});

test('ReAct graph can call multiple tools in sequence and then return its final answer', async () => {
  const saver = new MemorySaver();
  const registry = registryFor('solari.sandbox.echo', 'solari.browser.open');
  const executed = [];
  let modelTurns = 0;
  const modelCall = async (messages, tools) => {
    modelTurns += 1;
    const toolMessages = messages.filter((message) => message.role === 'tool');
    if (toolMessages.length === 2) return { role: 'assistant', content: 'Both checks succeeded.' };
    const tool = registry.find((item) => item.key === (toolMessages.length ? 'solari.sandbox.echo' : 'solari.browser.open'));
    assert.ok(tools.some((available) => available.function.name === tool.name));
    return {
      role: 'assistant', content: '',
      tool_calls: [{ id: `call_${toolMessages.length + 1}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.key === 'solari.browser.open' ? { url: 'https://example.com' } : { message: 'hello' }) } }],
    };
  };
  const graph = createReActWorkflowGraph(graphOptions({
    checkpointer: saver,
    registry,
    modelCall,
    executeTool: async (tool) => { executed.push(tool); return { ok: true, url: 'https://example.com' }; },
  }));
  const state = await graph.invoke({ messages: [{ role: 'user', content: 'Do two checks.' }] }, { configurable: { thread_id: 'wf_multi_tool' }, recursionLimit: 40 });

  assert.equal(state.status, 'completed');
  assert.equal(state.finalAnswer, 'Both checks succeeded.');
  assert.deepEqual(executed, ['solari.browser.open', 'solari.sandbox.echo']);
  assert.equal(state.toolResults.length, 2);
  assert.equal(modelTurns, 3);
});

test('policy denial rejects before a tool can run', async () => {
  let executions = 0;
  const registry = registryFor('solari.sandbox.echo');
  const graph = createReActWorkflowGraph(graphOptions({
    registry,
    modelCall: async () => ({ role: 'assistant', content: '', tool_calls: [{ id: 'call_denied', type: 'function', function: { name: registry[0].name, arguments: '{"message":"hello"}' } }] }),
    authorizeTool: async () => ({ decision: 'DENY', reason: 'Company policy' }),
    executeTool: async () => { executions += 1; return { ok: true }; },
  }));

  await assert.rejects(graph.invoke({ messages: [{ role: 'user', content: 'Run the check.' }] }), /Policy blocked/);
  assert.equal(executions, 0);
});

test('approval interrupt resumes from a checkpoint without repeating completed tool execution', async () => {
  const saver = new MemorySaver();
  const registry = registryFor('solari.sandbox.echo');
  const config = { configurable: { thread_id: 'wf_approval_resume', checkpoint_ns: 'crewos-react-v1' } };
  let executions = 0;
  let modelTurns = 0;
  const options = graphOptions({
    checkpointer: saver,
    registry,
    modelCall: async (messages) => {
      modelTurns += 1;
      if (messages.some((message) => message.role === 'tool')) return { role: 'assistant', content: 'Approved and completed.' };
      return { role: 'assistant', content: '', tool_calls: [{ id: 'call_approval', type: 'function', function: { name: registry[0].name, arguments: '{"message":"hello"}' } }] };
    },
    authorizeTool: async () => ({ decision: 'REQUIRE_APPROVAL', reason: 'Manager review' }),
    executeTool: async () => { executions += 1; return { ok: true }; },
  });
  const firstGraph = createReActWorkflowGraph(options);
  const paused = await firstGraph.invoke({ messages: [{ role: 'user', content: 'Run the check.' }] }, config);
  assert.equal(paused.__interrupt__?.[0]?.value?.kind, 'policy_approval');
  assert.equal(executions, 0);

  // Recompile with the same durable checkpointer to model a worker process restart.
  const resumedGraph = createReActWorkflowGraph(options);
  const completed = await resumedGraph.invoke(new Command({ resume: { approved: true, note: 'Reviewed' } }), config);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.finalAnswer, 'Approved and completed.');
  assert.equal(executions, 1);
  assert.equal(modelTurns, 2);
});

test('failed tool verification stops the graph and never returns a completed answer', async () => {
  const registry = registryFor('solari.sandbox.echo');
  const graph = createReActWorkflowGraph(graphOptions({
    registry,
    modelCall: async () => ({ role: 'assistant', content: '', tool_calls: [{ id: 'call_unverified', type: 'function', function: { name: registry[0].name, arguments: '{"message":"hello"}' } }] }),
    verifyTool: async () => ({ verified: false }),
  }));

  await assert.rejects(graph.invoke({ messages: [{ role: 'user', content: 'Run the check.' }] }), /verifier could not confirm/);
});
