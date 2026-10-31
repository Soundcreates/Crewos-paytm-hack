import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'crewos-jira-api-'));
process.env.DATABASE_FILE = join(directory, 'test.sqlite');
delete process.env.DATABASE_URL;
delete process.env.NEON_AUTH_BASE_URL;
process.env.APP_MASTER_KEY = 'jira-test-master-key-long-enough';
process.env.ATLASSIAN_OAUTH_CLIENT_ID = 'client-id';
process.env.ATLASSIAN_OAUTH_CLIENT_SECRET = 'client-secret';
process.env.ATLASSIAN_OAUTH_REDIRECT_URI = 'https://app.example.test/oauth/jira/callback';

const db = await import('../backend/lib/db.mjs');
const secrets = await import('../backend/lib/secrets.mjs');
const jira = await import('../backend/build/jira.js');
const orgId = 'org_jira_api_test';
const cloudId = '12345678-1234-1234-1234-123456789012';
const projectKey = 'OPS';
const sites = [{ id: cloudId, name: 'CrewOS', url: 'https://crewos.atlassian.net' }];

await db.run('INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)', orgId, 'Jira test', db.now());

after(async () => {
  await db.closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

async function connectJira(tokens = { accessToken: 'access-old', refreshToken: 'refresh-old', expiresAt: Date.now() + 3600000 }, config = {}) {
  await secrets.storeSecret(orgId, 'user_jira_test', 'jira', JSON.stringify(tokens), {
    cloudId, projectKey, issueType: 'Bug', sites, ...config,
  });
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

test('typed Jira adapter covers project, issue, scope, and workflow-verification paths', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  let issueCreatedAt = '2026-09-30T08:30:00.000Z';
  await connectJira();
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    requests.push({ url, options });
    assert.equal(options.headers.authorization, 'Bearer access-old');
    if (url.pathname.endsWith('/project/search')) return jsonResponse({ values: [{ key: 'OPS', name: 'Operations' }, { key: 1, name: 'Invalid key' }, { key: 'NO_NAME' }] });
    if (url.pathname.endsWith('/project/OPS')) return jsonResponse({ key: 'OPS', name: 'Operations' });
    if (url.pathname.endsWith('/project/MISMATCH')) return jsonResponse({ key: 'OTHER', name: 'Other' });
    if (url.pathname.endsWith('/project/MISSING')) return jsonResponse({ errorMessages: ['Project missing'] }, 404);
    if (url.pathname.endsWith('/issue') && options.method === 'POST') return jsonResponse({ key: 'OPS-42' }, 201);
    if (url.pathname.endsWith('/issue/OPS-404')) return jsonResponse({ errorMessages: ['Issue missing'] }, 404);
    if (url.pathname.endsWith('/issue/OPS-42') && options.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/issue/OPS-42')) return jsonResponse({ key: 'OPS-42', fields: { created: issueCreatedAt, project: { key: 'OPS' } } });
    if (url.pathname.endsWith('/issue/OPS-41')) return jsonResponse({ key: 'OPS-41', fields: { created: issueCreatedAt, project: { key: 'OTHER' } } });
    throw new Error(`Unexpected Jira request ${options.method} ${url}`);
  };
  try {
    assert.deepEqual(await jira.jiraSites(orgId), sites);
    assert.deepEqual(await jira.listJiraProjects(orgId, cloudId), [{ key: 'OPS', name: 'Operations' }]);
    assert.deepEqual(await jira.validateJiraProject(orgId, cloudId, 'OPS'), { key: 'OPS', name: 'Operations' });
    assert.equal(await jira.validateJiraProject(orgId, cloudId, 'MISMATCH'), null);
    assert.equal(await jira.validateJiraProject(orgId, cloudId, 'MISSING'), null);

    const created = await jira.createJiraIssue(orgId, { title: 'Review access', description: 'Check roles and grants.' });
    assert.deepEqual(created, { ok: true, issueId: 'OPS-42', issueKey: 'OPS-42', projectKey: 'OPS', url:'https://crewos.atlassian.net/browse/OPS-42' });
    const createRequest = requests.find((request) => request.options.method === 'POST');
    assert.equal(JSON.parse(createRequest.options.body).fields.issuetype.name, 'Bug');
    assert.equal(JSON.parse(createRequest.options.body).fields.description.content[0].content[0].text, 'Check roles and grants.');

    assert.equal(await jira.jiraIssueExists(orgId, 'OPS-42'), true);
    assert.equal(await jira.jiraIssueExists(orgId, 'OPS-404'), false);
    assert.equal(await jira.jiraIssueCreatedAfter(orgId, 'OPS-42', '2026-09-30T08:00:00.000Z')?.then((row) => row.createdDuringWorkflow), true);
    assert.equal((await jira.jiraIssueCreatedAfter(orgId, 'OPS-42', '2026-09-30T09:00:00.000Z')).createdDuringWorkflow, false);
    assert.equal(await jira.jiraIssueCreatedAfter(orgId, 'OPS-42', 'not a date'), null);
    assert.equal(await jira.jiraIssueCreatedAfter(orgId, 'OPS-41', '2026-09-30T08:00:00.000Z'), null);
    issueCreatedAt = 'not a date';
    assert.equal(await jira.jiraIssueCreatedAfter(orgId, 'OPS-42', '2026-09-30T08:00:00.000Z'), null);

    assert.deepEqual(await jira.deleteJiraIssue(orgId, 'OPS-42'), { ok: true, deletedId: 'OPS-42' });
    await assert.rejects(jira.deleteJiraIssue(orgId, 'OTHER-42'), /configured project/);
    await assert.rejects(jira.listJiraProjects(orgId, 'unauthorized-cloud'), /authorized for this workspace/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('expired Jira tokens refresh once for concurrent requests and rotate in storage', async () => {
  const previousFetch = globalThis.fetch;
  let refreshes = 0;
  const authHeaders = [];
  await connectJira({ accessToken: 'access-expired', refreshToken: 'refresh-old', expiresAt: Date.now() - 1 });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/oauth/token') {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const payload = JSON.parse(options.body);
      assert.equal(payload.grant_type, 'refresh_token');
      assert.equal(payload.refresh_token, 'refresh-old');
      return jsonResponse({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 1800 });
    }
    authHeaders.push(options.headers.authorization);
    if (url.pathname.endsWith('/project/search')) return jsonResponse({ values: [] });
    if (url.pathname.endsWith('/project/OPS')) return jsonResponse({ key: 'OPS', name: 'Operations' });
    throw new Error(`Unexpected Jira request ${options.method} ${url}`);
  };
  try {
    await Promise.all([jira.listJiraProjects(orgId, cloudId), jira.validateJiraProject(orgId, cloudId, projectKey)]);
    assert.equal(refreshes, 1);
    assert.deepEqual(authHeaders, ['Bearer access-new', 'Bearer access-new']);
    const rotated = JSON.parse(await secrets.getSecret(orgId, 'jira'));
    assert.equal(rotated.accessToken, 'access-new');
    assert.equal(rotated.refreshToken, 'refresh-new');
    assert.ok(rotated.expiresAt > Date.now());
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('typed Jira adapter rejects invalid OAuth config, legacy tokens, and malformed provider results', async () => {
  const previousFetch = globalThis.fetch;
  const originalRedirect = process.env.ATLASSIAN_OAUTH_REDIRECT_URI;
  try {
    process.env.ATLASSIAN_OAUTH_REDIRECT_URI = 'http://attacker.example/oauth/jira/callback';
    assert.throws(() => jira.jiraAuthorizationUrl('state'), /must use HTTPS/);
    process.env.ATLASSIAN_OAUTH_REDIRECT_URI = 'https://app.example.test/wrong-path';
    assert.throws(() => jira.jiraAuthorizationUrl('state'), /callback URL/);
    process.env.ATLASSIAN_OAUTH_REDIRECT_URI = originalRedirect;

    await secrets.storeSecret(orgId, 'user_jira_test', 'jira', 'legacy-api-token-value', { cloudId, projectKey, issueType: 'Bug', sites });
    await assert.rejects(jira.listJiraProjects(orgId, cloudId), /replaced with Atlassian OAuth/);
    await assert.rejects(jira.jiraSites('missing-org'), /Connect Jira Cloud/);
    await db.run('UPDATE integrations SET config=? WHERE org_id=? AND provider=?', '{', orgId, 'jira');
    await assert.rejects(jira.jiraSites(orgId), /connection settings are invalid/);
    await connectJira();

    await connectJira({ accessToken: 'a-token', refreshToken: 'r-token', expiresAt: Date.now() + 3600000 }, { cloudId: undefined, projectKey: undefined });
    await assert.rejects(jira.createJiraIssue(orgId, { title: 'Missing config', description: '' }), /Choose a Jira project/);
    await connectJira();
    globalThis.fetch = async () => jsonResponse({ key: 'invalid-key' }, 201);
    await assert.rejects(jira.createJiraIssue(orgId, { title: 'Bad response', description: '' }), /invalid issue key/);
    globalThis.fetch = async () => jsonResponse({ errorMessages: ['Project permissions denied'] }, 403);
    await assert.rejects(jira.listJiraProjects(orgId, cloudId), /Jira request failed \(403\): Project permissions denied/);
    await assert.rejects(jira.createJiraIssue(orgId, { title: 'Denied issue', description: '' }), /Jira request failed/);
  } finally {
    process.env.ATLASSIAN_OAUTH_REDIRECT_URI = originalRedirect;
    globalThis.fetch = previousFetch;
  }
});
