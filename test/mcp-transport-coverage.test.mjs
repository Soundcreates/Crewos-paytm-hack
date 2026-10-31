import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import https from 'node:https';
import dnsPromises from 'node:dns/promises';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import {
  callMcpTool,
  cancelMcpTask,
  createPinnedMcpLookup,
  discoverMcpTools,
  updateMcpTask,
  validateMcpEndpoint,
  verifyMcpToolResult,
} from '../backend/lib/mcp.mjs';

const endpoint = 'https://93.184.216.34/mcp';
const token = 'mock-token';
const protocolVersion = '2026-07-28';
const schema = { type: 'object', properties: {}, additionalProperties: false };

function installTransport(t, respond) {
  const originalRequest = https.request;
  const calls = [];
  https.request = (url, options, callback) => {
    const request = new EventEmitter();
    request.end = (body) => {
      const call = { url: String(url), options, body: String(body), message: JSON.parse(String(body)) };
      calls.push(call);
      Promise.resolve().then(async () => {
        try {
          const result = await respond(call, calls.length - 1);
          if (result?.error) {
            request.emit('error', result.error);
            return;
          }
          const chunks = result?.chunks || (result?.body ? [Buffer.from(result.body)] : []);
          const response = Readable.from(chunks);
          response.statusCode = result?.statusCode ?? 200;
          response.headers = result?.headers ?? { 'content-type': 'application/json' };
          callback(response);
        } catch (error) {
          request.emit('error', error);
        }
      });
    };
    return request;
  };
  syncBuiltinESMExports();
  t.after(() => {
    https.request = originalRequest;
    syncBuiltinESMExports();
  });
  return calls;
}

function rpc(call, result, headers = {}) {
  return {
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: call.message.id, result }),
  };
}

function verifier() {
  return { canVerifyMcpPostcondition: () => true };
}

test('discovery paginates, filters unsafe or duplicate tools, and carries auth/session headers', async (t) => {
  const audit = [];
  const calls = installTransport(t, (call) => {
    if (call.message.method === 'initialize') {
      return rpc(call, { protocolVersion, capabilities: { tools: {} } }, { 'mcp-session-id': 'session-1' });
    }
    if (call.message.method === 'notifications/initialized') return { statusCode: 202 };
    if (call.message.method === 'tools/list' && !call.message.params.cursor) {
      return rpc(call, {
        tools: [
          null,
          { name: 'bad name', inputSchema: schema },
          { name: 'unsupported', inputSchema: { type: 'string' } },
          { name: 'lookup_record', description: 'Read a record', inputSchema: schema, annotations: { readOnlyHint: true } },
        ],
        nextCursor: 'page-2',
      });
    }
    if (call.message.method === 'tools/list') {
      return rpc(call, {
        tools: [
          { name: 'lookup_record', inputSchema: schema },
          { name: 'create-record', inputSchema: schema, description: 'Create a record' },
        ],
      });
    }
    throw new Error(`Unexpected method ${call.message.method}`);
  });

  const tools = await discoverMcpTools(endpoint, token, (...event) => audit.push(event));
  assert.deepEqual(tools, [
    { name: 'lookup_record', description: 'Read a record', inputSchema: schema, readOnly: true },
    { name: 'create-record', description: 'Create a record', inputSchema: schema, readOnly: false },
  ]);
  assert.deepEqual(calls.map(({ message }) => message.method), [
    'initialize', 'notifications/initialized', 'tools/list', 'tools/list',
  ]);
  assert.equal(calls[0].options.headers.authorization, `Bearer ${token}`);
  assert.equal(calls[0].options.headers.accept, 'application/json, text/event-stream');
  assert.equal(calls[0].options.headers['mcp-protocol-version'], protocolVersion);
  assert.equal(calls[1].options.headers['mcp-session-id'], 'session-1');
  assert.equal(calls[3].options.headers['mcp-session-id'], 'session-1');
  assert.equal(calls[3].message.params.cursor, 'page-2');
  assert.deepEqual(audit.filter(([kind]) => kind === 'request').map(([, method]) => method), calls.map(({ message }) => message.method));
  assert.deepEqual(audit.at(-1), ['response', 'tools/list', { toolCount: 2, hasNextPage: false }]);
});

test('tool calls validate dispatch, normalize results, and support server-sent event responses', async (t) => {
  const calls = installTransport(t, (call) => {
    if (call.message.method === 'initialize') {
      return rpc(call, { protocolVersion, capabilities: { tools: {} } });
    }
    if (call.message.method === 'notifications/initialized') return { statusCode: 202 };
    assert.equal(call.message.method, 'tools/call');
    assert.equal(call.options.headers.authorization, `Bearer ${token}`);
    assert.equal(call.message.params.name, 'lookup_record');
    assert.deepEqual(call.message.params.arguments, {});
    return {
      headers: { 'content-type': 'text/event-stream' },
      body: `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: call.message.id, result: { content: [{ type: 'text', text: 'Found it' }], structuredContent: { id: 'record-1' } } })}\n\n`,
    };
  });

  const result = await callMcpTool(endpoint, token, 'lookup_record', {}, schema, null, async () => {}, undefined, verifier(), { tool: { name: 'lookup_record' } });
  assert.deepEqual(result, { ok: true, content: [{ type: 'text', text: 'Found it' }], structuredContent: { id: 'record-1' }, isError: false });
  assert.deepEqual(calls.map(({ message }) => message.method), ['initialize', 'notifications/initialized', 'tools/call']);
  assert.equal(calls[2].message.params._meta['io.modelcontextprotocol/clientCapabilities'].extensions['io.modelcontextprotocol/tasks'] !== undefined, true);
});

test('legacy protocol calls omit the Tasks extension and reject task results', async (t) => {
  let resultType = 'complete';
  const calls = installTransport(t, (call) => {
    if (call.message.method === 'initialize') return rpc(call, { protocolVersion: '2025-11-25', capabilities: {} });
    if (call.message.method === 'notifications/initialized') return { statusCode: 202 };
    if (call.message.method === 'tools/call') return rpc(call, resultType === 'task'
      ? { resultType: 'task', taskId: 'legacy-task' }
      : { content: [{ type: 'text', text: 'legacy result' }] });
    throw new Error(`Unexpected method ${call.message.method}`);
  });
  const invoke = () => callMcpTool(endpoint, null, 'lookup_record', {}, schema, null, async () => {}, undefined, verifier());

  assert.deepEqual(await invoke(), { ok: true, content: [{ type: 'text', text: 'legacy result' }], isError: false });
  const toolCall = calls.find(({ message }) => message.method === 'tools/call');
  assert.equal(Object.hasOwn(toolCall.message.params, '_meta'), false);
  assert.equal(Object.hasOwn(toolCall.options.headers, 'authorization'), false);
  assert.ok(toolCall.options.signal instanceof AbortSignal);

  resultType = 'task';
  await assert.rejects(invoke(), /without negotiated Tasks extension support/);
});

test('task calls persist task state, return input requests, and send update/cancel methods with task headers', async (t) => {
  const taskUpdates = [];
  const calls = installTransport(t, (call) => {
    if (call.message.method === 'initialize') return rpc(call, { protocolVersion, capabilities: { tasks: {} } }, { 'mcp-session-id': 'task-session' });
    if (call.message.method === 'notifications/initialized') return { statusCode: 202 };
    if (call.message.method === 'tools/call') return rpc(call, { resultType: 'task', taskId: 'task-7', pollIntervalMs: 250 });
    if (call.message.method === 'tasks/get') return rpc(call, {
      taskId: 'task-7', status: 'input_required',
      inputRequests: { approval: { description: 'Approve the action.' } },
    });
    if (call.message.method === 'tasks/update') return rpc(call, { resultType: 'complete' });
    if (call.message.method === 'tasks/cancel') return rpc(call, { resultType: 'cancelled' });
    throw new Error(`Unexpected method ${call.message.method}`);
  });
  const taskResult = await callMcpTool(
    endpoint, token, 'write_record', {}, schema, null,
    async (state) => taskUpdates.push(state), undefined, verifier(), { tool: { name: 'write_record' } },
  );
  assert.equal(taskResult.mcpTask.taskId, 'task-7');
  assert.equal(taskResult.mcpTask.sessionId, 'task-session');
  assert.equal(taskResult.mcpTask.status, 'input_required');
  assert.deepEqual(taskResult.inputRequired, { approval: { description: 'Approve the action.' } });
  assert.equal(taskUpdates[0].taskId, 'task-7');
  assert.equal(taskUpdates.at(-1).status, 'input_required');

  const savedState = { taskId: 'task-7', sessionId: 'task-session', protocolVersion, status: 'input_required' };
  const updated = await updateMcpTask(endpoint, token, savedState, { approval: { approved: true } }, undefined, verifier(), { tool: { name: 'write_record' } });
  assert.deepEqual(updated, { resultType: 'complete' });
  const cancelled = await cancelMcpTask(endpoint, token, savedState);
  assert.deepEqual(cancelled, { resultType: 'cancelled' });

  const updateCall = calls.find(({ message }) => message.method === 'tasks/update');
  const cancelCall = calls.find(({ message }) => message.method === 'tasks/cancel');
  for (const call of [updateCall, cancelCall]) {
    assert.equal(call.options.headers.authorization, `Bearer ${token}`);
    assert.equal(call.options.headers['mcp-session-id'], 'task-session');
    assert.equal(call.options.headers['mcp-method'], call.message.method);
    assert.equal(call.options.headers['mcp-name'], 'task-7');
    assert.equal(call.message.params._meta['io.modelcontextprotocol/clientCapabilities'].extensions['io.modelcontextprotocol/tasks'] !== undefined, true);
  }
  assert.deepEqual(updateCall.message.params.inputResponses, { approval: { approved: true } });
});

test('task polling resumes saved state and surfaces completed, failed, cancelled, and transient outcomes', async (t) => {
  let status = 'completed';
  let completionPolls = 0;
  const calls = installTransport(t, (call) => {
    assert.equal(call.message.method, 'tasks/get');
    if (status === 'transient') return { error: new Error('temporary connection failure') };
    if (status === 'failed') return rpc(call, { taskId: 'task-8', status, error: { message: 'remote failure' } });
    if (status === 'cancelled') return rpc(call, { taskId: 'task-8', status });
    if (completionPolls++ === 0) return rpc(call, { taskId: 'task-8', status: 'working', pollIntervalMs: 250 });
    return rpc(call, { taskId: 'task-8', status, result: { content: [{ type: 'text', text: 'done' }] } });
  });
  const savedState = { taskId: 'task-8', sessionId: 'saved-session', protocolVersion, pollIntervalMs: 250 };
  const invoke = () => callMcpTool(endpoint, token, 'lookup_record', {}, schema, savedState, async () => {}, undefined, verifier(), { tool: { name: 'lookup_record' } });

  assert.deepEqual(await invoke(), { ok: true, content: [{ type: 'text', text: 'done' }], isError: false });
  status = 'failed';
  await assert.rejects(invoke(), /remote failure/);
  status = 'cancelled';
  await assert.rejects(invoke(), /was cancelled/);
  status = 'transient';
  const resumed = await invoke();
  assert.equal(resumed.mcpTask.pollFailures, 1);
  assert.equal(calls.every(({ options }) => options.headers['mcp-session-id'] === 'saved-session'), true);

  await assert.rejects(
    callMcpTool(endpoint, token, 'lookup_record', {}, schema, { ...savedState, pollFailures: 8 }, async () => {}, undefined, verifier()),
    (error) => error.code === 'mcp_task_poll_failed',
  );
});

test('transport reports HTTP, JSON-RPC, invalid response, and response-size failures', async (t) => {
  let mode = 'http';
  installTransport(t, (call) => {
    if (call.message.method === 'initialize') return rpc(call, { protocolVersion, capabilities: {} });
    if (call.message.method === 'notifications/initialized') return { statusCode: 202 };
    if (mode === 'http') return { statusCode: 503, body: 'unavailable' };
    if (mode === 'rpc') return { body: JSON.stringify({ jsonrpc: '2.0', id: call.message.id, error: { code: -32000, message: 'remote denied' } }) };
    if (mode === 'invalid') return { body: 'not json' };
    return { chunks: [Buffer.alloc(1024 * 1024 + 1, 65)] };
  });
  const discover = () => discoverMcpTools(endpoint, token);
  await assert.rejects(discover(), /HTTP 503/);
  mode = 'rpc';
  await assert.rejects(discover(), /remote denied/);
  mode = 'invalid';
  await assert.rejects(discover(), /invalid JSON-RPC response/);
  mode = 'large';
  await assert.rejects(discover(), /exceeded the 1 MB limit/);
});

test('endpoint validation reports DNS lookup failures without making network requests', async (t) => {
  const originalLookup = dnsPromises.lookup;
  dnsPromises.lookup = async () => { throw new Error('blocked test lookup'); };
  syncBuiltinESMExports();
  t.after(() => {
    dnsPromises.lookup = originalLookup;
    syncBuiltinESMExports();
  });

  await assert.rejects(validateMcpEndpoint('https://mcp.example.test/server'), /host could not be resolved/);
});

test('pinned transport rejects malformed address records', () => {
  assert.throws(() => createPinnedMcpLookup([{ address: 'not-an-ip-address' }]), /public IP addresses/);
});

test('tool result verification converts verifier exceptions into unverified evidence', async () => {
  const output = { ok: true, content: [{ type: 'text', text: 'remote result' }] };
  const result = await verifyMcpToolResult(output, async () => { throw new Error('verifier unavailable'); });
  assert.deepEqual(result, {
    verified: false,
    evidence: { result: output, reason: 'The local postcondition verifier failed.' },
  });
});
