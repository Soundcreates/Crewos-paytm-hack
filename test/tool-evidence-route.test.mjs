import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'crewos-tool-evidence-'));
const envKeys = ['NODE_ENV', 'DATABASE_URL', 'DATABASE_FILE', 'NEON_AUTH_BASE_URL', 'APP_ORIGIN', 'APP_MASTER_KEY', 'MCP_VERIFIER_MODULE', 'REQUEST_TRACE'];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys) delete process.env[key];
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: '',
  DATABASE_FILE: join(directory, 'tool-evidence.sqlite'),
  NEON_AUTH_BASE_URL: '',
  APP_ORIGIN: 'http://127.0.0.1:4173',
  APP_MASTER_KEY: 'offline-tool-evidence-test-key',
  REQUEST_TRACE: 'false',
});

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => { throw new Error(`Unexpected provider request in offline evidence test: ${String(input)}`); };
const { handleHttpRequest } = await import('../backend/server.mjs');
const { closeDatabase, run } = await import('../backend/lib/db.mjs');

after(async () => {
  await closeDatabase();
  rmSync(directory, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

function response() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: '',
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    writeHead(status, values = {}) { this.statusCode = status; for (const [name, value] of Object.entries(values)) this.setHeader(name, value); },
    end(body = '') { this.body = String(body); },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

async function request(method, path, { body, cookie } = {}) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = Readable.from(payload ? [payload] : []);
  req.method = method;
  req.url = path;
  req.headers = {
    host: '127.0.0.1:4173',
    ...(method !== 'GET' ? { origin: process.env.APP_ORIGIN } : {}),
    ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
    ...(cookie ? { cookie } : {}),
  };
  req.socket = { encrypted: false, remoteAddress: '127.0.0.1' };
  const res = response();
  await handleHttpRequest(req, res);
  return res;
}

function cookieFrom(res) {
  const cookies = res.getHeader('set-cookie');
  const session = (Array.isArray(cookies) ? cookies : [cookies]).find((value) => value?.startsWith('crewos_session='));
  assert.ok(session, 'signup should create a local session');
  return session.split(';', 1)[0];
}

test('sandbox replay endpoint returns command evidence, not video, and stays tenant scoped', async () => {
  const signup = await request('POST', '/api/auth/signup', {
    body: { name: 'Evidence Manager', email: 'evidence-manager@example.test', password: 'manager-password-123', organization: 'Evidence Workspace' },
  });
  assert.equal(signup.statusCode, 201, signup.body);
  const managerCookie = cookieFrom(signup);
  const orgId = signup.json().organization.id;
  const createdAt = new Date().toISOString();
  const input = { message: 'safe fixture output' };
  const output = { exitCode: 0, stdout: 'safe fixture output\n', stderr: '' };
  await run(
    'INSERT INTO tool_runs(id,org_id,tool,input,output,duration_ms,status,created_at) VALUES(?,?,?,?,?,?,?,?)',
    'sandbox-evidence-run', orgId, 'solari.sandbox.echo', JSON.stringify(input), JSON.stringify(output), 15, 'completed', createdAt,
  );

  const evidence = await request('GET', '/api/tool-runs/sandbox-evidence-run/replay', { cookie: managerCookie });
  assert.equal(evidence.statusCode, 200, evidence.body);
  assert.deepEqual(evidence.json(), {
    type: 'tool-evidence',
    tool: 'solari.sandbox.echo',
    status: 'completed',
    input,
    output,
    durationMs: 15,
    createdAt,
    replay: 'This headless or active command is available as audited input/output evidence.',
  });
  assert.equal(evidence.getHeader('location'), undefined, 'headless sandbox evidence must not redirect to a video replay');

  const failedOutput = { exitCode: 1, stdout: '', stderr: 'fixture command failed' };
  await run(
    'INSERT INTO tool_runs(id,org_id,tool,input,output,duration_ms,status,created_at) VALUES(?,?,?,?,?,?,?,?)',
    'sandbox-failed-evidence-run', orgId, 'solari.sandbox.echo', JSON.stringify(input), JSON.stringify(failedOutput), 19, 'failed', createdAt,
  );
  const failedEvidence = await request('GET', '/api/tool-runs/sandbox-failed-evidence-run/replay', { cookie: managerCookie });
  assert.equal(failedEvidence.statusCode, 200, failedEvidence.body);
  assert.equal(failedEvidence.json().status, 'failed');
  assert.deepEqual(failedEvidence.json().output, failedOutput);
  assert.equal(failedEvidence.getHeader('location'), undefined);

  const otherSignup = await request('POST', '/api/auth/signup', {
    body: { name: 'Other Manager', email: 'other-evidence-manager@example.test', password: 'manager-password-456', organization: 'Other Evidence Workspace' },
  });
  assert.equal(otherSignup.statusCode, 201, otherSignup.body);
  const otherCookie = cookieFrom(otherSignup);
  const crossTenant = await request('GET', '/api/tool-runs/sandbox-evidence-run/replay', { cookie: otherCookie });
  assert.equal(crossTenant.statusCode, 404, crossTenant.body);
});
