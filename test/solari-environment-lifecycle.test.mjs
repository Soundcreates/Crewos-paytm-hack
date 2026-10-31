import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'crewos-environment-lifecycle-'));
const envKeys = ['NODE_ENV', 'DATABASE_URL', 'DATABASE_FILE', 'NEON_AUTH_BASE_URL', 'APP_ORIGIN', 'APP_MASTER_KEY', 'SOLARI_BASE_URL'];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys) delete process.env[key];
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.DATABASE_FILE = join(directory, 'environment-lifecycle.sqlite');
process.env.NEON_AUTH_BASE_URL = '';
process.env.APP_ORIGIN = 'http://127.0.0.1:4173';
process.env.APP_MASTER_KEY = 'offline-environment-test-master-key';
process.env.SOLARI_BASE_URL = 'https://solari.mock';

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => { throw new Error(`Unexpected external request in offline environment test: ${String(input)}`); };
const { handleHttpRequest } = await import('../backend/server.mjs');
const { closeDatabase, now, run: runDb } = await import('../backend/lib/db.mjs');
const { storeSecret } = await import('../backend/lib/secrets.mjs');

after(async () => {
  await closeDatabase();
  rmSync(directory, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
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
    writeHead(status, values = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(values)) this.setHeader(name, value);
      this.headersSent = true;
      return this;
    },
    end(body = '') { this.body = String(body); this.headersSent = true; },
    destroy() { this.destroyed = true; },
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
  const res = mockResponse();
  await handleHttpRequest(req, res);
  return res;
}

function sessionCookie(response) {
  const cookies = response.getHeader('set-cookie');
  const cookie = (Array.isArray(cookies) ? cookies : [cookies]).find((value) => value?.startsWith('crewos_session='));
  assert.ok(cookie, 'expected an app session cookie');
  return cookie.split(';', 1)[0];
}

test('sandbox and desktop snapshots, pause, resume, and restore stay manager and workspace scoped', async () => {
  const signup = await request('POST', '/api/auth/signup', {
    body: { name: 'Snapshot Owner', email: 'snapshot-owner@example.test', password: 'snapshot-password-123', organization: 'Snapshot Test' },
  });
  assert.equal(signup.statusCode, 201, signup.body);
  const cookie = sessionCookie(signup);
  const orgId = signup.json().organization.id;
  const userId = signup.json().user.id;
  await storeSecret(orgId, userId, 'solari', 'offline-solari-test-key');
  await runDb(
    'INSERT INTO environments(id,org_id,kind,provider_id,status,label,metadata,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    'env_snapshot_test', orgId, 'sandbox', 'sbx_snapshot_test', 'running', 'Snapshot test', '{}', userId, now(),
  );
  await runDb(
    'INSERT INTO environments(id,org_id,kind,provider_id,status,label,metadata,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    'env_desktop_snapshot_test', orgId, 'desktop', 'desk_snapshot_test', 'running', 'Desktop snapshot test', '{}', userId, now(),
  );

  const outsiderSignup = await request('POST', '/api/auth/signup', {
    body: { name: 'Other Owner', email: 'other-snapshot-owner@example.test', password: 'other-snapshot-password-123', organization: 'Other Snapshot Test' },
  });
  assert.equal(outsiderSignup.statusCode, 201, outsiderSignup.body);
  const outsiderCookie = sessionCookie(outsiderSignup);

  const calls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const method = options.method || 'GET';
    calls.push(`${method} ${url.pathname}`);
    const match = /^\/sandboxes\/(sbx_snapshot_test|desk_snapshot_test)\/(snapshots|pause|resume|revert)$/.exec(url.pathname);
    assert.ok(match, `Unexpected Solari request: ${method} ${url.pathname}`);
    assert.equal(method, 'POST');
    const [, providerId, action] = match;
    const payload = action === 'snapshots' ? { snapshotId: `snap_${providerId}` } : { ok: true };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const snapshot = await request('POST', '/api/environments/env_snapshot_test/snapshots', { cookie, body: { name: 'Before changes' } });
  assert.equal(snapshot.statusCode, 201, snapshot.body);
  assert.equal(snapshot.json().snapshotId, 'snap_sbx_snapshot_test');
  assert.equal(snapshot.json().name, 'Before changes');
  assert.equal(typeof snapshot.json().createdAt, 'string');
  const listed = await request('GET', '/api/environments', { cookie });
  assert.deepEqual(listed.json().find((environment) => environment.id === 'env_snapshot_test').snapshots, [snapshot.json()]);

  const paused = await request('POST', '/api/environments/env_snapshot_test/pause', { cookie, body: {} });
  assert.equal(paused.statusCode, 200, paused.body);
  assert.equal(paused.json().status, 'paused');
  const resumed = await request('POST', '/api/environments/env_snapshot_test/resume', { cookie, body: {} });
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.equal(resumed.json().status, 'running');
  const reverted = await request('POST', '/api/environments/env_snapshot_test/revert', { cookie, body: { snapshotId: 'snap_sbx_snapshot_test' } });
  assert.equal(reverted.statusCode, 200, reverted.body);

  const desktopSnapshot = await request('POST', '/api/environments/env_desktop_snapshot_test/snapshots', { cookie, body: { name: 'Desktop checkpoint' } });
  assert.equal(desktopSnapshot.statusCode, 201, desktopSnapshot.body);
  assert.equal(desktopSnapshot.json().snapshotId, 'snap_desk_snapshot_test');
  assert.equal((await request('POST', '/api/environments/env_desktop_snapshot_test/pause', { cookie, body: {} })).statusCode, 200);
  assert.equal((await request('POST', '/api/environments/env_desktop_snapshot_test/resume', { cookie, body: {} })).statusCode, 200);
  assert.equal((await request('POST', '/api/environments/env_desktop_snapshot_test/revert', { cookie, body: { snapshotId: 'snap_desk_snapshot_test' } })).statusCode, 200);

  assert.equal((await request('POST', '/api/environments/env_snapshot_test/revert', { cookie: outsiderCookie, body: { snapshotId: 'snap_sbx_snapshot_test' } })).statusCode, 404);
  assert.deepEqual(calls, [
    'POST /sandboxes/sbx_snapshot_test/snapshots',
    'POST /sandboxes/sbx_snapshot_test/pause',
    'POST /sandboxes/sbx_snapshot_test/resume',
    'POST /sandboxes/sbx_snapshot_test/revert',
    'POST /sandboxes/desk_snapshot_test/snapshots',
    'POST /sandboxes/desk_snapshot_test/pause',
    'POST /sandboxes/desk_snapshot_test/resume',
    'POST /sandboxes/desk_snapshot_test/revert',
  ]);
  assert.equal((await request('POST', '/api/environments/env_snapshot_test/revert', { cookie, body: { snapshotId: 'snap_from_another_workspace' } })).statusCode, 404);
});
