import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'crewos-solari-usage-'));
const envKeys = ['NODE_ENV', 'DATABASE_URL', 'DATABASE_FILE', 'NEON_AUTH_BASE_URL'];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.DATABASE_FILE = join(directory, 'usage.sqlite');
process.env.NEON_AUTH_BASE_URL = '';
const { getSolariUsageSessions, readSolariUsageResponse } = await import('../backend/lib/solari.mjs');
const { closeDatabase } = await import('../backend/lib/db.mjs');

after(async () => {
  await closeDatabase();
  rmSync(directory, { recursive: true, force: true });
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

test('Solari usage reader preserves the provider payload', async () => {
  const usage = { providerFields: [{ value: 0.2 }], totals: { customMetric: 0.04 } };
  assert.deepEqual(await readSolariUsageResponse(new Response(JSON.stringify(usage))), usage);
});

test('Solari usage reader rejects provider errors, invalid JSON, and oversized responses', async () => {
  await assert.rejects(readSolariUsageResponse(new Response('{}', { status: 403 })), /HTTP 403/);
  await assert.rejects(readSolariUsageResponse(new Response('not json')), /invalid JSON/);
  await assert.rejects(readSolariUsageResponse(new Response(Buffer.alloc(512 * 1024 + 1))), /exceeded 512 KiB/);
});

test('Solari usage lookup queries only supplied session IDs and bounds the batch', async () => {
  const originalFetch = globalThis.fetch;
  const requestedPaths = [];
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    requestedPaths.push(url.pathname);
    const sessionId = decodeURIComponent(url.pathname.split('/').at(-1));
    return new Response(JSON.stringify({ sessionId, billedCostUsd: 0.1 }));
  };
  try {
    assert.deepEqual(await getSolariUsageSessions('test-key', []), { sessions: [], truncated: false });
    assert.deepEqual(requestedPaths, []);

    const ids = Array.from({ length: 26 }, (_, index) => `session:${index}`);
    const usage = await getSolariUsageSessions('test-key', [...ids, ids[0], '', 123]);
    assert.equal(usage.sessions.length, 25);
    assert.equal(usage.truncated, true);
    assert.deepEqual(usage.sessions.map(({ sessionId }) => sessionId), ids.slice(0, 25));
    assert.deepEqual(requestedPaths, ids.slice(0, 25).map((sessionId) => `/api/v1/usage/sessions/${encodeURIComponent(sessionId)}`));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
