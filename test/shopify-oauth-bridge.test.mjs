import assert from 'node:assert/strict';
import test from 'node:test';
import { createShopifyOAuthBridge } from '../backend/src/services/shopify-oauth-bridge.mjs';
import { parseCookie } from '../backend/src/utils/cookies.mjs';
import { createCommerceV2Controller } from '../backend/src/controllers/commerce-v2-controller.mjs';

test('Shopify callback bridge requires a current signed manager session', async () => {
  let now = Date.parse('2026-10-31T12:00:00Z');
  let active = true;
  const tokenHash = 'a'.repeat(64);
  const repository = {
    async findOneSessionByTokenHashAndExpiresAt(hash) { return active && hash === tokenHash ? { org_id: 'org-a', user_id: 'user-a' } : null; },
    async findOneUserByIdSelectIdNameEmail(id) { return { id }; },
    async findOneOrganizationByIdAndUserId(id, userId) { return id === 'org-a' && userId === 'user-a' ? { id, role: 'manager' } : null; },
  };
  const bridge = createShopifyOAuthBridge({ key: 'fixture-only-key-with-at-least-24-chars', repository, parseCookie, now: () => now });
  const cookie = bridge.issue({ tokenHash, user: { id: 'user-a' }, org: { id: 'org-a' } });
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\/api\/commerce\/v2\/shopify\/oauth\/callback/);
  const header = cookie.split(';')[0];
  assert.equal((await bridge.resolve({ headers: { cookie: header } })).org.id, 'org-a');
  assert.equal(await bridge.resolve({ headers: { cookie: `${header}x` } }), null);
  active = false;
  assert.equal(await bridge.resolve({ headers: { cookie: header } }), null);
  active = true;
  now += 60_001;
  assert.equal(await bridge.resolve({ headers: { cookie: header } }), null);
});

test('starting Shopify OAuth sends both Shopify state and the callback session cookie', async () => {
  const headers = {};
  const response = { setHeader(name, value) { headers[name] = value; } };
  const controller = createCommerceV2Controller({
    repositories: { foundation: {} }, HttpError: class extends Error {}, requireRole() {}, transaction: fn => fn(),
    id: () => 'test', now: () => '2026-10-31T12:00:00Z', sendJson: () => true,
    env: { CREWOS_ORG_ENGINE_V2: 'true', CREWOS_ORG_ENGINE_V2_ORGS: 'org-a' },
    shopifyLifecycle: { ready: true, async begin() { return { authorizationUrl: 'https://example.myshopify.com/admin/oauth/authorize', setCookie: ['shopify_app_state=state', 'shopify_app_state.sig=signature'] }; } },
    shopifyCallbackBridge: { issue() { return 'crewos_shopify_callback=bridge; SameSite=Lax'; } },
  });
  await controller.handle({ path: '/api/commerce/v2/shopify/connections/connect', method: 'POST', response, request: {}, body: { storeDomain: 'example.myshopify.com' }, context: {}, org: { id: 'org-a' }, user: { id: 'user-a' } });
  assert.equal(headers['set-cookie'].length, 3);
  assert.match(headers['set-cookie'][2], /^crewos_shopify_callback=/);
});
