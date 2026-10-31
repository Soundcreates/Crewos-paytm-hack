import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateBrowserActions, validatePublicBrowserTarget, verifySandboxEcho } from 'solari-crew-core';

const directory = mkdtempSync(join(tmpdir(), 'crewos-solari-session-'));
const envKeys = ['NODE_ENV', 'DATABASE_URL', 'DATABASE_FILE', 'NEON_AUTH_BASE_URL'];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.DATABASE_FILE = join(directory, 'session.sqlite');
process.env.NEON_AUTH_BASE_URL = '';
const { assertPublicHost, isPrivateAddress, selectSolariBrowserContext, validateSolariBrowserSession } = await import('../backend/lib/solari.mjs');
const { closeDatabase } = await import('../backend/lib/db.mjs');

after(async () => {
  await closeDatabase();
  rmSync(directory, { recursive: true, force: true });
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

const sessionId = 'pool-fast-1:11111111-2222-3333-4444-555555555555:org_test:1752652800000.YWJjZGVmZ2hpamts';
const session = {
  id: sessionId,
  status: 'active',
  org: 'org_test',
  wsEndpoint: `wss://api.getsolari.com/ws/${encodeURIComponent(sessionId)}`,
};

test('validates an active Solari browser session against the configured gateway', () => {
  assert.equal(validateSolariBrowserSession(sessionId, session), session.wsEndpoint);
  const localSession = { ...session, wsEndpoint: `ws://localhost:4321/ws/${encodeURIComponent(sessionId)}` };
  assert.equal(validateSolariBrowserSession(sessionId, localSession, 'http://localhost:4321'), localSession.wsEndpoint);
});

test('rejects inactive, mismatched, or unsafe Solari session endpoints', () => {
  for (const invalid of [
    { ...session, id: 'another-session' },
    { ...session, org: 'org_else' },
    { ...session, status: 'released' },
    { ...session, wsEndpoint: session.wsEndpoint.replace('wss:', 'ws:') },
    { ...session, wsEndpoint: session.wsEndpoint.replace('api.getsolari.com', 'attacker.example') },
    { ...session, wsEndpoint: session.wsEndpoint.replace('/ws/', '/cdp/') },
    { ...session, wsEndpoint: `${session.wsEndpoint}?token=leak` },
    { ...session, wsEndpoint: `${session.wsEndpoint}#fragment` },
    { ...session, wsEndpoint: session.wsEndpoint.replace('wss://', 'wss://user@') },
  ]) {
    assert.throws(() => validateSolariBrowserSession(sessionId, invalid));
  }
  assert.throws(
    () => validateSolariBrowserSession(sessionId, { ...session, status: 'unknown' }),
    /could not be confirmed active/,
  );
  assert.throws(
    () => validateSolariBrowserSession(sessionId, { ...session, status: 'released' }),
    (error) => error.code === 'solari_session_ended',
  );
});

test('uses Solari SDK primary context when it is not the first browser context', () => {
  const unseededContext = { pages: () => [] };
  const profileSeededContext = { pages: () => [] };
  const browser = {
    context: profileSeededContext,
    contexts: () => [unseededContext, profileSeededContext],
  };

  assert.equal(selectSolariBrowserContext(browser), profileSeededContext);
});

test('reattaches through the context containing the existing workflow page', () => {
  const unseededContext = { pages: () => [] };
  const workflowPage = { url: () => 'https://example.test/dashboard' };
  const profileSeededContext = { pages: () => [workflowPage] };
  const browser = { contexts: () => [unseededContext, profileSeededContext] };

  assert.equal(selectSolariBrowserContext(browser), profileSeededContext);
});

test('does not guess a raw browser context if no workflow page identifies it', () => {
  const browser = { contexts: () => [{ pages: () => [] }, { pages: () => [{ url: () => 'about:blank' }] }] };

  assert.throws(() => selectSolariBrowserContext(browser), /did not expose its primary context/);
});

test('requires browser text verification after the final mutation', () => {
  assert.throws(() => validateBrowserActions([
    { action: 'assertText', text: 'Saved' },
    { action: 'click', selector: 'button[type="submit"]' },
  ]), /after the final browser change/);
  assert.equal(validateBrowserActions([
    { action: 'click', selector: 'button[type="submit"]' },
    { action: 'assertText', text: 'Saved' },
  ]).length, 2);
});

test('sandbox echo verification checks the requested output as well as its exit code', () => {
  assert.equal(verifySandboxEcho({ message: 'hello' }, { exitCode: 0, stdout: 'hello\n' }).verified, true);
  assert.equal(verifySandboxEcho({ message: 'hello' }, { exitCode: 0, stdout: 'wrong\n' }).verified, false);
  assert.equal(verifySandboxEcho({ message: 'hello' }, { exitCode: 1, stdout: 'hello\n' }).verified, false);
});

test('accepts only credential-free HTTP browser targets', () => {
  assert.equal(validatePublicBrowserTarget('https://example.com/path').hostname, 'example.com');
  assert.throws(() => validatePublicBrowserTarget('file:///etc/passwd'), /HTTP or HTTPS/);
  assert.throws(() => validatePublicBrowserTarget('https://user:password@example.com'), /without embedded credentials/);
});

test('blocks private, loopback, and link-local browser destinations', async () => {
  for (const address of ['0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(isPrivateAddress(address), true, address);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  await assert.rejects(assertPublicHost('localhost'), /Private network targets/);
  await assert.rejects(assertPublicHost('127.0.0.1'), /Private network targets/);
  await assertPublicHost('8.8.8.8');
});
