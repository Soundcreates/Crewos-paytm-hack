import assert from 'node:assert/strict';
import test from 'node:test';
import { neonAuthEndpoint, parseNeonAuthSession, rewriteNeonAuthCookie, stripApplicationSessionCookie, validateNeonAuthBaseUrl, validateNeonBranchPair } from '../backend/lib/neon-auth.mjs';

test('Neon Auth endpoint stays under the configured HTTPS auth path', () => {
  const url = neonAuthEndpoint('https://ep-main.neonauth.us-east-2.aws.neon.tech/neondb/auth', 'sign-in/email', '?returnTo=%2F');
  assert.equal(url.href, 'https://ep-main.neonauth.us-east-2.aws.neon.tech/neondb/auth/sign-in/email?returnTo=%2F');
  assert.throws(() => validateNeonAuthBaseUrl('http://localhost/neondb/auth'), /HTTPS/);
  assert.throws(() => neonAuthEndpoint('https://ep-main.neonauth.us-east-2.aws.neon.tech/neondb/auth', '../admin'), /Invalid Neon Auth route/);
});

test('Neon Postgres and Auth URLs must identify the same branch and database', () => {
  const databaseUrl = 'postgresql://app:secret@ep-main-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require';
  const authUrl = 'https://ep-main.neonauth.us-east-2.aws.neon.tech/neondb/auth';
  assert.equal(validateNeonBranchPair(databaseUrl, authUrl).href, authUrl);
  assert.throws(() => validateNeonBranchPair(databaseUrl, 'https://ep-preview.neonauth.us-east-2.aws.neon.tech/neondb/auth'), /same Neon branch and database/);
  assert.throws(() => validateNeonBranchPair(databaseUrl, 'https://ep-main.neonauth.us-east-2.aws.neon.tech/otherdb/auth'), /same Neon branch and database/);
  assert.throws(() => validateNeonBranchPair('postgresql://app:secret@db.example.test/neondb', 'https://auth.example.test/neondb/auth'), /same Neon branch and database/);
});

test('Neon Auth session parsing accepts valid identities and rejects incomplete or unverified users', () => {
  const parsed = parseNeonAuthSession({ user: { id: 'neon-user-1', email: 'one@example.test', name: 'One', emailVerified: true }, session: { id: 's1' } });
  assert.deepEqual(parsed, {
    user: { id: 'neon-user-1', email: 'one@example.test', name: 'One', emailVerified: true },
    session: { id: 's1' },
  });
  assert.equal(parseNeonAuthSession({ user: { id: 'neon-user-2', email: 'two@example.test' } }).user.emailVerified, false);
  assert.equal(parseNeonAuthSession({ user: { id: 'neon-user-3' } }), null);
  assert.equal(parseNeonAuthSession(null), null);
});

test('Neon Auth cookies can be proxied as same-origin cookies without upstream domains', () => {
  assert.equal(rewriteNeonAuthCookie('neon.session=x; Path=/dbname/auth; Domain=auth.neon.tech; HttpOnly; Secure'), 'neon.session=x; HttpOnly; Secure; Path=/');
  assert.equal(rewriteNeonAuthCookie('neon.session=x; Path=/; HttpOnly'), 'neon.session=x; HttpOnly; Path=/');
});

test('Neon Auth requests do not forward the app session cookie', () => {
  assert.equal(stripApplicationSessionCookie('neon.session=x; crewos_session=private; crewos_jira_oauth=state; theme=dark'), 'neon.session=x; theme=dark');
  assert.equal(stripApplicationSessionCookie('crewos_session=private; crewos_jira_oauth=state'), '');
});
