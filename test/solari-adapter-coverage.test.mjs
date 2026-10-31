import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'crewos-solari-adapter-'));
const envKeys = ['NODE_ENV', 'DATABASE_URL', 'DATABASE_FILE', 'NEON_AUTH_BASE_URL', 'SOLARI_BASE_URL', 'SOLARI_BROWSER_BASE_URL'];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys) delete process.env[key];
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.DATABASE_FILE = join(directory, 'adapter.sqlite');
process.env.NEON_AUTH_BASE_URL = '';
process.env.SOLARI_BASE_URL = 'https://solari.mock';
process.env.SOLARI_BROWSER_BASE_URL = 'https://browser-solari.mock';

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;
const { all, closeDatabase, get, id, now, run } = await import('../backend/lib/db.mjs');
const {
  closeEnvironment,
  closeWorkflowBrowserSession,
  createEnvironmentSnapshot,
  createSolariEnvironment,
  createSolariProfile,
  deleteSolariProfile,
  getSolariDesktopStream,
  getSolariReplayUrl,
  getWorkflowBrowserFrame,
  listSolariProfiles,
  pauseEnvironment,
  readSolariUsageResponse,
  resumeEnvironment,
  revertEnvironmentSnapshot,
  runSolariTool,
} = await import('../backend/lib/solari.mjs');

const organizationId = 'org_solari_adapter';
const userId = 'user_solari_adapter';
const apiKey = 'offline-solari-adapter-key';

await run('INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)', organizationId, 'Solari adapter tests', now());
await run('INSERT INTO users(id,name,email,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)', userId, 'Adapter Owner', 'solari-adapter@example.test', 'salt', 'hash', now());
await run('INSERT INTO memberships(org_id,user_id,role,created_at) VALUES(?,?,?,?)', organizationId, userId, 'owner', now());

after(async () => {
  await closeDatabase();
  rmSync(directory, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
  if (originalWebSocket === undefined) delete globalThis.WebSocket;
  else globalThis.WebSocket = originalWebSocket;
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

async function withProvider(handler, callback) {
  const requests = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    const request = { url, method: options.method || 'GET', headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : undefined };
    requests.push(request);
    return handler(request);
  };
  try { return await callback(requests); }
  finally { globalThis.fetch = originalFetch; }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

async function addEnvironment(environmentId, kind, providerId, status = 'running') {
  await run('INSERT INTO environments(id,org_id,kind,provider_id,status,label,metadata,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    environmentId, organizationId, kind, providerId, status, environmentId, '{}', userId, now());
}

test('Solari profile list/create/delete keep workspace rows tied to the configured API key', async () => {
  await withProvider(({ url, method, headers, body }) => {
    assert.equal(url.origin, 'https://browser-solari.mock');
    assert.equal(headers.Authorization, `Bearer ${apiKey}`);
    if (method === 'GET' && url.pathname === '/profiles') return jsonResponse([{ id: 'provider-z', name: 'Zebra' }, { id: 'provider-a', name: '' }]);
    if (method === 'POST' && url.pathname === '/profiles') return jsonResponse({ id: 'provider-created' });
    if (method === 'DELETE' && url.pathname === '/profiles/provider-created') return new Response(null, { status: 204 });
    throw new Error(`Unexpected mocked Solari request: ${method} ${url.pathname} ${JSON.stringify(body)}`);
  }, async (requests) => {
    const listed = await listSolariProfiles(organizationId, apiKey);
    assert.deepEqual(listed.map(({ name }) => name), ['Browser profile', 'Zebra']);
    const saved = await all('SELECT id,provider_id,key_hash,name FROM solari_profiles WHERE org_id=? ORDER BY name', organizationId);
    assert.equal(saved.length, 2);
    assert.ok(saved.every((row) => row.key_hash.length === 64));
    await assert.rejects(deleteSolariProfile(organizationId, saved[0].id, 'another-api-key'), /different Solari key/);
    assert.equal((await listSolariProfiles(organizationId, apiKey)).length, 2, 'listing existing provider profiles updates instead of duplicating them');
    assert.equal((await all('SELECT id FROM solari_profiles WHERE org_id=?', organizationId)).length, 2);

    const created = await createSolariProfile(organizationId, userId, '  Support profile  ', apiKey);
    assert.ok(created.id);
    assert.equal(created.name, 'Support profile');
    assert.equal(requests.at(-1).body.name, 'Support profile');
    assert.equal((await get('SELECT created_by FROM solari_profiles WHERE id=?', created.id)).created_by, userId);

    await run('INSERT INTO employees(id,org_id,name,title,department,profile_id,state,avatar,x,y,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      'employee_using_profile', organizationId, 'Agent', 'Support', 'Support', created.id, 'active', 'A', 0.5, 0.5, now(), now());
    await assert.rejects(deleteSolariProfile(organizationId, created.id, apiKey), /Remove this profile from employee specs/);
    assert.equal(requests.filter(({ method }) => method === 'DELETE').length, 0);
    await run('DELETE FROM employees WHERE id=?', 'employee_using_profile');
    await deleteSolariProfile(organizationId, created.id, apiKey);
    assert.equal(await get('SELECT id FROM solari_profiles WHERE id=?', created.id), undefined);
    assert.equal(requests.at(-1).url.pathname, '/profiles/provider-created');
  });

  await assert.rejects(createSolariProfile(organizationId, userId, '  ', apiKey), /Enter a profile name/);
  await assert.rejects(listSolariProfiles(organizationId, ''), /Connect a Solari key/);
  await assert.rejects(deleteSolariProfile(organizationId, 'missing-profile', apiKey), /Solari profile not found/);
});

test('Solari environment creation, managed lifecycle, streams, replay, and stopping use mocked provider APIs', async () => {
  await withProvider(({ url, method, body }) => {
    if (method === 'POST' && url.pathname === '/sandboxes') return jsonResponse({ sandboxId: 'sbx-created', controlUrl: 'wss://solari.mock/control/sbx-created', expiresAt: 'later' });
    if (method === 'POST' && url.pathname === '/desktops') return jsonResponse({ sessionId: 'desktop-created', controlUrl: 'wss://solari.mock/control/desktop-created', streamUrl: 'wss://solari.mock/stream/desktop-created', expiresAt: 'later', recordingUrl: 'https://recording.mock/session.mp4' });
    if (method === 'POST' && url.pathname === '/sandboxes/sbx-running/snapshots') return jsonResponse({ snapshotId: 'snapshot-sbx' });
    if (method === 'POST' && url.pathname === '/sandboxes/sbx-running/pause') return jsonResponse({ ok: true });
    if (method === 'POST' && url.pathname === '/sandboxes/sbx-running/resume') return jsonResponse({ ok: true });
    if (method === 'POST' && url.pathname === '/sandboxes/sbx-running/revert') return jsonResponse({ ok: true });
    if (method === 'GET' && url.pathname === '/desktops/desktop-stream') return jsonResponse({ sessionId: 'desktop-stream', status: 'running' });
    if (method === 'GET' && url.pathname === '/sessions/session%3Areplay/replay-url') return jsonResponse({ url: 'https://replay.mock/capture.gz', expiresInSeconds: 120 });
    if (method === 'GET' && url.pathname === '/sandboxes/sbx-stop') return jsonResponse({ sandboxId: 'sbx-stop', kind: 'sandbox', status: 'running' });
    if (method === 'DELETE' && url.pathname === '/sandboxes/sbx-stop') return new Response(null, { status: 204 });
    if (method === 'DELETE' && url.pathname === '/desktops/desktop-stop') return new Response(null, { status: 204 });
    if (method === 'DELETE' && url.pathname === '/sessions/browser-stop') return new Response(null, { status: 204 });
    throw new Error(`Unexpected mocked Solari request: ${method} ${url.pathname} ${JSON.stringify(body)}`);
  }, async (requests) => {
    const sandbox = await createSolariEnvironment(organizationId, userId, 'sandbox', '  Build sandbox  ', apiKey);
    assert.deepEqual({ kind: sandbox.kind, providerId: sandbox.providerId, label: sandbox.label, status: sandbox.status }, { kind: 'sandbox', providerId: 'sbx-created', label: '  Build sandbox  ', status: 'running' });
    const storedSandbox = await get('SELECT metadata FROM environments WHERE id=?', sandbox.id);
    assert.equal(JSON.parse(storedSandbox.metadata).expiresAt, 'later');

    const desktop = await createSolariEnvironment(organizationId, userId, 'desktop', '', apiKey);
    assert.equal(desktop.providerId, 'desktop-created');
    assert.equal(desktop.label, 'desktop session');
    assert.equal(JSON.parse((await get('SELECT metadata FROM environments WHERE id=?', desktop.id)).metadata).recordingUrl, 'https://recording.mock/session.mp4');
    await assert.rejects(createSolariEnvironment(organizationId, userId, 'unknown', 'x', apiKey), /Environment type must be browser/);

    await addEnvironment('managed-sandbox', 'sandbox', 'sbx-running');
    const snapshot = await createEnvironmentSnapshot(organizationId, 'managed-sandbox', apiKey, 'Before changes');
    assert.deepEqual({ snapshotId: snapshot.snapshotId, name: snapshot.name }, { snapshotId: 'snapshot-sbx', name: 'Before changes' });
    assert.equal((await pauseEnvironment(organizationId, 'managed-sandbox', apiKey)).status, 'paused');
    assert.equal((await resumeEnvironment(organizationId, 'managed-sandbox', apiKey)).status, 'running');
    await revertEnvironmentSnapshot(organizationId, 'managed-sandbox', apiKey, snapshot.snapshotId);
    assert.deepEqual(requests.slice(2, 6).map(({ url }) => url.pathname), [
      '/sandboxes/sbx-running/snapshots', '/sandboxes/sbx-running/pause', '/sandboxes/sbx-running/resume', '/sandboxes/sbx-running/revert',
    ]);
    assert.equal((await pauseEnvironment(organizationId, 'managed-sandbox', apiKey)).status, 'paused');
    await assert.rejects(createEnvironmentSnapshot(organizationId, 'managed-sandbox', apiKey, 'no'), /Resume the environment/);
    await assert.rejects(revertEnvironmentSnapshot(organizationId, 'managed-sandbox', apiKey, snapshot.snapshotId), /Resume the environment/);
    await assert.rejects(pauseEnvironment(organizationId, 'managed-sandbox', apiKey), /Only running environments/);
    assert.equal((await resumeEnvironment(organizationId, 'managed-sandbox', apiKey)).status, 'running');
    await assert.rejects(resumeEnvironment(organizationId, 'managed-sandbox', apiKey), /Only paused environments/);

    await addEnvironment('desktop-stream-row', 'desktop', 'desktop-stream');
    assert.deepEqual(await getSolariDesktopStream(apiKey, 'desktop-stream'), { streamUrl: 'wss://solari.mock/stream/desktop-stream' });
    assert.deepEqual(await getSolariReplayUrl(apiKey, 'session:replay'), { url: 'https://replay.mock/capture.gz', expiresInSeconds: 120, contentEncoding: 'gzip' });

    await addEnvironment('sandbox-stop-row', 'sandbox', 'sbx-stop');
    await addEnvironment('desktop-stop-row', 'desktop', 'desktop-stop');
    await addEnvironment('browser-stop-row', 'browser', 'browser-stop');
    assert.equal((await closeEnvironment(organizationId, 'sandbox-stop-row', apiKey)).status, 'stopped');
    assert.equal((await closeEnvironment(organizationId, 'desktop-stop-row', apiKey)).status, 'stopped');
    assert.equal((await closeEnvironment(organizationId, 'browser-stop-row', apiKey)).status, 'stopped');
    assert.equal(requests.some(({ url }) => url.pathname === '/sandboxes/sbx-stop'), true);
    assert.equal(requests.some(({ url }) => url.pathname === '/desktops/desktop-stop'), true);
  });

  await assert.rejects(createEnvironmentSnapshot(organizationId, 'no-such-environment', apiKey, 'x'), /Environment not found/);
  await addEnvironment('browser-managed-row', 'browser', 'browser-managed');
  await assert.rejects(createEnvironmentSnapshot(organizationId, 'browser-managed-row', apiKey, 'x'), /Snapshots and pause\/resume/);
  await addEnvironment('providerless-environment', 'sandbox', null);
  assert.equal((await closeEnvironment(organizationId, 'providerless-environment', '')).status, 'stopped');
  await addEnvironment('already-stopped-environment', 'sandbox', 'unused-provider', 'stopped');
  assert.equal((await closeEnvironment(organizationId, 'already-stopped-environment', apiKey)).status, 'stopped');
  await assert.rejects(createEnvironmentSnapshot(organizationId, 'managed-sandbox', '', 'x'), /Connect a Solari key/);
  assert.equal(await getWorkflowBrowserFrame(organizationId, 'no-browser-runtime'), null);
  await closeWorkflowBrowserSession(organizationId, 'no-browser-runtime');
  await assert.rejects(closeEnvironment(organizationId, 'no-such-environment', apiKey), /Environment not found/);
});

test('Solari sandbox and desktop tools execute through isolated mocked transports and enforce tool guards', async () => {
  await withProvider(({ url, method, body }) => {
    if (method === 'POST' && url.pathname === '/sandboxes') return jsonResponse({ sandboxId: 'sbx-tool', controlUrl: 'wss://solari.mock/control/sbx-tool', expiresAt: 'later' });
    if (method === 'POST' && url.pathname === '/sandboxes/sbx-tool/exec') return jsonResponse({ exitCode: 0, stdout: body.args.at(-1), stderr: '' });
    if (method === 'DELETE' && url.pathname === '/sandboxes/sbx-tool') return new Response(null, { status: 204 });
    if (method === 'GET' && url.pathname === '/desktops/desktop-tool') return jsonResponse({ sessionId: 'desktop-tool', status: 'running' });
    throw new Error(`Unexpected mocked Solari request: ${method} ${url.pathname}`);
  }, async (requests) => {
    const echo = await runSolariTool(organizationId, 'solari.sandbox.echo', { message: 'hello mock' }, apiKey);
    assert.equal(echo.ok, true);
    assert.equal(echo.stdout, 'hello mock');
    assert.deepEqual(requests.filter(({ url }) => url.pathname.endsWith('/exec')).map(({ body }) => body.cmd), ['echo']);

    await addEnvironment('desktop-tool-row', 'desktop', 'desktop-tool');
    class MockWebSocket {
      static OPEN = 1;
      readyState = 0;
      constructor(url) { this.url = url; queueMicrotask(() => { this.readyState = MockWebSocket.OPEN; this.onopen?.(); }); }
      send(line) {
        const request = JSON.parse(line.trim());
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: request.id, ok: true, result: { exitCode: 7, stdout: 'o'.repeat(4100), stderr: 'e'.repeat(1100) } }) + '\n' }));
      }
      close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
    }
    globalThis.WebSocket = MockWebSocket;
    let result;
    try {
      result = await runSolariTool(organizationId, 'solari.desktop.exec', { environmentId: 'desktop-tool-row', command: 'node', args: ['script.js'] }, apiKey);
    } finally {
      if (originalWebSocket === undefined) delete globalThis.WebSocket;
      else globalThis.WebSocket = originalWebSocket;
    }
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 7);
    assert.equal(result.stdout.length, 4000);
    assert.equal(result.stderr.length, 1000);

    await assert.rejects(runSolariTool(organizationId, 'solari.desktop.exec', { environmentId: 'desktop-tool-row', command: '../node', args: [] }, apiKey), /valid executable/);
    await assert.rejects(runSolariTool(organizationId, 'solari.desktop.exec', { environmentId: 'desktop-tool-row', command: 'node', args: Array(41).fill('a') }, apiKey), /up to 40 text arguments/);
    await assert.rejects(runSolariTool(organizationId, 'solari.desktop.exec', { environmentId: 'missing', command: 'node', args: [] }, apiKey), /Choose a running desktop environment/);
    await assert.rejects(runSolariTool(organizationId, 'solari.desktop.exec', { environmentId: 'desktop-tool-row', command: 'node', args: [] }, apiKey, null, null, null, { readOnly: true }), /not permitted during a read-only simulation/);
    await assert.rejects(runSolariTool(organizationId, 'solari.browser.open', { url: 'http://127.0.0.1/' }, apiKey), /Private network targets are blocked/);
    await assert.rejects(runSolariTool(organizationId, 'solari.browser.interact', { actions: [{ action: 'click', selector: '#x' }, { action: 'assertText', text: 'Saved' }] }, apiKey), /require an existing browser/);
    await assert.rejects(runSolariTool(organizationId, 'solari.unknown', {}, apiKey), /Unsupported Solari tool/);
  });
});

test('Solari usage response reader handles missing, unreadable, oversized, timed-out, and valid streamed bodies', async () => {
  const pieces = ['{"usage":', '{"units":3}}'].map((part) => new TextEncoder().encode(part));
  const streamed = new Response(new ReadableStream({
    start(controller) { for (const piece of pieces) controller.enqueue(piece); controller.close(); },
  }));
  assert.deepEqual(await readSolariUsageResponse(streamed), { usage: { units: 3 } });
  await assert.rejects(readSolariUsageResponse(undefined), /HTTP 0/);
  await assert.rejects(readSolariUsageResponse({ ok: true, body: { getReader: () => null } }), /empty response/);
  const unreadable = new Response(new ReadableStream({ pull() { throw new Error('fixture read failure'); } }));
  await assert.rejects(readSolariUsageResponse(unreadable), /could not be read/);

  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  try {
    let cancelled = false;
    const timedOut = {
      ok: true,
      body: { getReader: () => ({ read: async () => new Promise(() => {}), cancel: async () => { cancelled = true; }, releaseLock() {} }) },
    };
    globalThis.setTimeout = (callback, delay, ...args) => {
      assert.ok(delay > 0 && delay <= 20_000);
      queueMicrotask(() => callback(...args));
      return { mockedTimer: true };
    };
    globalThis.clearTimeout = () => {};
    await assert.rejects(readSolariUsageResponse(timedOut), /response timed out/);
    assert.equal(cancelled, true);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
