import assert from 'node:assert/strict';
import test from 'node:test';
import { createShopifyAdminGraphqlAdapter, buildShopifyProductSetRequest, validateShopifyCatalogPageInput, verifyShopifyCatalogRead } from '../backend/src/integrations/shopify-admin-graphql.mjs';

const connection = (overrides = {}) => ({
  id: 'conn_shop', org_id: 'org_shop', provider: 'shopify', provider_account_id: 'acme.myshopify.com',
  environment: 'staging', status: 'connected', granted_scopes: ['read_products', 'write_products'], ...overrides,
});
const input = { title: 'Mug', handle: 'mug', vendor: 'Acme', variants: [{ sku: 'MUG-1', price: '12.99' }] };
const remote = (overrides = {}) => ({
  id: 'gid://shopify/Product/1', title: 'Mug', handle: 'mug', vendor: 'Acme',
  variants: { nodes: [{ id: 'gid://shopify/ProductVariant/1', sku: 'MUG-1', price: '12.99', inventoryItem: { id: 'gid://shopify/InventoryItem/1' } }] },
  ...overrides,
});
const response = (body, status = 200, headers) => ({ status, headers: headers || new Headers(), body });
const context = (overrides = {}) => ({
  orgId: 'org_shop', expectedOrgId: 'org_shop', expectedConnectionId: 'conn_shop', connection: connection(), apiVersion: '2026-10',
  credentialResolver: { resolve: async (scope) => { assert.deepEqual(scope, { orgId: 'org_shop', connectionId: 'conn_shop', providerAccountId: 'acme.myshopify.com', environment: 'staging' }); return 'fixture-token'; } },
  transport: { mode: 'fixture', request: async () => response({ data: { shop: { myshopifyDomain: 'acme.myshopify.com', name: 'Acme', currencyCode: 'USD' } } }) },
  ...overrides,
});
const writeBinding = { taskId: 'task_1', workflowId: 'workflow_1', toolRunId: 'tool_1', idempotencyKey: 'logical-key-1', policyRevision: 'policy-4', approvalId: 'approval-1', input, identifier: { handle: 'mug' } };
const writeControls = (overrides = {}) => ({
  operationReservation: {
    reserve: async () => ({ id: 'op_1', state: 'reserved', inputHash: null }),
    markStarted: async () => {}, markUncertain: async () => {}, markCompleted: async () => {},
  },
  dispatchAuthorization: { authorize: async () => ({ allowed: true }) },
  immutableApproval: { consume: async () => ({ consumed: true, approvalId: 'approval-1' }) },
  postWriteVerifier: { verify: async () => ({ verified: true }) },
  ...overrides,
});

test('Shopify Admin adapter binds tenant, exact shop domain, environment, API version and scopes', async () => {
  let requestArgs;
  const adapter = createShopifyAdminGraphqlAdapter(context({ transport: { mode: 'fixture', request: async (args) => {
    requestArgs = args;
    return response({ data: { shop: { myshopifyDomain: 'acme.myshopify.com', name: 'Acme', currencyCode: 'USD' } } });
  } } }));
  assert.equal((await adapter.identifyStore()).verified, true);
  assert.equal(requestArgs.url, 'https://acme.myshopify.com/admin/api/2026-10/graphql.json');
  assert.equal(requestArgs.headers['x-shopify-access-token'], 'fixture-token');
  assert.throws(() => createShopifyAdminGraphqlAdapter(context({ expectedOrgId: 'other_org' })), { code: 'shopify_connection_tenant_mismatch' });
  assert.throws(() => createShopifyAdminGraphqlAdapter(context({ connection: connection({ provider_account_id: 'acme.myshopify.com.attacker.test' }) })), { code: 'shopify_store_identity_invalid' });
  assert.throws(() => createShopifyAdminGraphqlAdapter(context({ connection: connection({ granted_scopes: ['read_products'] }), requiredScopes: ['write_products'] })), { code: 'shopify_scope_missing' });
  assert.throws(() => createShopifyAdminGraphqlAdapter(context({ apiVersion: 'latest' })), { code: 'shopify_api_version_invalid' });
  assert.throws(() => createShopifyAdminGraphqlAdapter(context({ transport: { mode: 'live', request: async () => {} } })), { code: 'shopify_transport_unavailable' });
});

test('store identity and catalog reads reject mismatched or malformed Shopify responses', async () => {
  const mismatch = createShopifyAdminGraphqlAdapter(context({ transport: { mode: 'fixture', request: async () => response({ data: { shop: { myshopifyDomain: 'other.myshopify.com' } } }) } }));
  await assert.rejects(mismatch.identifyStore(), { code: 'shopify_store_identity_mismatch' });
  const catalog = createShopifyAdminGraphqlAdapter(context({ transport: { mode: 'fixture', request: async ({ body }) => body.query.includes('CrewProducts')
    ? response({ data: { products: { nodes: [remote()], pageInfo: { hasNextPage: false, endCursor: null } } } })
    : response({ data: { product: remote() } }) } }));
  assert.equal((await catalog.listProducts()).products[0].variants[0].price, '12.99');
  assert.equal((await catalog.readProduct('gid://shopify/Product/1')).variants[0].sku, 'MUG-1');
  await assert.rejects(catalog.readProduct('1'), { code: 'shopify_product_id_invalid' });
});

test('verified read-only catalog page uses JSON-persisted scopes, identity verifier and bounded pagination', async () => {
  let requests = 0;
  const tokenHeaders = [];
  const catalog = createShopifyAdminGraphqlAdapter(context({
    connection: connection({ granted_scopes: '["read_products"]' }),
    transport: { mode: 'live_read_only', request: async ({ body, headers }) => {
      requests++;
      tokenHeaders.push(headers['x-shopify-access-token']);
      if (body.query.includes('CrewShopIdentity')) return response({ data: { shop: { myshopifyDomain: 'acme.myshopify.com', name: 'Acme', currencyCode: 'USD' } } });
      assert.deepEqual(body.variables, { first: 10, after: 'cursor-1' });
      return response({ data: { products: { nodes: [remote()], pageInfo: { hasNextPage: true, endCursor: 'cursor-2' } } } });
    } },
  }));
  const result = await catalog.readVerifiedCatalogPage({ first: 10, after: 'cursor-1' });
  assert.equal(result.verified, true);
  assert.equal(result.source, 'shopify_admin_api');
  assert.equal(result.simulated, false);
  assert.deepEqual(result.verification.productIds, ['gid://shopify/Product/1']);
  assert.equal(requests, 2);
  assert.deepEqual(tokenHeaders, ['fixture-token', 'fixture-token']);
  assert.equal(JSON.stringify(result).includes('fixture-token'), false);
});

test('catalog readiness rejects tenant, connection, store, environment, missing credential and missing scope', async () => {
  const base = context({ connection: connection({ granted_scopes: '["read_products"]' }), transport: { mode: 'fixture', request: async () => response({ data: { shop: { myshopifyDomain: 'acme.myshopify.com' } } }) } });
  assert.throws(() => createShopifyAdminGraphqlAdapter({ ...base, expectedOrgId: 'org_other' }), { code: 'shopify_connection_tenant_mismatch' });
  assert.throws(() => createShopifyAdminGraphqlAdapter({ ...base, expectedConnectionId: 'conn_other' }), { code: 'shopify_connection_tenant_mismatch' });
  assert.throws(() => createShopifyAdminGraphqlAdapter({ ...base, environment: 'production' }), { code: 'shopify_connection_environment_mismatch' });
  assert.throws(() => createShopifyAdminGraphqlAdapter({ ...base, connection: connection({ granted_scopes: '[]' }) }), { code: 'shopify_scope_missing' });
  const noCredential = createShopifyAdminGraphqlAdapter({ ...base, credentialResolver: { resolve: async () => null } });
  await assert.rejects(noCredential.identifyStore(), { code: 'shopify_credentials_unavailable' });
  const mismatch = createShopifyAdminGraphqlAdapter({ ...base, connection: connection({ provider_account_id: 'other.myshopify.com' }),
    credentialResolver: { resolve: async (scope) => { assert.deepEqual(scope, { orgId: 'org_shop', connectionId: 'conn_shop', providerAccountId: 'other.myshopify.com', environment: 'staging' }); return 'fixture-token'; } },
    transport: { mode: 'fixture', request: async () => response({ data: { shop: { myshopifyDomain: 'acme.myshopify.com' } } }) } });
  await assert.rejects(mismatch.identifyStore(), { code: 'shopify_store_identity_mismatch' });
});

test('catalog pagination schema, malformed read response and independent verifier fail closed', async () => {
  assert.deepEqual(validateShopifyCatalogPageInput({ first: 10, after: 'cursor' }), { first: 10, after: 'cursor' });
  assert.throws(() => validateShopifyCatalogPageInput({ first: 101 }), { code: 'shopify_pagination_invalid' });
  const malformed = createShopifyAdminGraphqlAdapter(context({
    transport: { mode: 'fixture', request: async ({ body }) => {
      if (body.query.includes('CrewShopIdentity')) return response({ data: { shop: { myshopifyDomain: 'acme.myshopify.com' } } });
      return response({ data: { products: { nodes: [{ title: 'missing ID', variants: { nodes: [] } }], pageInfo: { hasNextPage: false, endCursor: null } } } });
    } },
  }));
  await assert.rejects(malformed.readVerifiedCatalogPage(), { code: 'shopify_catalog_verification_failed' });
  assert.deepEqual(verifyShopifyCatalogRead({ expectedStoreDomain: 'acme.myshopify.com', identity: { verified: true, myshopifyDomain: 'other.myshopify.com' }, page: { products: [], pageInfo: { hasNextPage: false, endCursor: null } } }), { verified: false, reason: 'store_identity_mismatch' });
});

test('productSet request requires stable identifier and full variants list', () => {
  const request = buildShopifyProductSetRequest({ input, identifier: { handle: 'mug' } });
  assert.match(request.query, /productSet\(input: \$input/);
  assert.deepEqual(request.variables.input.variants, input.variants);
  assert.throws(() => buildShopifyProductSetRequest({ input: { title: 'Mug' }, identifier: { handle: 'mug' } }), { code: 'shopify_variants_required' });
  assert.throws(() => buildShopifyProductSetRequest({ input, identifier: {} }), { code: 'shopify_identifier_required' });
});

test('productSet parses userErrors and requires post-write readback match', async () => {
  const rejected = createShopifyAdminGraphqlAdapter(context({ ...writeControls(), transport: { mode: 'fixture', request: async () => response({ data: { productSet: { product: null, userErrors: [{ field: ['input', 'title'], message: 'invalid' }] } } }) } }));
  await assert.rejects(rejected.setProduct(writeBinding), { code: 'shopify_user_errors' });
  let markedUncertain = false;
  const mismatch = createShopifyAdminGraphqlAdapter(context({ ...writeControls({ operationReservation: { ...writeControls().operationReservation, markUncertain: async () => { markedUncertain = true; } } }), transport: { mode: 'fixture', request: async ({ body }) => body.query.includes('CrewProductSet')
    ? response({ data: { productSet: { product: remote(), userErrors: [] } } })
    : response({ data: { product: remote({ variants: { nodes: [{ id: 'v1', sku: 'MUG-1', price: '13.00', inventoryItem: { id: 'i1' } }] } }) } }) } }));
  await assert.rejects(mismatch.setProduct(writeBinding), { code: 'shopify_readback_mismatch' });
  assert.equal(markedUncertain, true);
});

test('product writes require authoritative reservation, authorization, approval, and verification; uncertain operations reconcile first', async () => {
  let requests = 0;
  const transport = { mode: 'fixture', request: async ({ body }) => { requests++; return body.query.includes('CrewProductSet')
    ? response({ data: { productSet: { product: remote(), userErrors: [] } } })
    : response({ data: { product: remote() } }); } };
  const gated = createShopifyAdminGraphqlAdapter(context({ transport }));
  await assert.rejects(gated.setProduct(writeBinding), { code: 'shopify_write_gate_unavailable' });
  const conflict = createShopifyAdminGraphqlAdapter(context({ ...writeControls({ operationReservation: { ...writeControls().operationReservation, reserve: async () => ({ state: 'reserved', input_hash: 'different' }) } }), transport }));
  await assert.rejects(conflict.setProduct(writeBinding), { code: 'shopify_idempotency_conflict' });
  const uncertain = createShopifyAdminGraphqlAdapter(context({ ...writeControls({ operationReservation: { ...writeControls().operationReservation, reserve: async () => ({ id: 'op_1', state: 'started' }) } }), transport }));
  await assert.rejects(uncertain.setProduct(writeBinding), { code: 'shopify_reconciliation_required' });
  assert.equal(requests, 0);
  const reconciled = createShopifyAdminGraphqlAdapter(context({ ...writeControls({
    operationReservation: { ...writeControls().operationReservation, reserve: async () => ({ id: 'op_1', state: 'started' }) },
    reconcileUncertainOperation: async () => ({ state: 'safe_to_retry', operation: { id: 'op_1', state: 'reserved' } }),
  }), transport }));
  assert.equal((await reconciled.setProduct(writeBinding)).verified, true);
  assert.equal(requests, 2);
});

test('live read-only transport cannot dispatch product mutations even if write gates are supplied', async () => {
  let requests = 0;
  const adapter = createShopifyAdminGraphqlAdapter(context({ ...writeControls(), transport: { mode: 'live_read_only', request: async () => { requests++; throw new Error('must not dispatch'); } } }));
  await assert.rejects(adapter.setProduct(writeBinding), { code: 'shopify_live_writes_disabled' });
  assert.equal(requests, 0);
});

test('HTTP and GraphQL throttle failures preserve retry guidance without automatic retry', async () => {
  let requests = 0;
  const throttled = createShopifyAdminGraphqlAdapter(context({ transport: { mode: 'fixture', request: async () => { requests++; return response({}, 429, new Headers({ 'retry-after': '2' })); } } }));
  await assert.rejects(throttled.identifyStore(), (error) => error.code === 'shopify_throttled' && error.retryAfter === '2');
  assert.equal(requests, 1);
  const serverError = createShopifyAdminGraphqlAdapter(context({ transport: { mode: 'fixture', request: async () => response({}, 503) } }));
  await assert.rejects(serverError.identifyStore(), { code: 'shopify_http_uncertain' });
  const gqlThrottle = createShopifyAdminGraphqlAdapter(context({ transport: { mode: 'fixture', request: async () => response({ errors: [{ message: 'throttled', extensions: { code: 'THROTTLED' } }] }) } }));
  await assert.rejects(gqlThrottle.identifyStore(), { code: 'shopify_throttled' });
});
