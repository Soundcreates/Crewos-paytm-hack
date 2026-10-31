import { createHash } from 'node:crypto';
import { SHOPIFY_OAUTH_CALLBACK_PATH, SHOPIFY_OAUTH_SCOPES } from '../integrations/shopify-oauth-client.mjs';

const domainPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/;
const SHOP_IDENTITY_QUERY = 'query CrewShopOAuthIdentity { shop { name myshopifyDomain currencyCode } }';
const fail = (message, code, status = 409) => { throw Object.assign(new Error(message), { code, status }); };
const stateHash = (state) => createHash('sha256').update(state).digest('hex');

/** Parse persisted JSON scope arrays and OAuth comma-delimited scope strings without partial acceptance. */
export function parseShopifyScopes(value) {
  let scopes;
  if (Array.isArray(value)) scopes = value;
  else if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) return [];
    if (raw.startsWith('[') || raw.startsWith('{')) {
      try { scopes = JSON.parse(raw); } catch { return []; }
      if (!Array.isArray(scopes)) return [];
    } else scopes = raw.split(',');
  } else return [];

  if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string')) return [];
  const normalized = scopes.map((scope) => scope.trim());
  if (normalized.some((scope) => !/^[a-z][a-z0-9_]*$/i.test(scope)) || new Set(normalized).size !== normalized.length) return [];
  return normalized;
}

function shopifyResponseShim() {
  const headers = {};
  return {
    statusCode: 200,
    statusMessage: 'OK',
    headers,
    getHeaders: () => ({ ...headers }),
    setHeader(name, value) { headers[name] = value; return this; },
    write() { throw new Error('Unexpected response body from Shopify OAuth helper.'); },
    end() { this.ended = true; return this; },
  };
}

function headerValue(headers, expected) {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((name) => name.toLowerCase() === expected.toLowerCase());
  return key ? headers[key] : undefined;
}

function stateCookieOnly(headers) {
  const value = headerValue(headers, 'set-cookie');
  const entries = Array.isArray(value) ? value : value ? [value] : [];
  const filtered = entries.filter((entry) => /^shopify_app_state=/i.test(String(entry)) && !/^shopify_app_session=/i.test(String(entry)));
  return filtered.length ? filtered : undefined;
}

function safeConnection(row, at) {
  const scopes = parseShopifyScopes(row.granted_scopes);
  const credentialReady = Number(row.credential_ready) === 1;
  let config = {};
  try { config = JSON.parse(row.config || '{}'); } catch { config = {}; }
  const configured = row.status === 'connected' && credentialReady && scopes.includes('read_products') &&
    config.identityVerified === true && config.verifiedStoreDomain === row.provider_account_id;
  const expiresAt = row.credential_expires_at || null;
  return {
    id: row.id,
    provider: 'shopify',
    storeDomain: row.provider_account_id,
    environment: row.environment,
    status: row.status,
    scopes,
    credentialExpiresAt: expiresAt,
    readiness: configured ? 'ready' : row.status === 'revoked' ? 'reconnect_required' : 'setup_required',
    simulated: false,
    liveActions: 'disabled',
    checkedAt: at,
  };
}

/** OAuth lifecycle around Shopify's official begin/callback helpers and CrewOS-owned credentials. */
export function createShopifyConnectionLifecycle({ repository, credentialService, shopify, callbackUrl, transaction, newId, timestamp, nowMs = () => Date.now() }) {
  const ready = Boolean(shopify?.auth?.begin && shopify?.auth?.callback && shopify?.utils?.validateHmac &&
    shopify?.clients?.Graphql && credentialService && callbackUrl);

  async function list(orgId) {
    const at = timestamp();
    return (await repository.listShopifyConnections(orgId, at)).map((row) => safeConnection(row, at));
  }

  async function begin({ orgId, managerUserId, storeDomain, environment, request }) {
    if (!ready) fail('Shopify authorization requires server app credentials, a public HTTPS callback URL, and credential encryption setup.', 'shopify_oauth_setup_required', 503);
    const domain = String(storeDomain || '').toLowerCase();
    if (!domainPattern.test(domain) || domain !== storeDomain) fail('Enter the exact canonical *.myshopify.com store domain.', 'shopify_store_domain_invalid', 422);
    if (!['staging', 'production'].includes(environment)) fail('Choose a staging or production Shopify connection environment.', 'shopify_environment_invalid', 422);
    if (!orgId || !managerUserId || !request) fail('Shopify authorization is missing its manager and organization binding.', 'shopify_oauth_binding_missing', 403);

    const connectionId = newId('shopify');
    const at = timestamp();
    const requestedScopes = [...SHOPIFY_OAUTH_SCOPES];
    let connection;
    await transaction(async () => {
      await repository.insertShopifyConnection(connectionId, orgId, domain, environment, JSON.stringify(requestedScopes), JSON.stringify({ setupSource: 'shopify_oauth', identityVerified: false }), at, at);
      connection = await repository.findShopifyConnectionByAccount(orgId, domain, environment, at);
      if (!connection || connection.org_id !== orgId || connection.provider !== 'shopify' || connection.provider_account_id !== domain || connection.environment !== environment) {
        fail('Shopify connection ownership could not be verified.', 'shopify_connection_tenant_mismatch', 403);
      }
    });
    const activeIntent = await repository.findActiveShopifyOAuthIntent(orgId, connection.id, at);
    if (activeIntent?.status === 'processing') fail('A Shopify callback is already being finalized for this store.', 'shopify_oauth_in_progress', 409);

    const response = shopifyResponseShim();
    try {
      await shopify.auth.begin({ shop: domain, callbackPath: SHOPIFY_OAUTH_CALLBACK_PATH, isOnline: false, rawRequest: request, rawResponse: response });
    } catch {
      fail('Shopify authorization could not be started. Check the app callback configuration.', 'shopify_oauth_begin_failed', 502);
    }
    const location = headerValue(response.headers, 'location');
    let authorization;
    try { authorization = new URL(location); } catch { fail('Shopify OAuth helper returned an invalid authorization URL.', 'shopify_oauth_begin_failed', 502); }
    const state = authorization.searchParams.get('state');
    const redirectUri = authorization.searchParams.get('redirect_uri');
      const grantedScopes = parseShopifyScopes(authorization.searchParams.get('scope'));
    if (authorization.protocol !== 'https:' || authorization.hostname !== domain || authorization.pathname !== '/admin/oauth/authorize' ||
        !state || state.length > 256 || redirectUri !== callbackUrl || !response.ended || grantedScopes.length !== requestedScopes.length ||
        grantedScopes.some((scope) => !requestedScopes.includes(scope))) {
      fail('Shopify OAuth helper returned an unexpected authorization binding.', 'shopify_oauth_begin_failed', 502);
    }
    const hash = stateHash(state);
    const expiresAt = new Date(nowMs() + 55_000).toISOString();
    await transaction(async () => {
      const inserted = await repository.insertShopifyOAuthIntent(newId('shopify_oauth'), orgId, connection.id, managerUserId, domain, environment,
        hash, JSON.stringify(requestedScopes), expiresAt, at, at);
      if (inserted?.changes !== 1) fail('A Shopify authorization is already being completed for this store. Retry shortly.', 'shopify_oauth_in_progress', 409);
    });
    return {
      authorizationUrl: authorization.toString(),
      setCookie: headerValue(response.headers, 'set-cookie'),
      expiresAt,
      connection: safeConnection(connection, at),
    };
  }

  async function complete({ orgId, managerUserId, request, response }) {
    if (!ready) fail('Shopify callback is unavailable until server OAuth and credential encryption configuration is complete.', 'shopify_oauth_setup_required', 503);
    const callbackRequestUrl = new URL(request.url || '/', callbackUrl);
    const state = callbackRequestUrl.searchParams.get('state') || '';
    const shop = String(callbackRequestUrl.searchParams.get('shop') || '').toLowerCase();
    if (!state || !domainPattern.test(shop)) fail('Shopify authorization state or store identity is invalid.', 'shopify_oauth_state_invalid', 400);
    const hash = stateHash(state);
    const at = timestamp();
    const intent = await repository.findShopifyOAuthIntent(hash, at);
    if (!intent || intent.status !== 'pending' || intent.org_id !== orgId || intent.manager_user_id !== managerUserId || intent.store_domain !== shop) {
      fail('Shopify authorization is expired, replayed, or belongs to a different manager or organization. Start again.', 'shopify_oauth_state_invalid', 403);
    }
    const connection = await repository.findShopifyConnectionByOrgAndId(orgId, intent.connection_id, at);
    if (!connection || connection.provider !== 'shopify' || connection.provider_account_id !== intent.store_domain || connection.environment !== intent.environment) {
      fail('Shopify connection ownership or store identity changed during authorization.', 'shopify_connection_tenant_mismatch', 403);
    }
    const query = Object.fromEntries(callbackRequestUrl.searchParams.entries());
    let validSignature = false;
    try { validSignature = await shopify.utils.validateHmac(query); } catch { validSignature = false; }
    if (!validSignature) fail('Shopify authorization signature is invalid.', 'shopify_oauth_signature_invalid', 403);
    const claimed = await transaction(() => repository.claimShopifyOAuthIntent(hash, orgId, managerUserId, shop, at));
    if (claimed?.changes !== 1) fail('Shopify authorization was already used or expired.', 'shopify_oauth_replay', 409);

    const oauthResponse = shopifyResponseShim();
    let callback;
    try {
      callback = await shopify.auth.callback({ rawRequest: request, rawResponse: oauthResponse, expiring: false });
      const session = callback?.session;
      const granted = parseShopifyScopes(session?.scope);
      const requested = parseShopifyScopes(intent.requested_scopes);
      if (!session || session.shop !== intent.store_domain || typeof session.accessToken !== 'string' || !session.accessToken ||
          !granted.includes('read_products') || granted.some((scope) => !requested.includes(scope))) {
        fail('Shopify granted scopes or store identity did not match this authorization.', 'shopify_oauth_grant_mismatch', 403);
      }
      const adminClient = new shopify.clients.Graphql({ session });
      const identityResult = await adminClient.request(SHOP_IDENTITY_QUERY);
      if (identityResult?.errors || identityResult?.data?.shop?.myshopifyDomain !== intent.store_domain) {
        fail('Shopify Admin API identity read-back did not match the authorized store.', 'shopify_store_identity_mismatch', 409);
      }
      const expiresAt = session.expires instanceof Date ? session.expires.toISOString() : session.expires ? new Date(session.expires).toISOString() : null;
      if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= nowMs())) fail('Shopify returned an expired access credential.', 'shopify_credential_expired', 403);
      await transaction(async () => {
        await credentialService.rotate({ orgId, connectionId: connection.id, providerAccountId: intent.store_domain, environment: intent.environment,
          credential: session.accessToken, expiresAt });
        const updated = await repository.completeShopifyConnection(orgId, connection.id, JSON.stringify(granted),
          JSON.stringify({ setupSource: 'shopify_oauth', identityVerified: true, verifiedStoreDomain: intent.store_domain, apiVersion: shopify.config?.apiVersion || null }), timestamp());
        if (updated?.changes !== 1) fail('Shopify connection could not be finalized under its organization.', 'shopify_connection_finalize_failed', 409);
        const finished = await repository.finishShopifyOAuthIntent(hash, 'completed', timestamp());
        if (finished?.changes !== 1) fail('Shopify authorization state could not be consumed exactly once.', 'shopify_oauth_replay', 409);
      });
    } catch (caught) {
      await transaction(() => repository.finishShopifyOAuthIntent(hash, 'failed', timestamp())).catch(() => {});
      if (caught?.code) throw caught;
      fail('Shopify authorization could not be completed. Restart connection setup.', 'shopify_oauth_exchange_failed', 502);
    }
    const location = '/?shopify=connected#commerce';
    response.writeHead(302, { location, ...(stateCookieOnly(callback?.headers || oauthResponse.headers) ? { 'set-cookie': stateCookieOnly(callback?.headers || oauthResponse.headers) } : {}), 'cache-control': 'no-store' });
    return response.end();
  }

  async function disconnect({ orgId, connectionId }) {
    const at = timestamp();
    const connection = await repository.findShopifyConnectionByOrgAndId(orgId, connectionId, at);
    if (!connection || connection.org_id !== orgId || connection.provider !== 'shopify') fail('Shopify connection not found.', 'shopify_connection_not_found', 404);
    const revoked = await credentialService.revoke({ orgId, connectionId });
    const changed = await repository.disconnectShopifyConnection(orgId, connectionId, JSON.stringify({ setupSource: 'shopify_oauth', identityVerified: false }), at);
    if (changed?.changes !== 1) fail('Shopify connection could not be revoked.', 'shopify_disconnect_failed', 409);
    return { id: connectionId, status: 'revoked', readiness: 'reconnect_required', credentialRevoked: Boolean(revoked), liveActions: 'disabled' };
  }

  return { ready, list, begin, complete, disconnect };
}
