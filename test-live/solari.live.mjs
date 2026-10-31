import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const { SOLARI_API_KEY } = process.env;
const skip = !SOLARI_API_KEY ? 'SOLARI_API_KEY is not set; configure it to run this check.' : false;

const directory = mkdtempSync(join(tmpdir(), 'crewos-solari-live-'));
process.env.DATABASE_URL = '';
process.env.NEON_AUTH_BASE_URL = '';
process.env.DATABASE_FILE = join(directory, 'solari-live.sqlite');

after(async () => {
  const { closeDatabase } = await import('../backend/lib/db.mjs');
  await closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

test('live Solari: profile listing reaches the real gateway', { skip }, async () => {
  const { run, now } = await import('../backend/lib/db.mjs');
  const { listSolariProfiles } = await import('../backend/lib/solari.mjs');
  const orgId = `org_live_${Date.now().toString(36)}`;
  await run('INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)', orgId, 'Live Acceptance Org', now());
  const profiles = await listSolariProfiles(orgId, SOLARI_API_KEY);
  assert.ok(Array.isArray(profiles), 'expected a profile array from the live Solari gateway');
});

test('live Solari: a fresh sandbox runs a real command and reports its launch time', { skip }, async () => {
  const { runSolariTool } = await import('../backend/lib/solari.mjs');
  const message = `capy-live-${Date.now()}`;
  const result = await runSolariTool('org_live_sandbox', 'solari.sandbox.echo', { message }, SOLARI_API_KEY);
  assert.equal(result.ok, true, `expected the sandbox echo to exit 0, got ${JSON.stringify(result)}`);
  assert.equal(result.exitCode, 0);
  assert.ok(String(result.stdout || '').includes(message), 'expected the sandbox to echo back the requested message');
  assert.ok(Number.isFinite(result.launchMs) && result.launchMs > 0, 'expected a recorded sandbox launch time');
  console.log(`[live-acceptance] Solari sandbox launch took ${result.launchMs}ms (report acceptance target: <2000ms).`);
});

test('live Solari: a fresh browser opens a real page and reports its launch time', { skip }, async (t) => {
  const { runSolariTool } = await import('../backend/lib/solari.mjs');
  let result;
  try {
    result = await runSolariTool('org_live_browser', 'solari.browser.open', { url: 'https://example.com/' }, SOLARI_API_KEY);
  } catch (error) {
    if (error.code === 'FeatureRequiresPlan') {
      t.skip(`The connected Solari account's plan does not include stealth browser sessions (${error.message}); upgrade the Solari plan to validate live browser acceptance.`);
      return;
    }
    throw error;
  }
  assert.equal(result.ok, true, `expected the browser open to succeed, got ${JSON.stringify(result)}`);
  assert.equal(result.httpStatus, 200);
  assert.ok(result.title.toLowerCase().includes('example'), `expected the real example.com title, got ${JSON.stringify(result.title)}`);
  assert.ok(Number.isFinite(result.launchMs) && result.launchMs > 0, 'expected a recorded browser launch time');
  console.log(`[live-acceptance] Solari browser launch took ${result.launchMs}ms (report acceptance target: <2000ms).`);
});
