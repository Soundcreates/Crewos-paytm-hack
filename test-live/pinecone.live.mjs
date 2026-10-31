import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const { PINECONE_INDEX_HOST, PINECONE_API_KEY, OPENROUTER_API_KEY } = process.env;
const skip = !PINECONE_INDEX_HOST || !PINECONE_API_KEY || !OPENROUTER_API_KEY
  ? 'PINECONE_INDEX_HOST, PINECONE_API_KEY, and OPENROUTER_API_KEY must all be set to run this check.'
  : false;

const directory = mkdtempSync(join(tmpdir(), 'crewos-pinecone-live-'));
process.env.DATABASE_URL = '';
process.env.NEON_AUTH_BASE_URL = '';
process.env.DATABASE_FILE = join(directory, 'pinecone-live.sqlite');

after(async () => {
  const { closeDatabase } = await import('../backend/lib/db.mjs');
  await closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

async function pineconeFetch(path, body) {
  const response = await fetch(`${PINECONE_INDEX_HOST}${path}`, {
    method: 'POST',
    headers: { 'Api-Key': PINECONE_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Pinecone request to ${path} failed (${response.status}): ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

async function pineconeVectorsById(ids, namespace) {
  const params = new URLSearchParams({ namespace });
  for (const vectorId of ids) params.append('ids', vectorId);
  const response = await fetch(`${PINECONE_INDEX_HOST}/vectors/fetch?${params}`, { headers: { 'Api-Key': PINECONE_API_KEY } });
  if (!response.ok) throw new Error(`Pinecone fetch failed (${response.status}): ${await response.text()}`);
  return response.json();
}

test('live Pinecone: a stored memory upserts into the real index and comes back on query', { skip }, async () => {
  const { run, now } = await import('../backend/lib/db.mjs');
  const { storeMemory, retrieveMemories } = await import('../backend/build/memory.js');
  const orgId = `org_live_${Date.now().toString(36)}`;
  await run('INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)', orgId, 'Live Acceptance Org', now());
  const title = 'Live acceptance probe memory';
  const body = `This is a disposable live-acceptance memory created at ${new Date().toISOString()} to verify the Pinecone round trip.`;

  const memory = await storeMemory({ orgId, title, body, source: 'live-acceptance-probe', apiKey: OPENROUTER_API_KEY });
  assert.ok(memory?.id, 'expected storeMemory to persist a row');

  try {
    const stats = await pineconeFetch('/describe_index_stats', { filter: {} });
    assert.ok(stats, 'expected Pinecone to report index stats');

    const found = await pineconeVectorsById([memory.id], orgId);
    assert.ok(found.vectors?.[memory.id], 'expected the stored memory to actually land in the live Pinecone namespace, not only the local fallback');

    const ranked = await retrieveMemories({ orgId, query: 'disposable live-acceptance memory Pinecone round trip', apiKey: OPENROUTER_API_KEY });
    assert.ok(ranked.some((row) => row.id === memory.id), 'expected the live-indexed memory to be retrievable by semantic query');
  } finally {
    await pineconeFetch('/vectors/delete', { ids: [memory.id], namespace: orgId }).catch(() => {});
  }
});
