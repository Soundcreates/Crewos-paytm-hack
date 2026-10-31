import assert from 'node:assert/strict';
import test from 'node:test';
import { exchangeJiraAuthorizationCode, jiraAuthorizationUrl } from '../backend/lib/jira.mjs';

test('Jira OAuth builds a scoped authorization URL and filters inaccessible sites', async () => {
  const envNames = ['ATLASSIAN_OAUTH_CLIENT_ID', 'ATLASSIAN_OAUTH_CLIENT_SECRET', 'ATLASSIAN_OAUTH_REDIRECT_URI'];
  const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  const requests = [];
  Object.assign(process.env, {
    ATLASSIAN_OAUTH_CLIENT_ID: 'client-id',
    ATLASSIAN_OAUTH_CLIENT_SECRET: 'client-secret',
    ATLASSIAN_OAUTH_REDIRECT_URI: 'https://app.example.test/oauth/jira/callback',
  });
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    requests.push({ url, options });
    if (url.endsWith('/oauth/token')) return new Response(JSON.stringify({ access_token: 'access-token', refresh_token: 'refresh-token', expires_in: 1800 }));
    if (url.endsWith('/oauth/token/accessible-resources')) return new Response(JSON.stringify([
      { id: '12345678-1234-1234-1234-123456789012', name: 'Allowed site', url: 'https://allowed.atlassian.net', scopes: ['read:jira-work', 'write:jira-work'] },
      { id: '87654321-1234-1234-1234-123456789012', name: 'Read only', url: 'https://readonly.atlassian.net', scopes: ['read:jira-work'] },
    ]));
    throw new Error(`Unexpected Atlassian URL ${url}`);
  };

  try {
    const authUrl = new URL(jiraAuthorizationUrl('state with spaces'));
    assert.equal(authUrl.origin, 'https://auth.atlassian.com');
    assert.equal(authUrl.searchParams.get('scope'), 'read:jira-work write:jira-work offline_access');
    assert.equal(authUrl.searchParams.get('state'), 'state with spaces');
    const result = await exchangeJiraAuthorizationCode('authorization-code');
    assert.deepEqual(result.sites, [{ id: '12345678-1234-1234-1234-123456789012', name: 'Allowed site', url: 'https://allowed.atlassian.net' }]);
    assert.equal(result.tokens.accessToken, 'access-token');
    assert.equal(JSON.parse(requests[0].options.body).grant_type, 'authorization_code');
    assert.equal(requests[1].options.headers.authorization, 'Bearer access-token');
  } finally {
    globalThis.fetch = previousFetch;
    for (const name of envNames) {
      if (previousEnv[name] === undefined) delete process.env[name];
      else process.env[name] = previousEnv[name];
    }
  }
});
