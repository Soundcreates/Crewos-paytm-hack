import { isSupportedInputSchema, validateMcpArguments } from 'solari-crew-core';
import { Buffer } from 'node:buffer';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';

const protocolVersion = '2026-07-28';
const responseLimit = 1024 * 1024;

type AuditFn = (phase: 'request' | 'response', method: string, summary: Record<string, unknown>) => Promise<void> | void;
type McpAddress = { address: string; family?: number };
type McpTaskState = {
  taskId?: string;
  sessionId?: string | null;
  protocolVersion?: string;
  pollIntervalMs?: number;
  pollFailures?: number;
  status?: string;
  inputRequests?: unknown;
};
type VerifierContext = unknown;
type Verifier = {
  canVerifyMcpPostcondition?: (context: VerifierContext) => unknown | Promise<unknown>;
} | null;

function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 88 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0) || a >= 224);
  }
  if (version === 6) {
    const first = Number.parseInt(address.split(':')[0] || '0', 16);
    const normalized = address.toLowerCase();
    return !normalized.startsWith('::ffff:') && !normalized.startsWith('2001:db8:') && !normalized.startsWith('2001:0:') && first >= 0x2000 && first <= 0x3fff;
  }
  return false;
}

async function resolveMcpEndpoint(value: unknown): Promise<{ url: string; addresses: McpAddress[] }> {
  let endpoint: URL;
  try { endpoint = new URL(String(value || '')); }
  catch { throw new Error('MCP endpoint must be a valid HTTPS URL.'); }
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) throw new Error('MCP endpoint must use a public HTTPS host and cannot contain URL credentials, query parameters, or a fragment.');
  let addresses: McpAddress[];
  if (isIP(hostname)) addresses = [{ address: hostname, family: isIP(hostname) }];
  else {
    try { addresses = await lookup(hostname, { all: true, verbatim: true }); }
    catch { throw new Error('MCP endpoint host could not be resolved.'); }
  }
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('MCP endpoint must resolve only to public IP addresses.');
  return { url: endpoint.toString(), addresses };
}

export async function validateMcpEndpoint(value: unknown): Promise<string> {
  return (await resolveMcpEndpoint(value)).url;
}

async function readResponse(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of response) {
    size += (value as Buffer).byteLength;
    if (size > responseLimit) throw new Error('MCP response exceeded the 1 MB limit.');
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createPinnedMcpLookup(addresses: McpAddress[]) {
  const checked = addresses.map(({ address }) => ({ address, family: isIP(address) }));
  if (!checked.length || checked.some(({ address }) => !isPublicAddress(address))) throw new Error('MCP endpoint must resolve only to public IP addresses.');
  return (_hostname: string, options: { all?: boolean; family?: number } | undefined, callback: (error: Error | null, address?: unknown, family?: number) => void) => {
    if (options?.all) return callback(null, checked);
    const address = checked.find((item) => !options?.family || item.family === options.family);
    if (!address) return callback(new Error('MCP endpoint has no validated address for this connection.'));
    return callback(null, address.address, address.family);
  };
}

function requestMcp(url: string, addresses: McpAddress[], headers: Record<string, string>, body: string): Promise<IncomingMessage> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(target, {
      method: 'POST', headers, servername: target.hostname.replace(/^\[|\]$/g, ''),
      signal: AbortSignal.timeout(20_000),
      lookup: createPinnedMcpLookup(addresses) as never,
    }, resolve);
    request.on('error', reject);
    request.end(body);
  });
}

function requestSummary(method: string, params: Record<string, unknown>): Record<string, unknown> {
  if (method === 'initialize') return { protocolVersion: params.protocolVersion };
  if (method === 'tools/list') return { cursor: Boolean(params.cursor) };
  if (method === 'tools/call') return { toolName: params.name };
  if (method.startsWith('tasks/')) return { taskId: params.taskId };
  return { notification: method.startsWith('notifications/') };
}
function responseSummary(method: string, result: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (method === 'initialize') return { protocolVersion: result?.protocolVersion };
  if (method === 'tools/list') return { toolCount: Array.isArray(result?.tools) ? (result as { tools: unknown[] }).tools.length : 0, hasNextPage: Boolean(result?.nextCursor) };
  if (method === 'tools/call') return { resultType: result?.resultType || 'complete', isError: result?.isError === true };
  if (method === 'tasks/get') return { taskId: result?.taskId, status: result?.status };
  if (method.startsWith('tasks/')) return { resultType: result?.resultType || 'complete' };
  return { accepted: true };
}

function parseResponse(text: string, contentType: string, id: number | undefined): unknown {
  const candidates = contentType.includes('text/event-stream')
    ? text.split(/\r?\n\r?\n/).map((event) => event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')).filter(Boolean)
    : [text];
  for (const candidate of candidates) {
    let value: unknown;
    try { value = JSON.parse(candidate); } catch { continue; }
    const messages = Array.isArray(value) ? value : [value];
    const match = messages.find((message) => (message as { id?: unknown })?.id === id) as { error?: { message?: unknown }; result?: unknown } | undefined;
    if (match) {
      if (match.error) throw new Error(String(match.error.message || 'MCP server returned an error.').slice(0, 500));
      return match.result;
    }
  }
  if (!text.trim()) return null;
  throw new Error('MCP server returned an invalid JSON-RPC response.');
}

type McpClient = {
  post: (method: string, params: Record<string, unknown>, notification?: boolean) => Promise<unknown>;
  readonly sessionId: string | null;
  protocolVersion: string | null;
  taskCapabilities: Record<string, unknown>;
};

async function createClient(endpoint: unknown, token: unknown, state: McpTaskState | null = null, onAudit: AuditFn = async () => {}): Promise<McpClient> {
  let sessionId: string | null = state?.sessionId || null;
  let negotiatedVersion: string | null = state?.protocolVersion || null;
  let requestId = 0;
  const post = async (method: string, params: Record<string, unknown>, notification = false): Promise<unknown> => {
    const id = notification ? undefined : ++requestId;
    const summary = requestSummary(method, params);
    await onAudit('request', method, summary);
    try {
      const { url, addresses } = await resolveMcpEndpoint(endpoint);
      const response = await requestMcp(url, addresses, {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': negotiatedVersion || protocolVersion,
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          ...(method.startsWith('tasks/') ? { 'mcp-method': method, 'mcp-name': String(params.taskId || '') } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        }, JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }));
      sessionId = (response.headers['mcp-session-id'] as string) || sessionId;
      const text = await readResponse(response);
      if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) throw new Error(`MCP server returned HTTP ${response.statusCode}.`);
      const result = notification ? null : parseResponse(text, String(response.headers['content-type'] || ''), id);
      await onAudit('response', method, responseSummary(method, result as Record<string, unknown> | null));
      return result;
    } catch (error) {
      await onAudit('response', method, { error: String((error as Error).message || 'MCP request failed.').slice(0, 200) });
      throw error;
    }
  };
  if (!state?.taskId) {
    const initialized = await post('initialize', { protocolVersion, capabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } }, clientInfo: { name: 'crewos', version: '0.1.0' } }) as { protocolVersion?: string; capabilities?: unknown } | null;
    if (!initialized?.protocolVersion || !initialized?.capabilities) throw new Error('MCP server returned an invalid initialize result.');
    if (![protocolVersion, '2025-11-25'].includes(initialized.protocolVersion)) throw new Error('MCP server selected an unsupported protocol version.');
    negotiatedVersion = initialized.protocolVersion;
    await post('notifications/initialized', {}, true);
  }
  const taskCapabilities = { 'io.modelcontextprotocol/clientCapabilities': { extensions: { 'io.modelcontextprotocol/tasks': {} } } };
  return { post, get sessionId() { return sessionId; }, protocolVersion: negotiatedVersion, taskCapabilities };
}

export type McpToolDescriptor = {
  name: string;
  description: string;
  inputSchema: unknown;
  readOnly: boolean;
};

export async function discoverMcpTools(endpoint: unknown, token: unknown, onAudit?: AuditFn): Promise<McpToolDescriptor[]> {
  const client = await createClient(endpoint, token, null, onAudit);
  const tools: McpToolDescriptor[] = [];
  let cursor: unknown;
  for (let page = 0; page < 10; page++) {
    const result = await client.post('tools/list', cursor ? { cursor } : {}) as { tools?: unknown[]; nextCursor?: unknown } | null;
    if (!Array.isArray(result?.tools)) throw new Error('MCP server returned an invalid tools/list result.');
    for (const toolValue of result.tools) {
      const tool = toolValue as { name?: unknown; inputSchema?: unknown; description?: unknown; annotations?: { readOnlyHint?: unknown } };
      if (!tool || typeof tool.name !== 'string' || !/^[A-Za-z0-9_.-]{1,50}$/.test(tool.name)) continue;
      const inputSchema = tool.inputSchema;
      const rootType = (inputSchema as { type?: unknown } | undefined)?.type;
      const objectSchema = rootType === undefined || rootType === 'object' || (Array.isArray(rootType) && rootType.includes('object'));
      if (!objectSchema || !isSupportedInputSchema(inputSchema) || JSON.stringify(inputSchema).length > 30000 || tools.some((item) => item.name === tool.name)) continue;
      tools.push({
        name: tool.name,
        description: String(tool.description || tool.name).slice(0, 1000),
        inputSchema,
        readOnly: tool.annotations?.readOnlyHint === true,
      });
      if (tools.length >= 300) break;
    }
    cursor = result.nextCursor;
    if (!cursor || tools.length >= 300) break;
  }
  return tools;
}

export async function verifyMcpToolResult(output: { ok?: boolean } | null | undefined, verifier: ((output: unknown) => unknown | Promise<unknown>) | null = null): Promise<{ verified: boolean; evidence: unknown }> {
  if (!output || output.ok === false) return { verified: false, evidence: output ?? { message: 'No result received.' } };
  if (typeof verifier !== 'function') return {
    verified: false,
    evidence: { result: output, reason: 'No local independent postcondition verifier is configured for this external MCP action.' },
  };
  try {
    const result = await verifier(output) as { verified?: boolean; evidence?: unknown } | null;
    return result?.verified === true
      ? { verified: true, evidence: result.evidence ?? { result: output } }
      : { verified: false, evidence: result?.evidence ?? { result: output, reason: 'The local postcondition verifier did not confirm this external MCP action.' } };
  } catch {
    return { verified: false, evidence: { result: output, reason: 'The local postcondition verifier failed.' } };
  }
}

export async function dispatchMcpTool<T>(handler: () => Promise<T>, verifier: Verifier = null, verifierContext: VerifierContext = null): Promise<T> {
  let supported = false;
  try { supported = await verifier?.canVerifyMcpPostcondition?.(verifierContext) === true; } catch {}
  if (!supported) throw new Error('External MCP tool dispatch is disabled until a local independent postcondition verifier is configured for this action. No request was sent.');
  return handler();
}

function normalizeToolResult(result: { content?: unknown; isError?: unknown; structuredContent?: unknown } | null | undefined): { ok: boolean; content: unknown; structuredContent?: unknown; isError: boolean } {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.content) || (result.isError !== undefined && typeof result.isError !== 'boolean')) throw new Error('MCP server returned an invalid tools/call result.');
  if (JSON.stringify({ content: result.content, structuredContent: result.structuredContent }).length > responseLimit) throw new Error('MCP tool result exceeded the 1 MB limit.');
  return { ok: result.isError !== true, content: result.content, ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}), isError: result.isError === true };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function updateMcpTask(endpoint: unknown, token: unknown, state: McpTaskState, inputResponses: unknown, onAudit?: AuditFn, verifier: Verifier = null, verifierContext: VerifierContext = null): Promise<unknown> {
  return dispatchMcpTool(async () => {
    const client = await createClient(endpoint, token, state, onAudit);
    return client.post('tasks/update', { taskId: state.taskId, inputResponses, _meta: client.taskCapabilities });
  }, verifier, verifierContext);
}
export async function cancelMcpTask(endpoint: unknown, token: unknown, state: McpTaskState, onAudit?: AuditFn): Promise<unknown> {
  const client = await createClient(endpoint, token, state, onAudit);
  return client.post('tasks/cancel', { taskId: state.taskId, _meta: client.taskCapabilities });
}

export async function callMcpTool(endpoint: unknown, token: unknown, toolName: string, input: unknown, schema: unknown, state: McpTaskState | null = null, onTaskState: (task: McpTaskState) => Promise<void> | void = async () => {}, onAudit?: AuditFn, verifier: Verifier = null, verifierContext: VerifierContext = null): Promise<unknown> {
  return dispatchMcpTool(() => callMcpToolUnchecked(endpoint, token, toolName, input, schema, state, onTaskState, onAudit), verifier, verifierContext);
}

async function callMcpToolUnchecked(endpoint: unknown, token: unknown, toolName: string, input: unknown, schema: unknown, state: McpTaskState | null = null, onTaskState: (task: McpTaskState) => Promise<void> | void = async () => {}, onAudit?: AuditFn): Promise<unknown> {
  validateMcpArguments(schema, input);
  const client = await createClient(endpoint, token, state, onAudit);
  let task: McpTaskState;
  if (state?.taskId) task = { ...state, status: 'working' };
  else {
    const result = await client.post('tools/call', { name: toolName, arguments: input, ...(client.protocolVersion === protocolVersion ? { _meta: client.taskCapabilities } : {}) }) as { resultType?: string; taskId?: string; pollIntervalMs?: number } | null;
    if (result?.resultType !== 'task') return normalizeToolResult(result as never);
    if (client.protocolVersion !== protocolVersion || typeof result.taskId !== 'string' || !result.taskId) throw new Error('MCP server returned a task without negotiated Tasks extension support.');
    task = { taskId: result.taskId, sessionId: client.sessionId, protocolVersion: client.protocolVersion, pollIntervalMs: result.pollIntervalMs || 1500 };
    await onTaskState(task);
  }

  const deadline = Date.now() + 25_000;
  while (true) {
    let current: { taskId?: string; status?: string; pollIntervalMs?: number; inputRequests?: unknown; result?: unknown; error?: { message?: unknown }; statusMessage?: unknown } | null;
    try { current = await client.post('tasks/get', { taskId: task.taskId, _meta: client.taskCapabilities }) as typeof current; }
    catch (error) {
      task = { ...task, pollFailures: (Number(task.pollFailures) || 0) + 1 };
      await onTaskState(task);
      if ((task.pollFailures ?? 0) > 8) {
        const failure = Object.assign(new Error('Could not resume the external MCP task after repeated connection failures.'), { code: 'mcp_task_poll_failed' });
        throw failure;
      }
      return { mcpTask: task };
    }
    if (!current || typeof current !== 'object' || current.taskId !== task.taskId || !['working', 'input_required', 'completed', 'failed', 'cancelled'].includes(String(current.status))) throw new Error('MCP server returned an invalid task status.');
    task = { ...task, status: current.status, pollFailures: 0, pollIntervalMs: current.pollIntervalMs || task.pollIntervalMs || 1500, ...(current.inputRequests ? { inputRequests: current.inputRequests } : {}) };
    await onTaskState(task);
    if (current.status === 'input_required') return { mcpTask: task, inputRequired: current.inputRequests || {} };
    if (current.status === 'completed') return normalizeToolResult(current.result as never);
    if (current.status === 'failed') throw new Error(String(current.error?.message || current.statusMessage || 'External MCP task failed.').slice(0, 500));
    if (current.status === 'cancelled') throw new Error('External MCP task was cancelled.');
    if (Date.now() >= deadline) return { mcpTask: task };
    await delay(Math.max(250, Math.min(10_000, Number(task.pollIntervalMs) || 1500)));
  }
}
