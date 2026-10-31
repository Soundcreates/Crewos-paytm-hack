import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommerceV2Controller } from '../backend/src/controllers/commerce-v2-controller.mjs';

const orgId = 'org_catalog';
const connectionId = 'conn_catalog';
const storeDomain = 'acme.myshopify.com';
const product = { id: 'gid://shopify/Product/17', title: 'Mug', handle: 'mug', vendor: 'Acme', variants: { nodes: [{ id: 'gid://shopify/ProductVariant/1', sku: 'MUG-1', price: '12.99', inventoryItem: { id: 'gid://shopify/InventoryItem/1' } }] } };

function fixture({ connectionOverrides = {}, scopedConnectionOverrides = {}, enabled = true, pilot = false } = {}) {
  let fetchCount = 0;
  const baseConnection = { id: connectionId, org_id: orgId, provider: 'shopify', provider_account_id: storeDomain, environment: 'staging', status: 'connected', granted_scopes: '["read_products"]', config: JSON.stringify({ identityVerified: true, verifiedStoreDomain: storeDomain }), ...connectionOverrides };
  const verifiedConnection = { ...baseConnection, credential_ready: 1, ...scopedConnectionOverrides };
  const response = { statusCode: 0, body: null, setHeader() {}, writeHead(status, _headers) { this.statusCode = status; }, end() {} };
  const controller = createCommerceV2Controller({
    repositories: { foundation: {
      async findConnectionById() { return baseConnection; },
      async findShopifyConnectionByOrgAndId(org, id) { return org === orgId && id === connectionId ? verifiedConnection : null; },
      async findCommerceCatalogByConnection() { return []; },
    } },
    HttpError: class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } },
    requireRole(_context, role) { assert.equal(role, 'manager'); },
    transaction: async (fn) => fn(), id: (prefix) => `${prefix}_1`, now: () => '2026-10-31T00:00:00.000Z',
    sendJson(res, status, body) { res.statusCode = status; res.body = body; return true; },
    env: { CREWOS_ORG_ENGINE_V2: enabled ? 'true' : 'false', CREWOS_ORG_ENGINE_V2_ORGS: enabled ? orgId : '' },
    pilotMode: () => pilot,
    shopifyCatalogApi: {
      apiVersion: '2026-10',
      credentialResolver: { async resolve(binding) { assert.deepEqual(binding, { orgId, connectionId, providerAccountId: storeDomain, environment: 'staging' }); return 'fixture-token'; } },
      async fetch(_url, init) {
        fetchCount++;
        assert.equal(init.headers['x-shopify-access-token'], 'fixture-token');
        const { query } = JSON.parse(init.body);
        const body = query.includes('CrewShopIdentity')
          ? { data: { shop: { myshopifyDomain: storeDomain, name: 'Acme', currencyCode: 'USD' } } }
          : { data: { products: { nodes: [product], pageInfo: { hasNextPage: false, endCursor: null } } } };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    },
  });
  return { controller, response, get fetchCount() { return fetchCount; }, baseConnection, verifiedConnection };
}

async function read(f, connection = connectionId, query = '') {
  return f.controller.handle({
    path: `/api/commerce/v2/shopify/connections/${connection}/catalog`, method: 'GET', response: f.response,
    request: { url: `/api/commerce/v2/shopify/connections/${connection}/catalog${query}` },
    body: {}, context: { org: { id: orgId }, user: { id: 'manager' } }, org: { id: orgId }, user: { id: 'manager' },
  });
}

test('manager V2 catalog UI route returns a verified, paginated read without credential fields', async () => {
  const f = fixture();
  assert.equal(await read(f, connectionId, '?first=20'), true);
  assert.equal(f.response.statusCode, 200);
  assert.equal(f.response.body.verified, true);
  assert.equal(f.response.body.source, 'shopify_admin_api');
  assert.equal(f.response.body.products[0].id, product.id);
  assert.equal(f.fetchCount, 2);
  assert.equal(JSON.stringify(f.response.body).includes('fixture-token'), false);
});

test('catalog route denies non-owned, disabled, expired, unscoped and malformed page requests before fetch', async () => {
  const tenant = fixture({ connectionOverrides: { org_id: 'org_other' } });
  await assert.rejects(read(tenant), { status: 404 });
  assert.equal(tenant.fetchCount, 0);
  const disabled = fixture({ enabled: false });
  await assert.rejects(read(disabled), { status: 404 });
  assert.equal(disabled.fetchCount, 0);
  const piloted = fixture({ pilot: true });
  await assert.rejects(read(piloted), { code: 'pilot_mode_blocked' });
  assert.equal(piloted.fetchCount, 0);
  const expired = fixture({ scopedConnectionOverrides: { credential_ready: 0 } });
  await assert.rejects(read(expired), { code: 'shopify_catalog_not_ready' });
  assert.equal(expired.fetchCount, 0);
  const unscoped = fixture({ scopedConnectionOverrides: { granted_scopes: '[]' } });
  await assert.rejects(read(unscoped), { code: 'shopify_catalog_not_ready' });
  assert.equal(unscoped.fetchCount, 0);
  const malformed = fixture();
  await assert.rejects(read(malformed, connectionId, '?first=101'), { code: 'shopify_pagination_invalid' });
  assert.equal(malformed.fetchCount, 0);
});

test('direct live catalog mutation remains blocked so the workflow worker remains the only external product writer',async()=>{
  const f=fixture();
  await assert.rejects(f.controller.handle({path:`/api/commerce/v2/shopify/connections/${connectionId}/catalog`,method:'POST',response:f.response,request:{url:`/api/commerce/v2/shopify/connections/${connectionId}/catalog`},body:{idempotencyKey:'direct-write-key',products:[{title:'Mug'}]},context:{org:{id:orgId},user:{id:'manager'}},org:{id:orgId},user:{id:'manager'}}),{code:'workflow_approval_required'});
  assert.equal(f.fetchCount,0);
});
