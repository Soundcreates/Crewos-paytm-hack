import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'crewos-auth-api-'));
const envKeys = ['NODE_ENV', 'DATABASE_URL', 'DATABASE_FILE', 'NEON_AUTH_BASE_URL', 'APP_ORIGIN', 'APP_MASTER_KEY', 'SOLARI_API_KEY', 'SOLARI_BROWSER_BASE_URL', 'OPENROUTER_API_KEY', 'PILOT_MODE'];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
for (const key of ['APP_MASTER_KEY', 'OPENROUTER_API_KEY']) delete process.env[key];
process.env.NODE_ENV = 'test';
process.env.PILOT_MODE = 'false';
process.env.DATABASE_URL = '';
process.env.DATABASE_FILE = join(directory, 'auth-flow.sqlite');
process.env.NEON_AUTH_BASE_URL = '';
process.env.APP_ORIGIN = 'http://127.0.0.1:4173';
process.env.APP_MASTER_KEY = 'offline-auth-flow-master-key';
process.env.SOLARI_API_KEY = 'slr_test_usage_key';
process.env.SOLARI_BROWSER_BASE_URL = 'https://solari.test';

const { handleHttpRequest } = await import('../backend/server.mjs');
const { closeDatabase, now, run: runDb } = await import('../backend/lib/db.mjs');

after(async () => {
  await closeDatabase();
  rmSync(directory, { recursive: true, force: true });
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

test('recurring work API validates revisions, hides other workspaces, and preserves deletion history', async () => {
  const signup = await request('POST', '/api/auth/signup', { body: { name: 'Schedule owner', email: 'schedule-api@example.test', password: 'schedule-password-123', organization: 'Schedule API' } });
  const cookie = sessionCookie(signup);
  const created = await request('POST', '/api/employees', { cookie, body: { name: 'Scheduled analyst', title: 'Analyst', mission: 'Review support cases', responsibilities: ['Follow policies'], tools: ['payments.refund'] } });
  assert.equal(created.statusCode, 201, created.body);
  const employeeId = created.json().id;
  const input = { name: 'Morning review', employeeId, goal: 'Review the support queue', kind: 'cron', cron: '0 9 * * 1-5', timezone: 'Asia/Kolkata' };
  assert.equal((await request('POST', '/api/schedules', { cookie, body: input })).statusCode, 409, 'draft employees cannot receive schedules');
  await runDb("UPDATE employees SET state='active' WHERE id=?", employeeId);
  const saved = await request('POST', '/api/schedules', { cookie, body: input });
  assert.equal(saved.statusCode, 201, saved.body);
  const schedule = saved.json();
  assert.equal((await request('GET', '/api/schedules')).statusCode, 401);
  assert.equal((await request('GET', '/api/schedules', { cookie })).json()[0].id, schedule.id);
  const invalid = await request('PATCH', `/api/schedules/${schedule.id}`, { cookie, body: { ...input, cron: '* * * * * *', revision: schedule.revision } });
  assert.equal(invalid.statusCode, 400);
  const paused = await request('POST', `/api/schedules/${schedule.id}/pause`, { cookie, body: { revision: schedule.revision } });
  assert.equal(paused.statusCode, 200, paused.body);
  assert.equal(paused.json().status, 'paused');
  assert.equal((await request('DELETE', `/api/schedules/${schedule.id}`, { cookie, body: { revision: schedule.revision } })).statusCode, 409);
  const otherSignup = await request('POST', '/api/auth/signup', { body: { name: 'Other schedule owner', email: 'schedule-other@example.test', password: 'schedule-password-123', organization: 'Other schedules' } });
  const otherCookie = sessionCookie(otherSignup);
  assert.equal((await request('GET', `/api/schedules/${schedule.id}/runs`, { cookie: otherCookie })).statusCode, 404);
  const removed = await request('DELETE', `/api/schedules/${schedule.id}`, { cookie, body: { revision: paused.json().revision } });
  assert.equal(removed.statusCode, 204, removed.body);
  assert.deepEqual((await request('GET', '/api/schedules', { cookie })).json(), []);
  assert.deepEqual((await request('GET', `/api/schedules/${schedule.id}/runs`, { cookie })).json(), []);
});

test('pilot mode rejects every direct schedule API operation with a feature-disabled error', async () => {
  const signup = await request('POST', '/api/auth/signup', { body: { name: 'Pilot schedule owner', email: 'pilot-schedule@example.test', password: 'schedule-password-123', organization: 'Pilot schedules' } });
  const cookie = sessionCookie(signup);
  const created = await request('POST', '/api/employees', { cookie, body: { name: 'Pilot analyst', title: 'Analyst', mission: 'Review support', responsibilities: ['Review support'], tools: ['payments.refund'] } });
  assert.equal(created.statusCode, 201, created.body);
  await runDb("UPDATE employees SET state='active' WHERE id=?", created.json().id);
  const input = { name: 'Pilot review', employeeId: created.json().id, goal: 'Review the support queue', kind: 'interval', intervalMinutes: 15, timezone: 'UTC' };
  const saved = await request('POST', '/api/schedules', { cookie, body: input });
  assert.equal(saved.statusCode, 201, saved.body);
  const schedule = saved.json();
  const previousPilotMode = process.env.PILOT_MODE;
  try {
    process.env.PILOT_MODE = 'true';
    assert.equal((await request('GET', '/api/config')).json().pilotMode, true,
      'the frontend configuration endpoint reports the same pilot mode used by schedule enforcement');
    const operations = await Promise.all([
      request('GET', '/api/schedules', { cookie }),
      request('POST', '/api/schedules', { cookie, body: input }),
      request('PATCH', `/api/schedules/${schedule.id}`, { cookie, body: { ...input, revision: schedule.revision } }),
      request('DELETE', `/api/schedules/${schedule.id}`, { cookie, body: { revision: schedule.revision } }),
      request('GET', `/api/schedules/${schedule.id}/runs`, { cookie }),
      request('POST', `/api/schedules/${schedule.id}/pause`, { cookie, body: { revision: schedule.revision } }),
      request('POST', `/api/schedules/${schedule.id}/resume`, { cookie, body: { revision: schedule.revision } }),
    ]);
    for (const response of operations) {
      assert.equal(response.statusCode, 403, response.body);
      assert.equal(response.json().error, 'feature_disabled');
      assert.equal(response.json().message, 'Recurring schedules are unavailable in pilot mode.');
    }
  } finally {
    if (previousPilotMode === undefined) delete process.env.PILOT_MODE;
    else process.env.PILOT_MODE = previousPilotMode;
  }
  const retained = await request('GET', '/api/schedules', { cookie });
  assert.equal(retained.statusCode, 200, retained.body);
  assert.deepEqual(retained.json().map(({ id, status, revision }) => ({ id, status, revision })), [{ id: schedule.id, status: 'active', revision: schedule.revision }]);
  assert.equal((await request('DELETE', `/api/schedules/${schedule.id}`, { cookie, body: { revision: schedule.revision } })).statusCode, 204);
});

test('signup, invitation roles, EmployeeSpec creation, and protected API access work end to end', async () => {
  const ownerSignup = await request('POST', '/api/auth/signup', {
    body: { name: 'Workspace Owner', email: 'owner@example.test', password: 'owner-password-123', organization: 'Auth Flow Test' },
  });
  assert.equal(ownerSignup.statusCode, 201);
  const ownerCookie = sessionCookie(ownerSignup);
  assert.equal((await request('GET', '/api/auth/me', { cookie: ownerCookie })).json().organization.role, 'owner');
  const connectedOpenRouter = await request('PUT', '/api/integrations/openrouter', {
    cookie: ownerCookie,
    body: { secret: 'openrouter-integration-test-key' },
  });
  assert.equal(connectedOpenRouter.statusCode, 200, connectedOpenRouter.body);
  assert.equal(connectedOpenRouter.json().provider, 'openrouter');
  assert.equal(connectedOpenRouter.json().display_name, 'OpenRouter');
  const integrations = await request('GET', '/api/integrations', { cookie: ownerCookie });
  assert.equal(integrations.json().find((item) => item.provider === 'openrouter').configured, true);

  const inviteManager = await request('POST', '/api/members/invite', {
    cookie: ownerCookie,
    body: { email: 'manager@example.test', role: 'manager' },
  });
  assert.equal(inviteManager.statusCode, 201);
  const managerToken = new URL(inviteManager.json().inviteUrl).searchParams.get('invite');
  const managerJoin = await request('POST', '/api/invitations/accept', {
    body: { token: managerToken, name: 'Workspace Manager', password: 'manager-password-123' },
  });
  assert.equal(managerJoin.statusCode, 200);
  const managerCookie = sessionCookie(managerJoin);
  const managerIdentity = (await request('GET', '/api/auth/me', { cookie: managerCookie })).json();
  assert.equal(managerIdentity.organization.role, 'manager');

  const employee = await request('POST', '/api/employees', {
    cookie: managerCookie,
    body: {
      name: 'Support Agent', title: 'Customer Support', department: 'Support',
      mission: 'Resolve customer requests with clear evidence.',
      responsibilities: ['Review requests and document outcomes.'],
      capabilities: [{ name: 'Triage', description: 'Categorize incoming requests.' }],
      successMetrics: [{ name: 'Resolution rate', target: 95 }],
      tools: [], policies: [], coworkers: [],
      evaluationPolicy: 'Pass probation simulations at the configured threshold.',
    },
  });
  assert.equal(employee.statusCode, 201);
  assert.equal(employee.json().state, 'draft');
  assert.equal(employee.json().spec.version, 1);
  assert.deepEqual(employee.json().spec.tools, []);
  assert.equal((await request('GET', '/api/office', { cookie: managerCookie })).statusCode, 200);

  const meeting = await request('POST', '/api/meetings', {
    cookie: managerCookie,
    body: { title: 'Private brief access test', agenda: ['Review support cases'], participantIds: [employee.json().id] },
  });
  assert.equal(meeting.statusCode, 201);
  await runDb(
    'INSERT INTO meeting_briefs(id,meeting_id,employee_id,brief,source_memory_ids,created_at) VALUES(?,?,?,?,?,?)',
    'brief_private_test', meeting.json().id, employee.json().id, 'Confidential employee context', '[]', now(),
  );
  const managerMeeting = await request('GET', `/api/meetings/${meeting.json().id}`, { cookie: managerCookie });
  assert.equal(managerMeeting.statusCode, 200);
  assert.equal(managerMeeting.json().briefs[0].brief, 'Confidential employee context');

  const inviteMember = await request('POST', '/api/members/invite', {
    cookie: ownerCookie,
    body: { email: 'member@example.test', role: 'member' },
  });
  const memberToken = new URL(inviteMember.json().inviteUrl).searchParams.get('invite');
  const memberJoin = await request('POST', '/api/invitations/accept', {
    body: { token: memberToken, name: 'Workspace Member', password: 'member-password-123' },
  });
  const memberCookie = sessionCookie(memberJoin);
  assert.equal((await request('GET', '/api/auth/me', { cookie: memberCookie })).json().organization.role, 'member');

  const memberMeeting = await request('GET', `/api/meetings/${meeting.json().id}`, { cookie: memberCookie });
  assert.equal(memberMeeting.statusCode, 200);
  assert.deepEqual(memberMeeting.json().briefs, []);
  assert.equal(memberMeeting.json().title, 'Private brief access test');
  assert.deepEqual(memberMeeting.json().agenda, ['Review support cases']);

  const forbidden = await request('POST', '/api/employees', {
    cookie: memberCookie,
    body: { name: 'Blocked Agent', title: 'Support' },
  });
  assert.equal(forbidden.statusCode, 403);
  assert.match(forbidden.json().message, /manager access/);

  await request('POST', '/api/auth/logout', { cookie: managerCookie, body: {} });
  assert.equal((await request('GET', '/api/members', { cookie: managerCookie })).statusCode, 401);
});

test('Solari provider usage only fetches browser sessions owned by the requesting workspace', async () => {
  const workspaces = [];
  for (const [name, email] of [['First Owner', 'first-usage@example.test'], ['Second Owner', 'second-usage@example.test']]) {
    const signup = await request('POST', '/api/auth/signup', {
      body: { name, email, password: 'usage-password-123', organization: `${name} Workspace` },
    });
    assert.equal(signup.statusCode, 201, signup.body);
    const cookie = sessionCookie(signup);
    const identity = (await request('GET', '/api/auth/me', { cookie })).json();
    workspaces.push({ cookie, orgId: identity.organization.id, userId: identity.user.id });
  }

  const sessionIds = ['provider-session:workspace-one', 'provider-session:workspace-two'];
  for (const [index, workspace] of workspaces.entries()) {
    await runDb(
      'INSERT INTO environments(id,org_id,kind,provider_id,status,label,metadata,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      `env_usage_${index}`, workspace.orgId, 'browser', sessionIds[index], 'stopped', 'Usage scope test', '{}', workspace.userId, now(),
    );
  }

  const originalFetch = globalThis.fetch;
  const requestedPaths = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    requestedPaths.push(url.pathname);
    const sessionId = decodeURIComponent(url.pathname.split('/').at(-1));
    return new Response(JSON.stringify({ sessionId, billedCostUsd: 0.25 }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    for (const [index, workspace] of workspaces.entries()) {
      const response = await request('GET', '/api/analytics/solari-provider-usage', { cookie: workspace.cookie });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().available, true);
      assert.deepEqual(response.json().usage.sessions.map((session) => session.sessionId), [sessionIds[index]]);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requestedPaths, sessionIds.map((sessionId) => `/api/v1/usage/sessions/${encodeURIComponent(sessionId)}`));
});
