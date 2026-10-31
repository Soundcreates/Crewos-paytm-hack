import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'crewos-server-integration-'));
const envKeys = ['NODE_ENV', 'DATABASE_URL', 'DATABASE_FILE', 'NEON_AUTH_BASE_URL', 'APP_ORIGIN', 'APP_MASTER_KEY', 'MCP_VERIFIER_MODULE', 'ATLASSIAN_OAUTH_CLIENT_ID', 'ATLASSIAN_OAUTH_CLIENT_SECRET', 'ATLASSIAN_OAUTH_REDIRECT_URI'];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys) delete process.env[key];
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.DATABASE_FILE = join(directory, 'server-integration.sqlite');
process.env.NEON_AUTH_BASE_URL = '';
process.env.APP_ORIGIN = 'http://127.0.0.1:4173';
process.env.APP_MASTER_KEY = 'offline-server-test-master-key';

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => { throw new Error(`Unexpected provider request in server integration test: ${String(input)}`); };
const { handleHttpRequest } = await import('../backend/server.mjs');
const { closeDatabase, get: getDb, run: runDb } = await import('../backend/lib/db.mjs');
const { getSecret } = await import('../backend/lib/secrets.mjs');

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

async function request(method, path, { body, rawBody, contentType, contentLength, chunked = false, cookie, remoteAddress = '127.0.0.1', headers = {} } = {}) {
  const payload = rawBody !== undefined ? Buffer.from(rawBody) : body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = Readable.from(payload ? [payload] : []);
  req.method = method;
  req.url = path;
  req.headers = {
    host: '127.0.0.1:4173',
    ...(method !== 'GET' ? { origin: process.env.APP_ORIGIN } : {}),
    ...(payload ? { 'content-type': contentType || 'application/json', ...(chunked ? {} : { 'content-length': String(contentLength ?? payload.length) }) } : {}),
    ...(cookie ? { cookie } : {}),
    ...headers,
  };
  if (contentLength !== undefined && !payload) req.headers['content-length'] = String(contentLength);
  req.socket = { encrypted: false, remoteAddress };
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

async function signup(email, organization) {
  const response = await request('POST', '/api/auth/signup', {
    body: { name: 'Integration Owner', email, password: 'integration-password-123', organization },
  });
  assert.equal(response.statusCode, 201, response.body);
  return { cookie: sessionCookie(response), ...response.json() };
}

test('HTTP ingress enforces origin, cross-site, and body parsing limits with security headers', async () => {
  const crossOrigin = await request('POST', '/api/auth/signup', {
    body: { name: 'Bad Origin', email: 'bad-origin@example.test', password: 'integration-password-123', organization: 'Bad Origin' },
    headers: { origin: 'https://attacker.example' },
  });
  assert.equal(crossOrigin.statusCode, 403);
  assert.equal(crossOrigin.json().error, 'origin_denied');

  const deployedFrontend = await request('POST', '/api/auth/logout', {
    body: {}, headers: { origin: 'https://crewos-paytm-hack-three.vercel.app', 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(deployedFrontend.statusCode, 200);

  const crossSite = await request('POST', '/api/auth/logout', {
    body: {}, headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.statusCode, 403);
  assert.equal(crossSite.json().error, 'origin_denied');

  const unsupportedType = await request('POST', '/api/auth/logout', { rawBody: '{}', contentType: 'text/plain' });
  assert.equal(unsupportedType.statusCode, 415);
  const malformedJson = await request('POST', '/api/auth/logout', { rawBody: '{', contentType: 'application/json' });
  assert.equal(malformedJson.statusCode, 400);
  const oversized = await request('POST', '/api/auth/logout', { contentLength: 12 * 1024 * 1024 + 1 });
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.json().message, 'Request body is too large.');
  const streamedOversized = await request('POST', '/api/auth/logout', {
    rawBody: Buffer.alloc(12 * 1024 * 1024 + 1), chunked: true,
  });
  assert.equal(streamedOversized.statusCode, 413);

  const health = await request('GET', '/api/health');
  assert.equal(health.statusCode, 200);
  assert.equal(health.getHeader('x-content-type-options'), 'nosniff');
  assert.equal(health.getHeader('x-frame-options'), 'DENY');
  assert.match(health.getHeader('content-security-policy'), /frame-ancestors 'none'/);
});

test('router distinguishes public, unauthenticated, authenticated, and disabled auth routes', async () => {
  assert.equal((await request('GET', '/api/config')).json().authProvider, 'local');
  assert.deepEqual((await request('GET', '/api/auth/me')).json(), { user: null, organization: null, organizations: [] });
  assert.equal((await request('GET', '/api/health')).statusCode, 200);
  assert.equal((await request('GET', '/api/overview')).statusCode, 401);
  assert.equal((await request('GET', '/api/not-a-route')).statusCode, 401, 'API auth must run before protected route fallthrough');
  assert.equal((await request('POST', '/api/auth/signup-intent', { body: {} })).statusCode, 404);

  const owner = await signup('route-owner@example.test', 'Route Integration Workspace');
  const missingRoute = await request('GET', '/api/not-a-route', { cookie: owner.cookie });
  assert.equal(missingRoute.statusCode, 404);
  assert.equal(missingRoute.json().error, 'not_found');
  const unsupportedMethod = await request('POST', '/api/office', { cookie: owner.cookie, body: {} });
  assert.equal(unsupportedMethod.statusCode, 404);
});

test('workspace switching and manager-only organization mutation reject unauthorized tenants and roles', async () => {
  const owner = await signup('scope-owner@example.test', 'Primary Integration Workspace');
  const other = await signup('scope-other@example.test', 'Other Integration Workspace');

  const switchToOtherWorkspace = await request('POST', '/api/org/switch', {
    cookie: owner.cookie, body: { organizationId: other.organization.id },
  });
  assert.equal(switchToOtherWorkspace.statusCode, 403);
  assert.equal((await request('GET', '/api/org', { cookie: owner.cookie })).json().id, owner.organization.id);

  const invalidInvite = await request('POST', '/api/invitations/accept', { body: { token: 'not-a-real-invite-token' } });
  assert.equal(invalidInvite.statusCode, 404);

  const expiredInvite = await request('POST', '/api/members/invite', {
    cookie: owner.cookie, body: { email: 'expired-scope-member@example.test', role: 'member' },
  });
  assert.equal(expiredInvite.statusCode, 201, expiredInvite.body);
  const expiredToken = new URL(expiredInvite.json().inviteUrl).searchParams.get('invite');
  await runDb('UPDATE invitations SET expires_at=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), expiredInvite.json().id);
  const rejectedExpiredInvite = await request('POST', '/api/invitations/accept', { body: { token: expiredToken, name: 'Expired Member', password: 'member-password-123' } });
  assert.equal(rejectedExpiredInvite.statusCode, 404);

  const invite = await request('POST', '/api/members/invite', {
    cookie: owner.cookie, body: { email: 'scope-member@example.test', role: 'member' },
  });
  assert.equal(invite.statusCode, 201, invite.body);
  const inviteToken = new URL(invite.json().inviteUrl).searchParams.get('invite');
  const accepted = await request('POST', '/api/invitations/accept', {
    body: { token: inviteToken, name: 'Workspace Member', password: 'member-password-123' },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  const memberCookie = sessionCookie(accepted);
  const replayedInvite = await request('POST', '/api/invitations/accept', { body: { token: inviteToken, name: 'Workspace Member', password: 'member-password-123' } });
  assert.equal(replayedInvite.statusCode, 404);

  const forbiddenUpdate = await request('PATCH', '/api/org', {
    cookie: memberCookie, body: { name: 'Unauthorized Rename' },
  });
  assert.equal(forbiddenUpdate.statusCode, 403);
  assert.equal(forbiddenUpdate.json().error, 'forbidden');
  assert.equal((await request('GET', '/api/org', { cookie: owner.cookie })).json().name, 'Primary Integration Workspace');
});

test('MCP HTTP transport requires a workspace session and normalizes JSON-RPC requests and notifications', async () => {
  const initialize = { jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: { protocolVersion: '2026-07-28' } };
  const unauthenticated = await request('POST', '/mcp', { body: initialize });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.json().error, 'unauthorized');

  const owner = await signup('mcp-http-owner@example.test', 'MCP HTTP Integration Workspace');
  const initialized = await request('POST', '/mcp', { cookie: owner.cookie, body: initialize });
  assert.equal(initialized.statusCode, 200);
  assert.equal(initialized.json().id, 'init-1');
  assert.equal(initialized.json().result.serverInfo.name, 'crewos');

  const missingCapability = await request('POST', '/mcp', {
    cookie: owner.cookie,
    body: { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { taskId: 'task_test' } },
  });
  assert.equal(missingCapability.statusCode, 200);
  assert.equal(missingCapability.json().error.code, -32021);
  assert.deepEqual(missingCapability.json().error.data.requiredCapabilities.extensions['io.modelcontextprotocol/tasks'], {});

  const notification = await request('POST', '/mcp', {
    cookie: owner.cookie, body: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  assert.equal(notification.statusCode, 202);
  assert.equal(notification.body, '');
});

test('password login rotates sessions, logout invalidates them, and repeated failures are throttled per IP', async () => {
  await signup('login-owner@example.test', 'Login Integration Workspace');

  const invalid = await request('POST', '/api/auth/login', {
    body: { email: 'login-owner@example.test', password: 'incorrect-password' },
  });
  assert.equal(invalid.statusCode, 401);
  assert.equal(invalid.json().error, 'invalid_credentials');

  const login = await request('POST', '/api/auth/login', {
    body: { email: ' LOGIN-OWNER@EXAMPLE.TEST ', password: 'integration-password-123' },
  });
  assert.equal(login.statusCode, 200, login.body);
  assert.equal(login.json().organization.role, 'owner');
  const cookie = sessionCookie(login);
  assert.equal((await request('GET', '/api/auth/me', { cookie })).json().user.email, 'login-owner@example.test');

  const logout = await request('POST', '/api/auth/logout', { cookie, body: {} });
  assert.equal(logout.statusCode, 200);
  assert.match(logout.getHeader('set-cookie'), /Max-Age=0/);
  assert.equal((await request('GET', '/api/auth/me', { cookie })).json().user, null);

  const rateLimitIp = '192.0.2.55';
  for (let attempt = 0; attempt < 10; attempt++) {
    const failedLogin = await request('POST', '/api/auth/login', {
      remoteAddress: rateLimitIp,
      body: { email: 'missing@example.test', password: 'incorrect-password' },
    });
    assert.equal(failedLogin.statusCode, 401, `failure ${attempt + 1}`);
  }
  const throttled = await request('POST', '/api/auth/login', {
    remoteAddress: rateLimitIp,
    body: { email: 'login-owner@example.test', password: 'integration-password-123' },
  });
  assert.equal(throttled.statusCode, 429);
});

test('Jira OAuth callback requires one-time state and cookie before canceling locally', async () => {
  process.env.ATLASSIAN_OAUTH_CLIENT_ID = 'jira-client-test';
  process.env.ATLASSIAN_OAUTH_CLIENT_SECRET = 'jira-secret-test';
  process.env.ATLASSIAN_OAUTH_REDIRECT_URI = 'https://app.example.test/oauth/jira/callback';
  const owner = await signup('oauth-owner@example.test', 'OAuth Integration Workspace');

  const start = await request('GET', '/api/integrations/jira/connect', { cookie: owner.cookie });
  assert.equal(start.statusCode, 302);
  const authorizationUrl = new URL(start.getHeader('location'));
  assert.equal(authorizationUrl.origin, 'https://auth.atlassian.com');
  const state = authorizationUrl.searchParams.get('state');
  assert.ok(state);
  const stateCookie = start.getHeader('set-cookie');
  assert.match(stateCookie, new RegExp(`^crewos_jira_oauth=${state};`));

  const forgedState = await request('GET', `/oauth/jira/callback?state=forged&error=access_denied`, { headers: { cookie: stateCookie.split(';', 1)[0] } });
  assert.equal(forgedState.statusCode, 400);

  const canceled = await request('GET', `/oauth/jira/callback?state=${encodeURIComponent(state)}&error=access_denied`, {
    headers: { cookie: stateCookie.split(';', 1)[0] },
  });
  assert.equal(canceled.statusCode, 302);
  assert.equal(canceled.getHeader('location'), '/?jira=cancelled#settings');
  assert.match(canceled.getHeader('set-cookie'), /Max-Age=0/);

  const replay = await request('GET', `/oauth/jira/callback?state=${encodeURIComponent(state)}&error=access_denied`, {
    headers: { cookie: stateCookie.split(';', 1)[0] },
  });
  assert.equal(replay.statusCode, 400);

  const secondStart = await request('GET', '/api/integrations/jira/connect', { cookie: owner.cookie });
  const secondState = new URL(secondStart.getHeader('location')).searchParams.get('state');
  const secondCookie = secondStart.getHeader('set-cookie').split(';', 1)[0];
  const previousFetch = globalThis.fetch;
  const providerCalls = [];
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    providerCalls.push({ url, options });
    if (url.hostname === 'auth.atlassian.com' && url.pathname === '/oauth/token') {
      assert.equal(options.method, 'POST');
      assert.equal(JSON.parse(options.body).code, 'mock-oauth-code');
      return new Response(JSON.stringify({ access_token: 'mock-access', refresh_token: 'mock-refresh', expires_in: 3600 }), { status: 200 });
    }
    if (url.hostname === 'api.atlassian.com' && url.pathname === '/oauth/token/accessible-resources') {
      assert.equal(options.headers.authorization, 'Bearer mock-access');
      return new Response(JSON.stringify([{
        id: 'site-12345678', name: 'Mock Jira', url: 'https://mock-workspace.atlassian.net',
        scopes: ['read:jira-work', 'write:jira-work'],
      }]), { status: 200 });
    }
    throw new Error(`Unexpected Jira OAuth provider request: ${url}`);
  };
  try {
    const connected = await request('GET', `/oauth/jira/callback?state=${encodeURIComponent(secondState)}&code=mock-oauth-code`, {
      headers: { cookie: secondCookie },
    });
    assert.equal(connected.statusCode, 302);
    assert.equal(connected.getHeader('location'), '/?jira=connected#settings');
    assert.deepEqual(providerCalls.map(({ url }) => `${url.hostname}${url.pathname}`), [
      'auth.atlassian.com/oauth/token', 'api.atlassian.com/oauth/token/accessible-resources',
    ]);
    const integration = await getDb('SELECT config FROM integrations WHERE org_id=? AND provider=?', owner.organization.id, 'jira');
    assert.deepEqual(JSON.parse(integration.config).sites, [{ id: 'site-12345678', name: 'Mock Jira', url: 'https://mock-workspace.atlassian.net' }]);
    const tokens = JSON.parse(await getSecret(owner.organization.id, 'jira'));
    assert.equal(tokens.accessToken, 'mock-access');
    assert.equal(tokens.refreshToken, 'mock-refresh');
  } finally {
    globalThis.fetch = previousFetch;
  }
});
