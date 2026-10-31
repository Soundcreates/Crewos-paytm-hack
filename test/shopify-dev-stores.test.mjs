import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createShopifyDevStoreService } from '../backend/src/services/shopify-dev-stores.mjs';
import { shopifyDevStoreSchema } from '../backend/lib/shopify-dev-store-schema.mjs';
import { createCommerceV2Controller } from '../backend/src/controllers/commerce-v2-controller.mjs';

function fixture(execute) {
  let row = null;
  const get = async (sql, ...args) => sql.includes('sarvam_voice_sessions')
    ? args[0] === 'org-a' && args[1] === 'voice-a' && args[2] === 'manager-a' ? { id: 'voice-a', org_id: 'org-a', user_id: 'manager-a', state: 'ended' } : null
    : row && row.org_id === args[0] && row.voice_session_id === args[1] ? { ...row } : null;
  const run = async (sql, ...args) => {
    if (sql.startsWith('INSERT')) {
      if (row) return { changes: 0 };
      row = { id: args[0], org_id: args[1], voice_session_id: args[2], manager_user_id: args[3], store_name: args[4], status: 'creating', created_at: args[5], updated_at: args[6] };
      return { changes: 1 };
    }
    if (sql.includes("status='ready'") && row?.status === 'creating') { row.status = 'ready'; row.store_domain = args[0]; row.updated_at = args[1]; return { changes: 1 }; }
    if (sql.includes("status='uncertain'") && row?.status === 'creating') { row.status = 'uncertain'; row.error_code = 'creation_outcome_unknown'; row.updated_at = args[0]; return { changes: 1 }; }
    return { changes: 0 };
  };
  return createShopifyDevStoreService({ get, run, newId: () => 'request-a', timestamp: () => new Date().toISOString(), env: { SHOPIFY_DEV_STORE_ENABLED: 'true', SHOPIFY_DEV_ORGANIZATION_ID: '123456', SHOPIFY_DEV_STORE_PLAN: 'basic', SHOPIFY_SERVICE_ACCOUNT_TOKEN: 'fixture-token', PATH: '/bin', HOME: '/tmp' }, execute });
}
const request = { orgId: 'org-a', userId: 'manager-a', voiceSessionId: 'voice-a', name: 'Acme shoes' };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('one completed interview creates at most one bounded development store request', async () => {
  let release, calls = 0, received;
  const pending = new Promise(resolve => { release = resolve; });
  const service = fixture(async (...args) => { calls++; received = args; return pending; });
  assert.equal((await service.create(request)).status, 'creating');
  assert.equal((await service.create(request)).status, 'creating');
  assert.equal(calls, 1);
  assert.deepEqual(received[1], ['store', 'create', 'dev', '--name', 'Acme shoes', '--organization-id', '123456', '--plan', 'basic', '--json']);
  assert.equal(received[2].env.SHOPIFY_SERVICE_ACCOUNT_TOKEN, 'fixture-token');
  release({ stdout: JSON.stringify({ store: { domain: 'acme-shoes.myshopify.com' }, organization: { id: '123456' } }) });
  await tick();
  assert.deepEqual(await service.read('org-a', 'voice-a'), { id: 'request-a', voiceSessionId: 'voice-a', name: 'Acme shoes', status: 'ready', storeDomain: 'acme-shoes.myshopify.com', storeUrl: 'https://acme-shoes.myshopify.com', errorCode: null });
  await assert.rejects(service.create({ ...request, name: 'Other store' }), { code: 'dev_store_request_conflict' });
});

test('unverified sessions and uncertain Shopify outcomes never trigger duplicate creations', async () => {
  let calls = 0;
  const service = fixture(async () => { calls++; throw new Error('network failure'); });
  await assert.rejects(service.create({ ...request, orgId: 'other' }), { code: 'dev_store_session_invalid' });
  assert.equal(calls, 0);
  await service.create(request);
  await tick();
  assert.equal((await service.read('org-a', 'voice-a')).status, 'uncertain');
  assert.equal((await service.create(request)).status, 'uncertain');
  assert.equal(calls, 1);
});

test('SQLite reserves a store per tenant and completed interview before the provider call', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE organizations(id TEXT PRIMARY KEY);
      CREATE TABLE users(id TEXT PRIMARY KEY);
      CREATE TABLE sarvam_voice_sessions(id TEXT PRIMARY KEY,org_id TEXT NOT NULL,user_id TEXT NOT NULL,state TEXT NOT NULL,session_type TEXT NOT NULL,UNIQUE(org_id,id));
      INSERT INTO organizations VALUES('org-a'); INSERT INTO users VALUES('manager-a');
      INSERT INTO sarvam_voice_sessions VALUES('voice-a','org-a','manager-a','ended','browser');`);
    db.exec(shopifyDevStoreSchema);
    let calls = 0, ids = 0;
    const service = createShopifyDevStoreService({
      get: async (sql, ...args) => db.prepare(sql).get(...args),
      run: async (sql, ...args) => db.prepare(sql).run(...args),
      newId: () => `request-sql-${++ids}`, timestamp: () => new Date().toISOString(),
      env: { SHOPIFY_DEV_STORE_ENABLED: 'true', SHOPIFY_DEV_ORGANIZATION_ID: '123456' },
      execute: async () => { calls++; return { stdout: JSON.stringify({ store: { domain: calls === 1 ? 'acme.myshopify.com' : 'second.myshopify.com' }, organization: { id: '123456' } }) }; },
    });
    await service.create(request);
    await tick();
    assert.equal((await service.read('org-a', 'voice-a')).storeUrl, 'https://acme.myshopify.com');
    assert.equal((await service.create(request)).status, 'ready');
    await assert.rejects(service.create({ ...request, userId: 'other' }), { code: 'dev_store_session_invalid' });
    db.prepare("INSERT INTO sarvam_voice_sessions VALUES('voice-b','org-a','manager-a','ended','browser')").run();
    await service.create({ ...request, voiceSessionId: 'voice-b', name: 'Second store' });
    await tick();
    assert.equal((await service.read('org-a', 'voice-b')).storeUrl, 'https://second.myshopify.com');
    assert.equal(calls, 2);
  } finally { db.close(); }
});

test('development store route uses the authenticated manager and workspace', async () => {
  let binding;
  const controller = createCommerceV2Controller({
    repositories: { foundation: {} }, HttpError: class extends Error {},
    requireRole(context, role) { assert.equal(role, 'manager'); assert.equal(context.user.id, 'manager-a'); },
    transaction: fn => fn(), id: () => 'id', now: () => new Date().toISOString(),
    sendJson(response, status, body) { Object.assign(response, { status, body }); return true; },
    env: { CREWOS_ORG_ENGINE_V2: 'true', CREWOS_ORG_ENGINE_V2_ORGS: 'org-a' },
    shopifyDevStores: { async create(input) { binding = input; return { status: 'creating' }; } },
  });
  const response = {};
  await controller.handle({ path: '/api/commerce/v2/shopify/dev-stores', method: 'POST', request: {}, response, body: { voiceSessionId: 'voice-a', name: 'Acme shoes', orgId: 'other', userId: 'other' }, context: { user: { id: 'manager-a' } }, org: { id: 'org-a' }, user: { id: 'manager-a' } });
  assert.deepEqual(binding, request);
  assert.equal(response.status, 202);
});
