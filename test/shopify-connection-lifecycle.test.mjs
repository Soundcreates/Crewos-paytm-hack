import assert from 'node:assert/strict';
import test from 'node:test';
import { createShopifyConnectionLifecycle, parseShopifyScopes } from '../backend/src/services/shopify-connection-lifecycle.mjs';
import { createShopifyOAuthClientFromEnv } from '../backend/src/integrations/shopify-oauth-client.mjs';

const orgId = 'org_oauth';
const managerId = 'user_manager';
const domain = 'acme.myshopify.com';
const callbackUrl = 'https://crewos.example.test/api/commerce/v2/shopify/oauth/callback';

test('OAuth client remains unavailable without complete server config or a public HTTPS callback', () => {
  assert.equal(createShopifyOAuthClientFromEnv({}), null);
  const base = { SHOPIFY_API_KEY: 'fixture-key', SHOPIFY_API_SECRET: 'fixture-secret', APP_MASTER_KEY: 'fixture-master-key-long-enough', SHOPIFY_ADMIN_API_VERSION: '2026-10' };
  assert.equal(createShopifyOAuthClientFromEnv({ ...base, SHOPIFY_OAUTH_CALLBACK_URL: 'http://localhost/api/commerce/v2/shopify/oauth/callback' }), null);
  assert.equal(createShopifyOAuthClientFromEnv({ ...base, SHOPIFY_OAUTH_CALLBACK_URL: 'https://crewos.example.test/wrong-path' }), null);
});

test('Shopify scope parser handles JSON persistence and OAuth comma lists, rejecting malformed values', () => {
  assert.deepEqual(parseShopifyScopes(['read_products']), ['read_products']);
  assert.deepEqual(parseShopifyScopes('["read_products","read_inventory"]'), ['read_products', 'read_inventory']);
  assert.deepEqual(parseShopifyScopes('read_products, read_inventory'), ['read_products', 'read_inventory']);
  assert.deepEqual(parseShopifyScopes('{"scope":"read_products"}'), []);
  assert.deepEqual(parseShopifyScopes('["read_products",]'), []);
  assert.deepEqual(parseShopifyScopes(['read_products', null]), []);
  assert.deepEqual(parseShopifyScopes('read_products,,read_inventory'), []);
});

function fixture({ enabled = true, nowValue = '2026-10-31T00:00:00.000Z', grantedScope = 'read_products', identityDomain = domain } = {}) {
  let currentTime = Date.parse(nowValue);
  let nextId = 0;
  const connections = new Map();
  const intents = new Map();
  const repo = {
    async insertShopifyConnection(id, org, store, environment, scopes, config, created, updated) {
      const key = `${org}:${store}:${environment}`;
      if (!connections.has(key)) connections.set(key, { id, org_id: org, provider: 'shopify', provider_account_id: store, environment, status: 'setup_required', granted_scopes: scopes, config, created_at: created, updated_at: updated, credential_ready: 0 });
      return { changes: 1 };
    },
    async findShopifyConnectionByAccount(org, store, environment) { return [...connections.values()].find((row) => row.org_id === org && row.provider_account_id === store && row.environment === environment) || null; },
    async findShopifyConnectionByOrgAndId(org, id) { return [...connections.values()].find((row) => row.org_id === org && row.id === id) || null; },
    async listShopifyConnections(org) { return [...connections.values()].filter((row) => row.org_id === org); },
    async findActiveShopifyOAuthIntent(org, connectionId) { return [...intents.values()].find((row) => row.org_id === org && row.connection_id === connectionId && ['pending', 'processing'].includes(row.status)) || null; },
    async insertShopifyOAuthIntent(id, org, connectionId, manager, store, environment, hash, scopes, expiresAt, createdAt, updatedAt) {
      for (const row of intents.values()) if (row.org_id === org && row.connection_id === connectionId && row.status === 'pending') row.status = 'superseded';
      intents.set(hash, { id, org_id: org, connection_id: connectionId, manager_user_id: manager, store_domain: store, environment, state_hash: hash, requested_scopes: scopes, status: 'pending', expires_at: expiresAt, created_at: createdAt, updated_at: updatedAt });
      return { changes: 1 };
    },
    async findShopifyOAuthIntent(hash, at) { const row = intents.get(hash); return row && row.expires_at > at ? row : null; },
    async claimShopifyOAuthIntent(hash, org, manager, store, at) {
      const row = intents.get(hash);
      if (!row || row.status !== 'pending' || row.org_id !== org || row.manager_user_id !== manager || row.store_domain !== store || row.expires_at <= at) return { changes: 0 };
      row.status = 'processing'; row.consumed_at = at; return { changes: 1 };
    },
    async finishShopifyOAuthIntent(hash, status) { const row = intents.get(hash); if (!row || row.status !== 'processing') return { changes: 0 }; row.status = status; return { changes: 1 }; },
    async completeShopifyConnection(org, id, scopes, config) {
      const row = [...connections.values()].find((item) => item.org_id === org && item.id === id);
      if (!row) return { changes: 0 };
      row.status = 'connected'; row.granted_scopes = scopes; row.config = config; row.credential_ready = 1; return { changes: 1 };
    },
    async disconnectShopifyConnection(org, id, config) {
      const row = [...connections.values()].find((item) => item.org_id === org && item.id === id);
      if (!row) return { changes: 0 };
      row.status = 'revoked'; row.granted_scopes = '[]'; row.config = config; row.credential_ready = 0; return { changes: 1 };
    },
  };
  const credentialService = {
    async rotate(binding) { credentialService.lastRotation = binding; return { status: 'connected' }; },
    async revoke(binding) { credentialService.lastRevoke = binding; return true; },
  };
  let callbackCount = 0;
  const shopify = enabled ? {
    config: { apiVersion: '2026-10' },
    auth: {
      async begin({ shop, callbackPath, rawResponse }) {
        const state = 'fixture-state-one-time';
        rawResponse.setHeader('set-cookie', `shopify_app_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=${callbackPath}`);
        rawResponse.setHeader('location', `https://${shop}/admin/oauth/authorize?client_id=fixture&scope=read_products&redirect_uri=${encodeURIComponent(callbackUrl)}&state=${state}`);
        rawResponse.statusCode = 302; rawResponse.end();
      },
      async callback() {
        callbackCount++;
        return { session: { shop: domain, accessToken: 'fixture-access-token-never-return-this', scope: grantedScope, expires: null }, headers: { 'set-cookie': ['shopify_app_state=; Max-Age=0; Path=/api/commerce/v2/shopify/oauth/callback', 'shopify_app_session=ignored'] } };
      },
    },
    utils: { async validateHmac(query) { return query.hmac === 'valid-fixture-hmac'; } },
    clients: { Graphql: function GraphqlClient({ session }) { assert.equal(session.accessToken, 'fixture-access-token-never-return-this'); return { async request() { return { data: { shop: { myshopifyDomain: identityDomain, name: 'Acme', currencyCode: 'USD' } } }; } }; } },
  } : null;
  const lifecycle = createShopifyConnectionLifecycle({ repository: repo, credentialService: enabled ? credentialService : null, shopify, callbackUrl: enabled ? callbackUrl : undefined,
    transaction: async (callback) => callback(), newId: (prefix) => `${prefix}_${++nextId}`, timestamp: () => new Date(currentTime).toISOString(), nowMs: () => currentTime });
  return { lifecycle, repo, credentialService, intents, connections, get callbackCount() { return callbackCount; }, advance(ms) { currentTime += ms; } };
}

function callbackRequest({ state, shop = domain, hmac = 'valid-fixture-hmac' }) {
  return { url: `/api/commerce/v2/shopify/oauth/callback?shop=${encodeURIComponent(shop)}&state=${encodeURIComponent(state)}&hmac=${encodeURIComponent(hmac)}&timestamp=1793400000&code=fixture-code`, headers: { cookie: 'shopify_app_state=fixture-state-one-time' }, method: 'GET' };
}
function callbackResponse() { return { writeHead(status, headers) { this.status = status; this.headers = headers; }, end() { this.ended = true; } }; }

test('Shopify OAuth begins only when configured and binds exact domain, environment, minimal scopes, org and manager', async () => {
  const disabled = fixture({ enabled: false });
  assert.equal(disabled.lifecycle.ready, false);
  await assert.rejects(disabled.lifecycle.begin({ orgId, managerUserId: managerId, storeDomain: domain, environment: 'staging', request: {} }), { code: 'shopify_oauth_setup_required' });
  const setup = fixture();
  await assert.rejects(setup.lifecycle.begin({ orgId, managerUserId: managerId, storeDomain: 'ACME.myshopify.com', environment: 'staging', request: {} }), { code: 'shopify_store_domain_invalid' });
  await assert.rejects(setup.lifecycle.begin({ orgId, managerUserId: managerId, storeDomain: domain, environment: 'simulation', request: {} }), { code: 'shopify_environment_invalid' });
  const begun = await setup.lifecycle.begin({ orgId, managerUserId: managerId, storeDomain: domain, environment: 'staging', request: { headers: {}, method: 'POST', url: '/connect' } });
  const authorization = new URL(begun.authorizationUrl);
  assert.equal(authorization.hostname, domain);
  assert.equal(authorization.searchParams.get('scope'), 'read_products');
  assert.equal(begun.connection.status, 'setup_required');
  assert.match(begun.setCookie, /^shopify_app_state=/);
  assert.equal('accessToken' in begun.connection, false);
  const storedIntent = [...setup.intents.values()][0];
  assert.equal(storedIntent.org_id, orgId);
  assert.equal(storedIntent.manager_user_id, managerId);
  assert.equal(storedIntent.connection_id, begun.connection.id);
  assert.equal(storedIntent.store_domain, domain);
  assert.equal(storedIntent.environment, 'staging');
  assert.equal(storedIntent.state_hash.length, 64);
  assert.ok(Date.parse(storedIntent.expires_at) - Date.parse(storedIntent.created_at) <= 55_000);
});

test('callback verifies HMAC, exact Admin API store identity, scope, ownership and consumes state once', async () => {
  const setup = fixture();
  const begun = await setup.lifecycle.begin({ orgId, managerUserId: managerId, storeDomain: domain, environment: 'staging', request: { headers: {}, method: 'POST', url: '/connect' } });
  const state = new URL(begun.authorizationUrl).searchParams.get('state');
  await assert.rejects(setup.lifecycle.complete({ orgId: 'other_org', managerUserId: managerId, request: callbackRequest({ state }), response: callbackResponse() }), { code: 'shopify_oauth_state_invalid' });
  await assert.rejects(setup.lifecycle.complete({ orgId, managerUserId: managerId, request: callbackRequest({ state, hmac: 'invalid' }), response: callbackResponse() }), { code: 'shopify_oauth_signature_invalid' });
  const response = callbackResponse();
  await setup.lifecycle.complete({ orgId, managerUserId: managerId, request: callbackRequest({ state }), response });
  assert.equal(response.status, 302);
  assert.equal(response.ended, true);
  assert.equal(response.headers.location, '/?shopify=connected#commerce');
  assert.deepEqual(response.headers['set-cookie'], ['shopify_app_state=; Max-Age=0; Path=/api/commerce/v2/shopify/oauth/callback']);
  assert.equal(setup.callbackCount, 1);
  assert.equal(setup.credentialService.lastRotation.credential, 'fixture-access-token-never-return-this');
  assert.deepEqual({ orgId: setup.credentialService.lastRotation.orgId, connectionId: setup.credentialService.lastRotation.connectionId,
    providerAccountId: setup.credentialService.lastRotation.providerAccountId, environment: setup.credentialService.lastRotation.environment },
  { orgId, connectionId: begun.connection.id, providerAccountId: domain, environment: 'staging' });
  const listed = await setup.lifecycle.list(orgId);
  assert.equal(listed[0].readiness, 'ready');
  assert.deepEqual(listed[0].scopes, ['read_products']);
  assert.equal(JSON.stringify(listed).includes('fixture-access-token'), false);
  await assert.rejects(setup.lifecycle.complete({ orgId, managerUserId: managerId, request: callbackRequest({ state }), response: callbackResponse() }), { code: 'shopify_oauth_state_invalid' });
  assert.equal(setup.callbackCount, 1);
});

test('callback rejects Admin API identity or scope mismatch without persisting a credential', async () => {
  const mismatch = fixture({ identityDomain: 'other.myshopify.com' });
  const begun = await mismatch.lifecycle.begin({ orgId, managerUserId: managerId, storeDomain: domain, environment: 'production', request: { headers: {}, method: 'POST', url: '/connect' } });
  const state = new URL(begun.authorizationUrl).searchParams.get('state');
  await assert.rejects(mismatch.lifecycle.complete({ orgId, managerUserId: managerId, request: callbackRequest({ state }), response: callbackResponse() }), { code: 'shopify_store_identity_mismatch' });
  assert.equal(mismatch.credentialService.lastRotation, undefined);
  const extraScope = fixture({ grantedScope: 'read_products,write_products' });
  const second = await extraScope.lifecycle.begin({ orgId, managerUserId: managerId, storeDomain: domain, environment: 'production', request: { headers: {}, method: 'POST', url: '/connect' } });
  const secondState = new URL(second.authorizationUrl).searchParams.get('state');
  await assert.rejects(extraScope.lifecycle.complete({ orgId, managerUserId: managerId, request: callbackRequest({ state: secondState }), response: callbackResponse() }), { code: 'shopify_oauth_grant_mismatch' });
  assert.equal(extraScope.credentialService.lastRotation, undefined);
});

test('expired intent and disconnect keep credentials org-scoped and unavailable', async () => {
  const setup = fixture();
  const begun = await setup.lifecycle.begin({ orgId, managerUserId: managerId, storeDomain: domain, environment: 'staging', request: { headers: {}, method: 'POST', url: '/connect' } });
  const state = new URL(begun.authorizationUrl).searchParams.get('state');
  setup.advance(56_000);
  await assert.rejects(setup.lifecycle.complete({ orgId, managerUserId: managerId, request: callbackRequest({ state }), response: callbackResponse() }), { code: 'shopify_oauth_state_invalid' });
  const disconnected = await setup.lifecycle.disconnect({ orgId, connectionId: begun.connection.id });
  assert.equal(disconnected.status, 'revoked');
  assert.equal(disconnected.readiness, 'reconnect_required');
  assert.deepEqual(setup.credentialService.lastRevoke, { orgId, connectionId: begun.connection.id });
  assert.equal((await setup.lifecycle.list(orgId))[0].readiness, 'reconnect_required');
  await assert.rejects(setup.lifecycle.disconnect({ orgId: 'other_org', connectionId: begun.connection.id }), { code: 'shopify_connection_not_found' });
});
