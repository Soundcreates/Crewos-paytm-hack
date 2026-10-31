import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import pg from 'pg';

const { DATABASE_URL, NEON_AUTH_BASE_URL, APP_MASTER_KEY } = process.env;
const skip = !DATABASE_URL || !NEON_AUTH_BASE_URL
  ? 'DATABASE_URL and NEON_AUTH_BASE_URL are not both set; configure the live Neon pair to run this check.'
  : false;

process.env.NODE_ENV = 'production';
process.env.APP_ORIGIN = process.env.APP_ORIGIN || 'http://localhost:4173';
process.env.APP_MASTER_KEY = APP_MASTER_KEY || 'live-acceptance-master-key-only-for-this-run';

function mockResponse() {
  const headers = new Map();
  return {
    headersSent: false, statusCode: 0, body: '',
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    writeHead(status, values = {}) { this.statusCode = status; for (const [n, v] of Object.entries(values)) this.setHeader(n, v); this.headersSent = true; return this; },
    end(body = '') { this.body = String(body); this.headersSent = true; },
    destroy() {},
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

function cookieJarFrom(initial = '') {
  let jar = initial;
  return {
    get header() { return jar; },
    remember(res) {
      const raw = res.getHeader('set-cookie');
      for (const cookie of Array.isArray(raw) ? raw : raw ? [raw] : []) {
        const pair = cookie.split(';')[0];
        const name = pair.split('=')[0];
        jar = [...jar.split('; ').filter(Boolean).filter((entry) => !entry.startsWith(`${name}=`)), pair].join('; ');
      }
    },
  };
}

test('live Neon: Postgres is reachable and holds the application schema', { skip }, async () => {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query("SELECT to_regclass('public.organizations') AS present");
    assert.ok(result.rows[0].present, 'expected the organizations table to exist on the configured Neon branch');
  } finally {
    await client.end();
  }
});

test('live Neon: sign-up, session restore, sign-out, and the pre-verification access gate', { skip }, async () => {
  const { handleHttpRequest } = await import('../backend/server.mjs');
  const jar = cookieJarFrom();
  const request = async (method, path, body) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = Readable.from(payload ? [payload] : []);
    req.method = method;
    req.url = path;
    req.headers = {
      host: 'localhost:4173',
      ...(method !== 'GET' ? { origin: process.env.APP_ORIGIN } : {}),
      ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
      ...(jar.header ? { cookie: jar.header } : {}),
    };
    req.socket = { encrypted: false, remoteAddress: '127.0.0.1' };
    const res = mockResponse();
    await handleHttpRequest(req, res);
    jar.remember(res);
    return res;
  };

  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `capy-live-${stamp}@example.com`;

  const intent = await request('POST', '/api/auth/signup-intent', { email, name: 'Capy Live Acceptance', organization: `Capy Live Acceptance ${stamp}` });
  assert.equal(intent.statusCode, 200, intent.body);

  const signUp = await request('POST', '/api/auth/neon/sign-up/email', { name: 'Capy Live Acceptance', email, password: randomBytes(24).toString('base64url') });
  assert.equal(signUp.statusCode, 200, signUp.body);
  const signUpUser = signUp.json().user;
  assert.equal(signUpUser.email, email);
  assert.equal(signUpUser.emailVerified, false, 'a fresh Neon Auth account should require email verification before app access');

  const restored = await request('GET', '/api/auth/neon/get-session');
  assert.equal(restored.statusCode, 200);
  assert.equal(restored.json()?.user?.email, email, 'the session should restore from the cookie set by sign-up');

  const blockedSignup = await request('POST', '/api/auth/signup', {});
  assert.equal(blockedSignup.statusCode, 403, blockedSignup.body);
  assert.equal(blockedSignup.json().error, 'email_verification_required');

  const protectedRead = await request('GET', '/api/employees');
  assert.equal(protectedRead.statusCode, 401, 'an unverified identity must not reach protected workspace API routes');

  const signOut = await request('POST', '/api/auth/neon/sign-out', {});
  assert.equal(signOut.statusCode, 200, signOut.body);
  const afterSignOut = await request('GET', '/api/auth/neon/get-session');
  assert.equal(afterSignOut.json(), null, 'the session should be gone after sign-out');
});
