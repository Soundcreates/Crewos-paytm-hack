import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CrewOSClient } from '../backend/lib/client.mjs';

function jsonResponse(value, cookies = []) {
  return {
    status: 200,
    ok: true,
    headers: {
      getSetCookie: () => cookies,
      get: (name) => name === 'content-type' ? 'application/json' : null,
    },
    json: async () => value,
    text: async () => JSON.stringify(value),
  };
}

test('Node SDK signs in through Neon Auth and keeps both session cookies', async () => {
  const calls = [];
  const client = new CrewOSClient({
    baseUrl: 'https://crew.example.test',
    fetchImpl: async (url, options) => {
      calls.push({ path: url.pathname, options });
      if (url.pathname === '/api/config') return jsonResponse({ authProvider: 'neon' });
      if (url.pathname === '/api/auth/neon/sign-in/email') return jsonResponse({ user: { id: 'neon-user' } }, [
        'neon.session=auth-value; Path=/; HttpOnly; Secure',
        'neon.csrf=csrf-value; Path=/; Secure',
      ]);
      if (url.pathname === '/api/auth/login') return jsonResponse({ user: { id: 'app-user' } }, [
        'crewos_session=app-value; Path=/; HttpOnly; Secure',
      ]);
      if (url.pathname === '/api/auth/me') return jsonResponse({ user: { id: 'app-user' } });
      if (url.pathname === '/api/auth/neon/sign-out') return jsonResponse({ ok: true }, [
        'neon.session=; Path=/; HttpOnly; Secure; Max-Age=0',
      ]);
      if (url.pathname === '/api/auth/logout') return jsonResponse({ ok: true }, [
        'crewos_session=; Path=/; HttpOnly; Secure; Max-Age=0',
      ]);
      throw new Error(`Unexpected path ${url.pathname}`);
    },
  });

  await client.login({ email: 'one@example.test', password: 'password' });
  assert.equal(client.cookies.has('crewos_session'), true);
  assert.match(client.cookie, /neon\.session=auth-value/);
  assert.match(client.cookie, /neon\.csrf=csrf-value/);
  assert.match(client.cookie, /crewos_session=app-value/);
  assert.equal(calls.find(({ path }) => path === '/api/auth/neon/sign-in/email').options.headers.origin, 'https://crew.example.test');
  assert.deepEqual(JSON.parse(calls.find(({ path }) => path === '/api/auth/login').options.body), { email: 'one@example.test' });

  await client.me();
  const cookieBeforeLogout = client.cookie;
  await client.logout();
  assert.equal(calls.find(({ path }) => path === '/api/auth/neon/sign-out').options.headers.cookie, cookieBeforeLogout);
  assert.match(calls.find(({ path }) => path === '/api/auth/logout').options.headers.cookie, /crewos_session=app-value/);
  assert.equal(client.cookie, '');
});

test('SDK never sends a Secure cookie over HTTP', () => {
  const client = new CrewOSClient({ baseUrl: 'http://127.0.0.1:4173', fetchImpl: async () => jsonResponse({}) });
  client.rememberCookies({
    getSetCookie: () => ['secure=value; Secure; Path=/', 'local=value; Path=/'],
    get: () => null,
  });
  assert.equal(client.cookie, 'local=value');
});
