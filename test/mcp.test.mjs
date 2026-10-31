import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { validateMcpArguments } from 'solari-crew-core';
import { callMcpTool, createPinnedMcpLookup, dispatchMcpTool, updateMcpTask, validateMcpEndpoint, verifyMcpToolResult } from '../backend/lib/mcp.mjs';

const testDirectory = mkdtempSync(join(tmpdir(), 'crewos-mcp-'));
const envKeys = ['NODE_ENV', 'DATABASE_URL', 'DATABASE_FILE', 'NEON_AUTH_BASE_URL', 'APP_ORIGIN', 'MCP_VERIFIER_MODULE'];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys) delete process.env[key];
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.DATABASE_FILE = join(testDirectory, 'mcp.sqlite');
process.env.NEON_AUTH_BASE_URL = '';
process.env.APP_ORIGIN = 'http://127.0.0.1:4173';
const testVerifierPath = join(testDirectory, 'trusted-test-verifier.mjs');
writeFileSync(testVerifierPath, 'export function canVerifyMcpPostcondition(context) { return context?.tool?.name === "lookup_record" && context?.connection?.id === "mcp_tasks_test"; } export function verifyMcpPostcondition(context) { return { verified: true, evidence: { testFixture: true, tool: context.tool.name } }; }');
process.env.MCP_VERIFIER_MODULE = testVerifierPath;

const { handleHttpRequest, handleMcp } = await import('../backend/server.mjs');
const { closeDatabase, get: getDb, run: runDb } = await import('../backend/lib/db.mjs');

after(async () => {
  await closeDatabase();
  rmSync(testDirectory, { recursive: true, force: true });
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

function mockResponse() {
  const headers = new Map();
  return {
    headersSent: false,
    statusCode: 0,
    body: '',
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    writeHead(status, values = {}) { this.statusCode = status; for (const [name, value] of Object.entries(values)) this.setHeader(name, value); this.headersSent = true; },
    end(body = '') { this.body = String(body); this.headersSent = true; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

async function signup() {
  const body = Buffer.from(JSON.stringify({ name: 'MCP Test Manager', email: 'mcp-manager@example.test', password: 'manager-password-123', organization: 'MCP Tasks Test' }));
  const req = Readable.from([body]);
  req.method = 'POST';
  req.url = '/api/auth/signup';
  req.headers = { host: '127.0.0.1:4173', origin: process.env.APP_ORIGIN, 'content-type': 'application/json', 'content-length': String(body.length) };
  req.socket = { encrypted: false, remoteAddress: '127.0.0.1' };
  const res = mockResponse();
  await handleHttpRequest(req, res);
  assert.equal(res.statusCode, 201, res.body);
  const cookie = res.getHeader?.('set-cookie');
  return { ...res.json(), cookie };
}

test('MCP gateway validates nested tool arguments and schema constraints', () => {
  const schema = {
    type: 'object',
    required: ['case'],
    additionalProperties: false,
    properties: {
      case: { type: 'string', minLength: 3 },
      amount: { type: 'number', exclusiveMinimum: 0, maximum: 500 },
      tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      mode: { enum: [{ action: 'review' }, { action: 'close' }] },
    },
  };

  assert.doesNotThrow(() => validateMcpArguments(schema, {
    case: 'CASE-1', amount: 25, tags: ['urgent', 'customer'], mode: { action: 'review' },
  }));
  assert.throws(() => validateMcpArguments(schema, { amount: 25 }), /missing required field case/);
  assert.throws(() => validateMcpArguments(schema, { case: 'ok', amount: 0 }), /too short|exclusive minimum/);
  assert.throws(() => validateMcpArguments(schema, { case: 'CASE-1', extra: true }), /unsupported field extra/);
  assert.throws(() => validateMcpArguments(schema, { case: 'CASE-1', tags: ['same', 'same'] }), /unique items/);
  assert.throws(() => validateMcpArguments(schema, { case: 'CASE-1', mode: { action: 'delete' } }), /allowed values/);
});

test('MCP gateway rejects malformed or unsupported remote schemas', () => {
  assert.throws(() => validateMcpArguments({ type: 'object', properties: 'all' }, {}), /supported object input schemas/);
  assert.throws(() => validateMcpArguments({ type: 'object', required: 'token' }, {}), /supported object input schemas/);
  assert.throws(() => validateMcpArguments({ type: 'object', properties: { email: { type: 'string', format: 'email' } } }, { email: 'x' }), /supported object input schemas/);
  assert.throws(() => validateMcpArguments({ type: 'string' }, {}), /supported object input schemas/);
});

test('external MCP actions are blocked before dispatch without a local verifier', async () => {
  let dispatched = false;
  await assert.rejects(dispatchMcpTool(async () => {
    dispatched = true;
    return { ok: true };
  }), /No request was sent/);
  assert.equal(dispatched, false);

  const schema = { type: 'object', properties: {}, additionalProperties: false };
  await assert.rejects(callMcpTool('https://mcp.example.test', null, 'write_record', {}, schema), /No request was sent/);
  await assert.rejects(updateMcpTask('https://mcp.example.test', null, { taskId: 'task_test' }, { approved: true }), /No request was sent/);
});

test('external MCP dispatch requires the configured verifier to support that exact action', async () => {
  let dispatches = 0;
  const verifier = { canVerifyMcpPostcondition: ({ tool }) => tool.name === 'create_record' };
  const handler = async () => { dispatches++; return { ok: true }; };
  await assert.rejects(dispatchMcpTool(handler, verifier, { tool: { name: 'delete_record' } }), /No request was sent/);
  assert.equal(dispatches, 0);
  assert.deepEqual(await dispatchMcpTool(handler, verifier, { tool: { name: 'create_record' } }), { ok: true });
  assert.equal(dispatches, 1);
});

test('MCP results require a local independent verifier, regardless of remote read-only hints', async () => {
  const result = { ok: true, content: [{ type: 'text', text: 'record 42' }] };
  assert.equal((await verifyMcpToolResult(result)).verified, false);
  assert.equal((await verifyMcpToolResult(result, { readOnly: true })).verified, false);
  assert.equal((await verifyMcpToolResult({ ok: false, content: [] }, async () => ({ verified: true }))).verified, false);

  const independentlyVerified = await verifyMcpToolResult(result, async () => ({
    verified: true,
    evidence: { source: 'local-read-back', recordId: 'record-42' },
  }));
  assert.equal(independentlyVerified.verified, true);
  assert.equal(independentlyVerified.evidence.source, 'local-read-back');

  const unconfirmed = await verifyMcpToolResult(result, async () => ({ verified: false }));
  assert.equal(unconfirmed.verified, false);
  const writeResult = await verifyMcpToolResult(result);
  assert.equal(writeResult.verified, false);
  assert.match(writeResult.evidence.reason, /local independent postcondition verifier/);
});

test('MCP endpoint validation rejects literal loopback hosts', async () => {
  await assert.rejects(validateMcpEndpoint('https://127.0.0.1/mcp'), /public IP addresses/);
  await assert.rejects(validateMcpEndpoint('https://[::1]/mcp'), /public IP addresses/);
  await assert.rejects(validateMcpEndpoint('http://203.0.113.8/mcp'), /public HTTPS host/);
});

test('MCP HTTPS lookup uses only the addresses that passed the public-IP check', async () => {
  const lookup = createPinnedMcpLookup([
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
  ]);
  await new Promise((resolve, reject) => lookup('rebound.example', { family: 4 }, (error, address, family) => {
    if (error) return reject(error);
    assert.equal(address, '93.184.216.34');
    assert.equal(family, 4);
    resolve();
  }));
  await new Promise((resolve, reject) => lookup('rebound.example', { all: true }, (error, addresses) => {
    if (error) return reject(error);
    assert.deepEqual(addresses, [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
    ]);
    resolve();
  }));
  assert.throws(() => createPinnedMcpLookup([{ address: '127.0.0.1' }]), /public IP addresses/);
});

test('inbound MCP tasks/update forwards external input before resuming its workflow', async () => {
  const account = await signup();
  const { user, organization } = account;
  const context = { user, org: organization };
  const employeeId = 'emp_mcp_tasks_test';
  const connectionId = 'mcp_tasks_test';
  const workflowId = 'task_local_mcp_test';
  const timestamp = new Date().toISOString();
  const tool = { name: 'lookup_record', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, readOnly: true };
  const externalInputRequests = { customer_reference: { description: 'Provide the customer reference.' } };
  const inputResponses = { customer_reference: { reference: 'CASE-481' } };

  await runDb('INSERT INTO employees(id,org_id,name,title,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', employeeId, organization.id, 'MCP Workflow Employee', 'Records Analyst', 'active', timestamp, timestamp);
  await runDb('INSERT INTO mcp_connections(id,org_id,name,endpoint,token_ciphertext,tools,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', connectionId, organization.id, 'Test MCP', 'https://mcp.example.test/mcp', null, JSON.stringify([tool]), 'connected', user.id, timestamp, timestamp);
  await runDb('INSERT INTO workflows(id,org_id,employee_id,created_by,goal,status,plan,step_index,input_requests,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', workflowId, organization.id, employeeId, user.id, 'Look up the record', 'input_required', JSON.stringify([{ tool: `mcp.${connectionId}.${tool.name}`, input: { accountId: 'acct-1' }, expectation: 'Confirm the matching record.' }]), 0, JSON.stringify({ 'mcp-0': { method: 'mcp.tasks/update', params: { taskId: 'task_upstream_test', inputRequests: externalInputRequests } } }), timestamp, timestamp);
  await runDb('INSERT INTO tool_runs(id,org_id,workflow_id,step_index,tool,input,output,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)', 'run_mcp_tasks_test', organization.id, workflowId, 0, `mcp.${connectionId}.${tool.name}`, JSON.stringify({ accountId: 'acct-1' }), JSON.stringify({ mcpTask: { taskId: 'task_upstream_test', sessionId: 'session_test', protocolVersion: '2026-07-28', status: 'input_required', pollIntervalMs: 1500, inputRequests: externalInputRequests } }), 'started', timestamp);

  const forwarded = [];
  const runUpdate = async (...args) => {
    const [, , , , , verifier, verifierContext] = args;
    assert.equal(await verifier.canVerifyMcpPostcondition(verifierContext), true);
    await dispatchMcpTool(async () => {
      forwarded.push(args);
      return { accepted: true };
    }, verifier, verifierContext);
  };
  const headers = { 'mcp-method': 'tasks/update', 'mcp-name': workflowId };
  const body = (responses) => ({
    jsonrpc: '2.0', id: 7, method: 'tasks/update',
    params: { taskId: workflowId, inputResponses: responses, _meta: { 'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/tasks': {} } } } },
  });
  const invalidResponse = mockResponse();
  await handleMcp(body({ unexpected: { value: 'no' } }), context, organization, invalidResponse, headers, runUpdate, () => {});
  assert.equal(invalidResponse.json().error.code, -32602);
  assert.equal(forwarded.length, 0);

  const response = mockResponse();
  await handleMcp(body(inputResponses), context, organization, response, headers, runUpdate, () => {});
  assert.deepEqual(response.json().result, { resultType: 'complete' });
  assert.deepEqual(forwarded.map((args) => args[3]), [inputResponses]);

  const workflow = await getDb('SELECT status,input_requests,input_responses FROM workflows WHERE id=?', workflowId);
  const toolRun = await getDb('SELECT status,output FROM tool_runs WHERE workflow_id=? AND step_index=0', workflowId);
  assert.equal(workflow.status, 'queued');
  assert.deepEqual(JSON.parse(workflow.input_requests), {});
  assert.deepEqual(JSON.parse(workflow.input_responses)['mcp-0'], {
    approved: true, reviewedBy: user.id, reviewedAt: JSON.parse(workflow.input_responses)['mcp-0'].reviewedAt,
    responseKeys: ['customer_reference'],
  });
  assert.equal(toolRun.status, 'retry_wait');
  const taskState = JSON.parse(toolRun.output).mcpTask;
  assert.equal(taskState.taskId, 'task_upstream_test');
  assert.equal(taskState.status, 'working');
  assert.equal(Object.hasOwn(taskState, 'inputRequests'), false);
});
