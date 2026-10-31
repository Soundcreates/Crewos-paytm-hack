import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'crewos-memory-'));
const envKeys = ['NODE_ENV', 'DATABASE_URL', 'DATABASE_FILE', 'NEON_AUTH_BASE_URL', 'OPENROUTER_API_KEY', 'OPENROUTER_EMBEDDING_MODEL', 'PINECONE_INDEX_HOST', 'PINECONE_API_KEY'];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys) delete process.env[key];
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.DATABASE_FILE = join(directory, 'memory.sqlite');
process.env.NEON_AUTH_BASE_URL = '';

const originalFetch = globalThis.fetch;
const { all, closeDatabase, get, now, run } = await import('../backend/lib/db.mjs');
const { indexPersistedMemory, enqueueMemoryIndexBackfill, persistMeetingMemoryRecord, retrieveMemories, storeMemory } = await import('../backend/build/memory.js');
const { buildMeetingMemoryBody } = await import('solari-crew-core');

const orgId = 'org_memory_a';
const otherOrgId = 'org_memory_b';
const employeeId = 'employee_memory_a';
const otherEmployeeId = 'employee_memory_b';
let clockOffset = 0;

await run('INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)', orgId, 'Memory test workspace', now());
await run('INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)', otherOrgId, 'Other memory workspace', now());
await run('INSERT INTO users(id,name,email,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)', 'user_memory', 'Memory test user', 'memory@example.test', 'salt', 'hash', now());
for (const [id, owner] of [[employeeId, orgId], [otherEmployeeId, orgId]]) {
  await run('INSERT INTO employees(id,org_id,name,title,department,profile_id,state,avatar,x,y,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
    id, owner, id, 'Analyst', 'Operations', null, 'active', 'A', 0.5, 0.5, now(), now());
}

after(async () => {
  await closeDatabase();
  rmSync(directory, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

function configure({ openrouter = false, pinecone = false } = {}) {
  if (openrouter) {
    process.env.OPENROUTER_API_KEY = 'offline-memory-openrouter-key';
    process.env.OPENROUTER_EMBEDDING_MODEL = 'memory-test-embedding';
  } else {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_EMBEDDING_MODEL;
  }
  if (pinecone) {
    process.env.PINECONE_INDEX_HOST = 'https://memory-index.mock';
    process.env.PINECONE_API_KEY = 'offline-memory-pinecone-key';
  } else {
    delete process.env.PINECONE_INDEX_HOST;
    delete process.env.PINECONE_API_KEY;
  }
}

async function withFetch(handler, callback) {
  const requests = [];
  globalThis.fetch = async (input, options = {}) => {
    const request = {
      url: new URL(String(input)),
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body ? JSON.parse(options.body) : undefined,
    };
    requests.push(request);
    return handler(request);
  };
  try { return await callback(requests); }
  finally { globalThis.fetch = originalFetch; }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function embeddingResponse(values = [0.9, 0.1]) {
  return jsonResponse({ model: 'mock-embedding-model', data: [{ embedding: values }], usage: { prompt_tokens: 8, total_tokens: 8 } });
}

async function insertMemory({ id, org = orgId, employee = null, title, body, source = 'test:fixture', kind = 'episodic', embedding = null }) {
  clockOffset += 1;
  await run('INSERT INTO memories(id,org_id,employee_id,kind,title,body,source,confidence,embedding,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    id, org, employee, kind, title, body, source, 1, embedding === null ? null : JSON.stringify(embedding), new Date(Date.now() + clockOffset).toISOString());
}

test('storeMemory durably queues indexing before provider calls and keeps workspace and employee scope', async (t) => {
  configure({ openrouter: true, pinecone: true });
  const usage = [];
  await withFetch(({ url, headers }) => {
    if (url.origin === 'https://openrouter.ai' && url.pathname === '/api/v1/embeddings') {
      assert.equal(headers.authorization, 'Bearer offline-memory-openrouter-key');
      return embeddingResponse([0.8, 0.2]);
    }
    if (url.origin === 'https://memory-index.mock' && url.pathname === '/vectors/upsert') return jsonResponse({ upsertedCount: 1 });
    throw new Error(`Unexpected mocked memory request: ${url.href}`);
  }, async (requests) => {
    const saved = await storeMemory({
      orgId, employeeId, title: '  Refund follow-up  ', body: '  Verify the refund receipt.  ', source: 'test:verified', confidence: 2,
    });
    t.after(() => run('DELETE FROM memories WHERE id=?', saved.id));
    assert.equal(saved.title, 'Refund follow-up');
    assert.equal(saved.body, 'Verify the refund receipt.');
    assert.equal(saved.confidence, 1);
    assert.equal(requests.length, 0, 'saving canonical memory must not wait for a provider');
    const pending = await get('SELECT * FROM background_jobs WHERE dedupe_key=?', `memory:index:${saved.id}`);
    assert.equal(pending.org_id, orgId);
    assert.equal(pending.kind, 'memory.index');
    assert.equal(pending.status, 'queued');
    assert.deepEqual(JSON.parse(pending.payload), { memoryId: saved.id });
    await indexPersistedMemory(saved.id, orgId, undefined, async (entry) => usage.push(entry));
    assert.deepEqual(JSON.parse((await get('SELECT embedding FROM memories WHERE id=?', saved.id)).embedding),[0.8,0.2]);
    assert.deepEqual(usage, [{ model: 'mock-embedding-model', inputTokens: 8, outputTokens: 0, totalTokens: 8 }]);
    const upsert = requests.find(({ url }) => url.pathname === '/vectors/upsert');
    assert.equal(upsert.body.namespace, orgId);
    assert.deepEqual(upsert.body.vectors[0], {
      id: saved.id, values: [0.8, 0.2],
      metadata: { employeeId, visibility: 'employee', kind: 'episodic', title: 'Refund follow-up', source: 'test:verified', confidence: 1, createdAt: saved.created_at, embeddingModel: 'memory-test-embedding', embeddingDimensions: 2 },
    });
    await run('DELETE FROM memories WHERE id=?', saved.id);
  });
});

test('memory indexing retains local vectors on index failure and canonical memory on embedding failure', async (t) => {
  configure({ openrouter: true, pinecone: true });
  let openrouterMode = 'success';
  await withFetch(({ url }) => {
    if (url.origin === 'https://openrouter.ai') return openrouterMode === 'success' ? embeddingResponse([1, 0]) : jsonResponse({ error: 'offline' }, 503);
    if (url.pathname === '/vectors/upsert') return jsonResponse({ error: 'unavailable' }, 503);
    throw new Error(`Unexpected mocked memory request: ${url.href}`);
  }, async (requests) => {
    const fallback = await storeMemory({ orgId, title: 'Fallback vector', body: 'Locally retrievable', source: 'test:fallback' });
    t.after(() => run('DELETE FROM memories WHERE id=?', fallback.id));
    await assert.rejects(indexPersistedMemory(fallback.id, orgId), /Pinecone request failed \(503\)/);
    assert.deepEqual(JSON.parse((await get('SELECT embedding FROM memories WHERE id=?', fallback.id)).embedding), [1, 0]);
    const requestsBeforeFailedEmbedding = requests.length;
    openrouterMode = 'failure';
    const saved = await storeMemory({ orgId, title: 'No embedding', body: 'Still durable', source: 'test:openrouter-failure' });
    t.after(() => run('DELETE FROM memories WHERE id=?', saved.id));
    await assert.rejects(indexPersistedMemory(saved.id, orgId), /Embedding provider unavailable/);
    assert.equal((await get('SELECT embedding FROM memories WHERE id=?', saved.id)).embedding, null);
    assert.equal((await get('SELECT index_status FROM memories WHERE id=?', saved.id)).index_status, 'retry');
    assert.equal(requests.length, requestsBeforeFailedEmbedding + 1);
  });
});

test('retrieveMemories keeps local lexical fallback and enforces workspace and employee filters', async () => {
  configure();
  await insertMemory({ id: 'mem_local_employee', employee: employeeId, title: 'Refund invoice review', body: 'Refund invoice needs follow-up.' });
  await insertMemory({ id: 'mem_local_org', title: 'Refund invoice policy', body: 'Refund invoices follow policy.', kind: 'policy', source: 'policy:refund' });
  await insertMemory({ id: 'mem_local_other_employee', employee: otherEmployeeId, title: 'Refund invoice secret', body: 'Refund invoice private note.' });
  await insertMemory({ id: 'mem_local_other_org', org: otherOrgId, title: 'Refund invoice elsewhere', body: 'Refund invoice from another workspace.' });

  const employeeResults = await retrieveMemories({ orgId, employeeId, query: 'refund invoice' });
  assert.deepEqual(new Set(employeeResults.map(({ id }) => id)), new Set(['mem_local_employee', 'mem_local_org']));
  for (const { id } of employeeResults) assert.equal((await get('SELECT org_id FROM memories WHERE id=?', id)).org_id, orgId);
  const orgResults = await retrieveMemories({ orgId, query: 'refund invoice' });
  assert.ok(orgResults.some(({ id }) => id === 'mem_local_other_employee'));
  for (const { id } of orgResults) assert.equal((await get('SELECT org_id FROM memories WHERE id=?', id)).org_id, orgId);
  assert.deepEqual(await retrieveMemories({ orgId, query: '  ' }), []);
});

test('retrieveMemories ignores malformed stored embedding JSON and still returns lexical matches', async () => {
  configure();
  await run('INSERT INTO memories(id,org_id,employee_id,kind,title,body,source,confidence,embedding,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    'mem_malformed_embedding', orgId, null, 'episodic', 'Durable delivery note', 'Delivery arrived intact.', 'test:corrupt-vector', 1, '{not-json', now());

  const results = await retrieveMemories({ orgId, query: 'durable delivery' });
  assert.ok(results.some(({ id }) => id === 'mem_malformed_embedding'));
});

test('retrieveMemories sends Pinecone employee filters and rejects cross-employee matches', async () => {
  configure({ openrouter: true, pinecone: true });
  await insertMemory({ id: 'mem_remote_a', employee: employeeId, title: 'Violet cavitation report', body: 'Violet cavitation evidence for employee A.' });
  await insertMemory({ id: 'mem_remote_b', employee: otherEmployeeId, title: 'Violet cavitation private', body: 'Violet cavitation evidence for employee B.' });
  await insertMemory({ id: 'mem_remote_org', title: 'Violet cavitation workspace note', body: 'Violet cavitation workspace evidence.' });
  await insertMemory({ id: 'mem_remote_unrelated_recent', title: 'Unrelated recent reminder', body: 'Review the office calendar.', kind:'policy', source:'policy:unrelated-recent' });

  await withFetch(({ url }) => {
    if (url.origin === 'https://openrouter.ai') return embeddingResponse([1, 0]);
    if (url.pathname === '/query') return jsonResponse({ matches: [
      { id: 'mem_remote_b', score: 0.99, metadata:{embeddingModel:'memory-test-embedding',embeddingDimensions:2} },
      { id: 'mem_remote_a', score: 0.85, metadata:{embeddingModel:'memory-test-embedding',embeddingDimensions:2} },
    ] });
    throw new Error(`Unexpected mocked memory request: ${url.href}`);
  }, async (requests) => {
    const results = await retrieveMemories({ orgId, employeeId, query: 'violet cavitation' });
    assert.ok(results.some(({ id }) => id === 'mem_remote_a'));
    assert.ok(results.some(({ id }) => id === 'mem_remote_org'));
    assert.ok(results.every(({ id }) => id !== 'mem_remote_b'));
    assert.ok(results.every(({ id }) => id !== 'mem_remote_unrelated_recent'));
    const query = requests.find(({ url }) => url.pathname === '/query');
    assert.equal(query.body.namespace, orgId);
    assert.deepEqual(query.body.filter, { $or: [
      { employeeId: { $eq: employeeId } },
      { visibility: { $eq: 'org' } },
      { visibility: { $eq: 'task' } },
      { visibility: { $eq: 'team' } },
    ] });
  });

  await withFetch(({ url }) => url.origin === 'https://openrouter.ai' ? embeddingResponse() : jsonResponse({}, 503), async () => {
    const fallback = await retrieveMemories({ orgId, employeeId, query: 'violet cavitation' });
    assert.ok(fallback.some(({ id }) => id === 'mem_remote_a'));
    assert.ok(fallback.every(({ id }) => id !== 'mem_remote_b'));
  });

  await withFetch(({url})=>url.origin==='https://openrouter.ai'?embeddingResponse([1,0]):url.pathname==='/query'?jsonResponse({matches:[]}):jsonResponse({},503),async()=>{
    const noHits=await retrieveMemories({orgId,employeeId,query:'violet cavitation'});
    assert.ok(noHits.some(({id})=>id==='mem_remote_a'),'a vector response with no usable matches retains lexical local fallback');
    assert.ok(noHits.some(({id})=>id==='mem_remote_org'));
    assert.ok(noHits.some(({id})=>id==='mem_remote_unrelated_recent'),'recent local fallback remains available when vector search has no usable matches');
    assert.ok(noHits.every(({id})=>id!=='mem_remote_b'));
  });
});

test('vector candidates are SQL-filtered by task owner, current team membership, owned source, and expiry',async(t)=>{
  configure({openrouter:true,pinecone:true});
  const sourceId='workflow_acl_owned';
  const foreignSourceId='workflow_acl_foreign';
  const taskId='task_acl_owner';
  const teamId='team_acl_current';
  const deniedTeamId='team_acl_not_member';
  const deniedTaskId='task_acl_not_owned';
  const foreignEmployeeId='employee_acl_foreign';
  await run('INSERT INTO employees(id,org_id,name,title,department,profile_id,state,avatar,x,y,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',foreignEmployeeId,otherOrgId,'Foreign ACL owner','Analyst','Operations',null,'active','A',0.5,0.5,now(),now());
  await run('INSERT INTO workflows(id,org_id,employee_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',sourceId,orgId,employeeId,'user_memory','ACL source','completed',now(),now());
  await run('INSERT INTO workflows(id,org_id,employee_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',foreignSourceId,otherOrgId,foreignEmployeeId,'user_memory','Foreign ACL source','completed',now(),now());
  await run('INSERT INTO organization_teams(id,org_id,name,created_at) VALUES(?,?,?,?)',teamId,orgId,'ACL team',now());
  await run('INSERT INTO organization_teams(id,org_id,name,created_at) VALUES(?,?,?,?)',deniedTeamId,orgId,'Non-member ACL team',now());
  await run('INSERT INTO employee_team_memberships(org_id,team_id,employee_id,created_at) VALUES(?,?,?,?)',orgId,teamId,employeeId,now());
  await run(`INSERT INTO crew_tasks(id,org_id,owner_employee_id,capability,goal,idempotency_key,correlation_id,runtime_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,taskId,orgId,employeeId,'memory.read','ACL task','task-acl-key','task-acl-correlation','chief-dag-v1',now(),now());
  await run(`INSERT INTO crew_tasks(id,org_id,owner_employee_id,capability,goal,idempotency_key,correlation_id,runtime_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,deniedTaskId,orgId,otherEmployeeId,'memory.read','Not-owned ACL task','task-acl-denied-key','task-acl-denied-correlation','chief-dag-v1',now(),now());
  const cases=[
    ['mem_acl_team_allowed','team',JSON.stringify([teamId]),'[]',sourceId,null],
    ['mem_acl_task_allowed','task','[]',JSON.stringify([taskId]),sourceId,null],
    ['mem_acl_team_member_denied','team',JSON.stringify([deniedTeamId]),'[]',sourceId,null],
    ['mem_acl_task_owner_denied','task','[]',JSON.stringify([deniedTaskId]),sourceId,null],
    ['mem_acl_source_foreign','team',JSON.stringify([teamId]),'[]',foreignSourceId,null],
    ['mem_acl_expired','team',JSON.stringify([teamId]),'[]',sourceId,'2020-01-01T00:00:00.000Z'],
  ];
  const ids=[];
  for (const [memoryId,visibility,teams,tasks,source,expires] of cases) {
    ids.push(memoryId);
    await insertMemory({id:memoryId,title:'Citrine ACL retrieval evidence',body:`Citrine ${memoryId} memory`,source:`workflow:${source}`});
    await run('INSERT INTO memory_acl_metadata(memory_id,org_id,visibility,team_ids,task_ids,source_type,source_id,owner_user_id,owner_employee_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',memoryId,orgId,visibility,teams,tasks,'workflow',source,null,null,expires,now());
  }
  t.after(async()=>{for(const memoryId of ids){await run('DELETE FROM memory_acl_metadata WHERE memory_id=?',memoryId);await run('DELETE FROM memories WHERE id=?',memoryId);}await run('DELETE FROM crew_tasks WHERE id IN (?,?)',taskId,deniedTaskId);await run('DELETE FROM organization_teams WHERE id IN (?,?)',teamId,deniedTeamId);await run('DELETE FROM workflows WHERE id IN (?,?)',sourceId,foreignSourceId);await run('DELETE FROM employees WHERE id=? AND org_id=?',foreignEmployeeId,otherOrgId);});
  const matches=ids.map(id=>({id,score:0.9,metadata:{embeddingModel:'memory-test-embedding',embeddingDimensions:2}}));
  const visible=await withFetch(({url})=>url.origin==='https://openrouter.ai'?embeddingResponse([1,0]):url.pathname==='/query'?jsonResponse({matches}):jsonResponse({},503),async()=>retrieveMemories({orgId,employeeId,taskId,query:'citrine ACL retrieval'}));
  assert.deepEqual(new Set(visible.map(row=>row.id)),new Set(['mem_acl_team_allowed','mem_acl_task_allowed']));
  const wrongEmployee=await withFetch(({url})=>url.origin==='https://openrouter.ai'?embeddingResponse([1,0]):url.pathname==='/query'?jsonResponse({matches}):jsonResponse({},503),async()=>retrieveMemories({orgId,employeeId:otherEmployeeId,taskId,query:'citrine ACL retrieval'}));
  assert.equal(wrongEmployee.some(row=>row.id.startsWith('mem_acl_')),false);
  const wrongTaskOwner=await withFetch(({url})=>url.origin==='https://openrouter.ai'?embeddingResponse([1,0]):url.pathname==='/query'?jsonResponse({matches}):jsonResponse({},503),async()=>retrieveMemories({orgId,employeeId,taskId:deniedTaskId,query:'citrine ACL retrieval'}));
  assert.equal(wrongTaskOwner.some(row=>row.id==='mem_acl_task_owner_denied'),false);
});

test('indexPersistedMemory indexes existing records, records usage, and preserves local fallback on index outage', async () => {
  configure({ openrouter: true, pinecone: true });
  await insertMemory({ id: 'mem_to_index_success', employee: employeeId, title: 'Remote indexed memory', body: 'Index accepted this content.' });
  await insertMemory({ id: 'mem_to_index', employee: employeeId, title: 'Indexed memory', body: 'Existing content.' });
  const usage = [];
  const successUsage = [];
  await withFetch(({ url, body }) => {
    if (url.origin === 'https://openrouter.ai') return embeddingResponse([0.6, 0.4]);
    if (url.pathname === '/vectors/upsert') return body.vectors[0].id === 'mem_to_index_success' ? jsonResponse({}) : jsonResponse({}, 503);
    throw new Error(`Unexpected mocked memory request: ${url.href}`);
  }, async (requests) => {
    await indexPersistedMemory('missing_memory', orgId);
    assert.equal(requests.length, 0);
    await indexPersistedMemory('mem_to_index_success', orgId, undefined, (entry) => successUsage.push(entry));
    assert.deepEqual(JSON.parse((await get('SELECT embedding FROM memories WHERE id=?', 'mem_to_index_success')).embedding),[0.6,0.4]);
    assert.deepEqual(successUsage, [{ model: 'mock-embedding-model', inputTokens: 8, outputTokens: 0, totalTokens: 8 }]);
    await assert.rejects(indexPersistedMemory('mem_to_index', orgId, undefined, (entry) => usage.push(entry)),/Pinecone request failed \(503\)/);
    assert.deepEqual(JSON.parse((await get('SELECT embedding FROM memories WHERE id=?', 'mem_to_index')).embedding), [0.6, 0.4]);
    assert.deepEqual(usage, [{ model: 'mock-embedding-model', inputTokens: 8, outputTokens: 0, totalTokens: 8 }]);
    const vector = requests.find(({ url, body }) => url.pathname === '/vectors/upsert' && body.vectors[0].id === 'mem_to_index_success').body.vectors[0];
    assert.equal(vector.metadata.employeeId, employeeId);
    assert.equal(vector.metadata.visibility, 'employee');
  });
});

test('persistMeetingMemoryRecord validates completed meeting evidence and remains idempotent', async () => {
  const meetingId = 'meeting_memory_record';
  const agenda = ['Review launch readiness'];
  const decisions = { positions: [], decisions: ['Ship after checklist'], actions: [{ title: 'Draft launch checklist' }] };
  await run('INSERT INTO meetings(id,org_id,title,agenda,participant_ids,status,decisions,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    meetingId, orgId, 'Launch review', JSON.stringify(agenda), '[]', 'completed', JSON.stringify(decisions), 'user_memory', now(), now());
  const body = buildMeetingMemoryBody({ agenda, ...decisions, messages: [] });
  const input = { orgId, title: 'Meeting: Launch review', body, source: `meeting:${meetingId}`, confidence: 1.5 };
  const id = await persistMeetingMemoryRecord(input);
  assert.equal(id, `mem_${meetingId}`);
  assert.equal(await persistMeetingMemoryRecord(input), id);
  const row = await get('SELECT kind,confidence,body FROM memories WHERE id=?', id);
  assert.equal(row.kind, 'meeting');
  assert.equal(row.confidence, 1);
  assert.equal(row.body, body);
  await assert.rejects(persistMeetingMemoryRecord({ ...input, body: 'fabricated meeting summary' }), /must match the recorded agenda/);
  await assert.rejects(persistMeetingMemoryRecord({ ...input, source: 'manual:meeting' }), /meeting source ID/);
  await assert.rejects(persistMeetingMemoryRecord({ ...input, title: ' ' }), /title, content, and a source/);
});

test('memory backfill queues every workspace in bounded batches and retains vectors until reindexing', async () => {
  configure({ pinecone: true });
  await run('UPDATE memories SET embedding=NULL');
  await insertMemory({ id: 'mem_migrate_a1', employee: employeeId, title: 'A1', body: 'Legacy A1', embedding: [1, 0] });
  await insertMemory({ id: 'mem_migrate_a2', title: 'A2', body: 'Legacy A2', embedding: [0, 1] });
  await insertMemory({ id: 'mem_migrate_a3', title: 'A3', body: 'Legacy A3', embedding: [0.5, 0.5] });
  await insertMemory({ id: 'mem_migrate_b1', org: otherOrgId, title: 'B1', body: 'Legacy B1', embedding: [0.2, 0.8] });

  await withFetch(({ url }) => {
    if (url.pathname !== '/vectors/upsert') throw new Error(`Unexpected mocked memory request: ${url.href}`);
    throw new Error('Backfill must queue work without calling the vector provider');
  }, async (requests) => {
    const total = (await get('SELECT COUNT(*) AS count FROM memories')).count;
    const result = await enqueueMemoryIndexBackfill(2);
    assert.equal(result.queued, total);
    assert.equal(requests.length, 0);
    const jobs = await all('SELECT * FROM background_jobs WHERE dedupe_key LIKE ?', `memory:reindex:${result.runId}:%`);
    assert.equal(jobs.length, total);
    for (const job of jobs) {
      const payload = JSON.parse(job.payload);
      const memory = await get('SELECT org_id,index_status FROM memories WHERE id=?', payload.memoryId);
      assert.equal(job.org_id, memory.org_id);
      assert.equal(payload.forceReembed, true);
      assert.equal(memory.index_status, 'pending');
    }
    const next = await enqueueMemoryIndexBackfill(2);
    assert.notEqual(result.runId, next.runId, 'a new backfill must not reuse completed job identities');
  });
  assert.equal(await get('SELECT COUNT(*) AS count FROM memories WHERE id LIKE ?', 'mem_migrate_%').then(({ count }) => count), 4);
  assert.equal(await get('SELECT COUNT(*) AS count FROM memories WHERE id LIKE ? AND embedding IS NOT NULL', 'mem_migrate_%').then(({ count }) => count), 4);
  await assert.rejects(enqueueMemoryIndexBackfill(0), /batch size must be between 1 and 500/);
  await assert.rejects(enqueueMemoryIndexBackfill(501), /batch size must be between 1 and 500/);
  configure();
  assert.ok((await enqueueMemoryIndexBackfill()).queued > 0, 'offline backfills remain durable until a provider is configured');
});
