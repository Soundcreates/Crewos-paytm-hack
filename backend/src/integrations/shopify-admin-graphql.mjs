import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createAdminApiClient } from '@shopify/admin-api-client';
import { validateMcpArguments } from 'solari-crew-core';

const environments = new Set(['simulation', 'test', 'staging', 'production']);
const scopes = new Set(['read_products', 'write_products']);
const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const digest = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const error = (message, code, status = 503, extra = {}) => {
  throw Object.assign(new Error(message), { code, status, ...extra });
};

const SHOP_QUERY = `query CrewShopIdentity { shop { name myshopifyDomain currencyCode } }`;
const PRODUCTS_QUERY = `query CrewProducts($first: Int!, $after: String) {
  products(first: $first, after: $after) {
    nodes { id title handle vendor variants(first: 250) { nodes { id sku price inventoryItem { id } } } }
    pageInfo { hasNextPage endCursor }
  }
}`;
const PRODUCT_QUERY = `query CrewProduct($id: ID!) {
  product(id: $id) { id title handle vendor variants(first: 250) { nodes { id sku price inventoryItem { id } } } }
}`;
const PRODUCT_SET_MUTATION = `mutation CrewProductSet($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
  productSet(input: $input, identifier: $identifier, synchronous: true) {
    product { id title handle vendor variants(first: 250) { nodes { id sku price inventoryItem { id } } } }
    userErrors { code field message }
  }
}`;

function parseScopes(value) {
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

export const SHOPIFY_CATALOG_PAGE_INPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    first: { type: 'integer', minimum: 1, maximum: 100 },
    after: { type: 'string', maxLength: 512 },
  },
  additionalProperties: false,
});

/** Executable validation for the manager's bounded read-only catalog page request. */
export function validateShopifyCatalogPageInput(input) {
  try { validateMcpArguments(SHOPIFY_CATALOG_PAGE_INPUT_SCHEMA, input); }
  catch {
    error('Shopify catalog page input is invalid.', 'shopify_pagination_invalid', 422);
  }
  return { first: input.first ?? 50, after: input.after ?? null };
}

/** Independent local postcondition check for the exact connected store and page shape. */
export function verifyShopifyCatalogRead({ expectedStoreDomain, identity, page }) {
  if (!identity || identity.verified !== true || identity.myshopifyDomain !== expectedStoreDomain) {
    return { verified: false, reason: 'store_identity_mismatch' };
  }
  if (!page || !Array.isArray(page.products) || !page.pageInfo || typeof page.pageInfo.hasNextPage !== 'boolean' ||
      page.pageInfo.endCursor !== null && typeof page.pageInfo.endCursor !== 'string' ||
      page.products.some((product) => !product || typeof product.id !== 'string' || !product.id.startsWith('gid://shopify/Product/') ||
        typeof product.title !== 'string' || !Array.isArray(product.variants) || product.variants.some((variant) => !variant || typeof variant.id !== 'string'))) {
    return { verified: false, reason: 'catalog_response_invalid' };
  }
  return { verified: true, evidence: { storeDomain: expectedStoreDomain, productCount: page.products.length, productIds: page.products.map((product) => product.id), hasNextPage: page.pageInfo.hasNextPage, endCursor: page.pageInfo.endCursor } };
}

function validateVersion(value) {
  if (typeof value !== 'string' || !/^\d{4}-(01|04|07|10)$/.test(value)) {
    error('A configured Shopify Admin API quarterly version is required.', 'shopify_api_version_invalid', 400);
  }
  return value;
}

function validateConnection({ orgId, connection, expectedOrgId, expectedConnectionId, environment, apiVersion, requiredScopes = ['read_products'] }) {
  if (!orgId || !connection || connection.org_id !== orgId || expectedOrgId && expectedOrgId !== orgId || expectedConnectionId && expectedConnectionId !== connection.id) {
    error('Shopify connection does not belong to the requested organization.', 'shopify_connection_tenant_mismatch', 403);
  }
  if (connection.provider !== 'shopify' || !environments.has(environment) || connection.environment !== environment) {
    error('Shopify provider or environment binding is invalid.', 'shopify_connection_environment_mismatch', 403);
  }
  if (connection.status !== 'connected') error('Shopify connection is not connected.', 'shopify_connection_unavailable', 503);
  const domain = String(connection.provider_account_id || '').toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/.test(domain) || domain !== connection.provider_account_id) {
    error('Shopify connection must have an exact canonical *.myshopify.com account domain.', 'shopify_store_identity_invalid', 403);
  }
  const granted = new Set(parseScopes(connection.granted_scopes));
  const requested = [...new Set(requiredScopes)];
  if (requested.some((scope) => !scopes.has(scope) || !granted.has(scope))) {
    error('Shopify connection is missing a required product scope.', 'shopify_scope_missing', 403, { requiredScopes: requested });
  }
  return { orgId, connectionId: connection.id, domain, environment, apiVersion: validateVersion(apiVersion), grantedScopes: [...granted] };
}

function assertProductSetInput(input, identifier) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.title !== 'string' || !input.title.trim()) {
    error('Product set input requires a non-empty title.', 'shopify_product_input_invalid', 422);
  }
  // Shopify productSet replaces list fields: require the complete intended variants list.
  if (!Array.isArray(input.variants) || input.variants.length < 1 || input.variants.length > 250) {
    error('Product set requires the complete variants list (1–250 variants).', 'shopify_variants_required', 422);
  }
  if (!identifier || typeof identifier !== 'object' || Array.isArray(identifier) || Object.keys(identifier).length !== 1 ||
      !(['id', 'handle'].includes(Object.keys(identifier)[0])) || typeof Object.values(identifier)[0] !== 'string' || !Object.values(identifier)[0].trim()) {
    error('Product set requires one stable Shopify product identifier for uncertain-write reconciliation.', 'shopify_identifier_required', 422);
  }
  for (const [index, variant] of input.variants.entries()) {
    if (!variant || typeof variant !== 'object' || typeof variant.price !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(variant.price)) {
      error(`Variant ${index} requires a canonical decimal price string.`, 'shopify_variant_invalid', 422);
    }
    if (variant.sku !== undefined && (typeof variant.sku !== 'string' || variant.sku.length > 255)) {
      error(`Variant ${index} has an invalid SKU.`, 'shopify_variant_invalid', 422);
    }
  }
}

/** Builds a productSet operation without sending it. No implicit list-field omission is allowed. */
export function buildShopifyProductSetRequest({ input, identifier }) {
  assertProductSetInput(input, identifier);
  return { query: PRODUCT_SET_MUTATION, variables: { input: structuredClone(input), identifier: structuredClone(identifier) } };
}

function normalizeProduct(product) {
  if (!product) return null;
  return {
    id: product.id,
    title: product.title,
    handle: product.handle ?? null,
    vendor: product.vendor ?? null,
    variants: (product.variants?.nodes || []).map((variant) => ({
      id: variant.id,
      sku: variant.sku ?? '',
      price: String(variant.price),
      inventoryItemId: variant.inventoryItem?.id ?? null,
    })),
  };
}

function checkExpectedProduct(input, remote) {
  if (!remote || remote.title !== input.title || (input.handle !== undefined && remote.handle !== input.handle) ||
      (input.vendor !== undefined && remote.vendor !== input.vendor) || remote.variants.length !== input.variants.length) return false;
  const expected = input.variants.map((variant) => ({ sku: variant.sku ?? '', price: String(variant.price) })).sort((a, b) => a.sku.localeCompare(b.sku));
  const actual = remote.variants.map((variant) => ({ sku: variant.sku, price: variant.price })).sort((a, b) => a.sku.localeCompare(b.sku));
  return isDeepStrictEqual(actual, expected);
}

function httpError(status, headers) {
  if (status === 429) {
    error('Shopify Admin API throttled the request; retry only after operation reconciliation.', 'shopify_throttled', 429, { retryAfter: headers?.get?.('retry-after') || null });
  }
  error(`Shopify Admin API returned HTTP ${status}.`, status >= 500 ? 'shopify_http_uncertain' : 'shopify_http_error', status >= 500 ? 503 : status);
}

/**
 * Creates a Shopify Admin GraphQL adapter. The caller must inject either a fixture
 * transport or an explicitly read-only live transport; this factory has no fetch default.
 */
export function createShopifyAdminGraphqlAdapter({
  orgId,
  expectedOrgId = orgId,
  expectedConnectionId,
  connection,
  environment = connection?.environment,
  apiVersion,
  requiredScopes = ['read_products'],
  credentialResolver,
  transport,
  operationReservation,
  dispatchAuthorization,
  immutableApproval,
  postWriteVerifier,
  reconcileUncertainOperation,
}) {
  if (!transport || !['fixture', 'live_read_only'].includes(transport.mode) || typeof transport.request !== 'function') {
    error('Shopify Admin GraphQL requires an injected fixture or explicitly read-only transport.', 'shopify_transport_unavailable', 503);
  }
  if (!credentialResolver || typeof credentialResolver.resolve !== 'function') {
    error('Shopify Admin GraphQL requires the connection credential resolver.', 'shopify_credentials_unavailable', 503);
  }
  const identity = validateConnection({ orgId, connection, expectedOrgId, expectedConnectionId, environment, apiVersion, requiredScopes });

  async function request(query, variables, required = ['read_products']) {
    const current = validateConnection({ orgId, connection, expectedOrgId, expectedConnectionId, environment, apiVersion: identity.apiVersion, requiredScopes: required });
    const token = await credentialResolver.resolve({ orgId, connectionId: connection.id, providerAccountId: identity.domain, environment });
    if (typeof token !== 'string' || !token) error('No active Shopify credential is available for this connection.', 'shopify_credentials_unavailable', 503);
    const client = createAdminApiClient({
      storeDomain: current.domain,
      apiVersion: current.apiVersion,
      accessToken: token,
      retries: 0,
      customFetchApi: async (url, init = {}) => {
        let body;
        try { body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body; }
        catch { error('Shopify client produced an invalid GraphQL request body.', 'shopify_request_invalid', 500); }
        const injected = await transport.request({
          url,
          method: init.method || 'POST',
          headers: Object.fromEntries(new Headers(init.headers || {}).entries()),
          body,
          signal: init.signal,
        });
        if (injected instanceof Response) return injected;
        if (!injected || !Number.isInteger(injected.status)) error('Shopify fixture transport returned an invalid response.', 'shopify_transport_invalid', 502);
        const injectedBody = typeof injected.json === 'function' ? await injected.json() : injected.body;
        const headers = new Headers(injected.headers || {});
        if (!headers.has('content-type')) headers.set('content-type', 'application/json');
        return new Response(JSON.stringify(injectedBody), { status: injected.status, headers });
      },
    });
    const response = await client.request(query, { variables: structuredClone(variables) });
    if (response.errors) {
      const status = response.errors.networkStatusCode;
      if (status === 429) error('Shopify Admin API throttled the request; retry only after operation reconciliation.', 'shopify_throttled', 429, { retryAfter: response.errors.response?.headers?.get?.('retry-after') || null });
      if (Number.isInteger(status) && status >= 500) httpError(status, response.errors.response?.headers);
      const graphQLErrors = response.errors.graphQLErrors || [];
      const throttle = graphQLErrors.some((item) => item?.extensions?.code === 'THROTTLED');
      error(throttle ? 'Shopify Admin API throttled the request.' : 'Shopify Admin API returned GraphQL errors.', throttle ? 'shopify_throttled' : 'shopify_graphql_error', throttle ? 429 : 502, { errors: graphQLErrors });
    }
    if (!response.data || typeof response.data !== 'object') error('Shopify Admin API returned invalid or empty GraphQL data.', 'shopify_response_invalid', 502);
    return response.data;
  }

  async function identifyStore() {
    const data = await request(SHOP_QUERY, {});
    const shop = data?.shop;
    if (!shop || shop.myshopifyDomain !== identity.domain) error('Shopify returned a different store identity than the verified connection.', 'shopify_store_identity_mismatch', 409);
    return { ...shop, verified: true, orgId, connectionId: connection.id, environment, apiVersion: identity.apiVersion };
  }

  async function readProduct(id) {
    if (typeof id !== 'string' || !id.startsWith('gid://shopify/Product/')) error('A Shopify Product GID is required.', 'shopify_product_id_invalid', 422);
    const data = await request(PRODUCT_QUERY, { id });
    return normalizeProduct(data?.product);
  }

  async function listProducts({ first = 50, after = null } = {}) {
    const input = validateShopifyCatalogPageInput({ first, ...(after !== null ? { after } : {}) });
    const data = await request(PRODUCTS_QUERY, input);
    const connectionData = data?.products;
    if (!connectionData || !Array.isArray(connectionData.nodes) || !connectionData.pageInfo || typeof connectionData.pageInfo.hasNextPage !== 'boolean' ||
        connectionData.pageInfo.endCursor !== null && typeof connectionData.pageInfo.endCursor !== 'string') error('Shopify product catalog response is incomplete.', 'shopify_response_invalid', 502);
    return { products: connectionData.nodes.map(normalizeProduct), pageInfo: connectionData.pageInfo };
  }

  async function readVerifiedCatalogPage(input = {}) {
    const pageInput = validateShopifyCatalogPageInput(input);
    const identityResult = await identifyStore();
    const page = await listProducts(pageInput);
    const verification = verifyShopifyCatalogRead({ expectedStoreDomain: identity.domain, identity: identityResult, page });
    if (!verification.verified) error('Shopify catalog read did not verify against the connected store.', 'shopify_catalog_verification_failed', 502);
    return { ...page, verified: true, verification: verification.evidence, source: 'shopify_admin_api', simulated: false, connectionId: connection.id, storeDomain: identity.domain, environment, apiVersion: identity.apiVersion };
  }

  async function setProduct({ taskId, workflowId, toolRunId, idempotencyKey, policyRevision, approvalId, input, identifier }) {
    if (transport.mode !== 'fixture') error('Live Shopify catalog writes are disabled.', 'shopify_live_writes_disabled', 403);
    if (!operationReservation || typeof operationReservation.reserve !== 'function' || typeof operationReservation.markStarted !== 'function' ||
        typeof operationReservation.markUncertain !== 'function' || typeof operationReservation.markCompleted !== 'function' ||
        !dispatchAuthorization || typeof dispatchAuthorization.authorize !== 'function' ||
        !immutableApproval || typeof immutableApproval.consume !== 'function' ||
        !postWriteVerifier || typeof postWriteVerifier.verify !== 'function') {
      error('Shopify product writes require an operation reservation, dispatch authorization, immutable approval consumption, and post-write verification.', 'shopify_write_gate_unavailable', 403);
    }
    validateConnection({ orgId, connection, expectedOrgId, expectedConnectionId, environment, apiVersion: identity.apiVersion, requiredScopes: ['write_products'] });
    if (!taskId || !workflowId || !toolRunId || !idempotencyKey || !policyRevision || !approvalId) error('Shopify product write is missing task, workflow, tool, idempotency, policy, or approval binding.', 'shopify_write_binding_missing', 422);
    const requestBody = buildShopifyProductSetRequest({ input, identifier });
    const binding = {
      orgId,
      taskId,
      workflowId,
      toolRunId,
      connectionId: connection.id,
      environment,
      action: 'shopify.product.set',
      policyRevision,
      approvalId,
      idempotencyKey,
      inputHash: digest({ input, identifier }),
      input: { input: structuredClone(input), identifier: structuredClone(identifier) },
    };
    let operation = await operationReservation.reserve(binding);
    if (!operation || operation.input_hash && operation.input_hash !== binding.inputHash || operation.inputHash && operation.inputHash !== binding.inputHash) {
      error('Shopify operation reservation conflicts with a different immutable input.', 'shopify_idempotency_conflict', 409);
    }
    if (['started', 'uncertain', 'reconciliation_required'].includes(operation.state)) {
      if (typeof reconcileUncertainOperation !== 'function') error('Uncertain Shopify write must be reconciled before retry.', 'shopify_reconciliation_required', 409);
      const reconciled = await reconcileUncertainOperation({ binding, operation, readProduct });
      if (reconciled?.state === 'completed' && reconciled.verified === true) return reconciled.result;
      if (reconciled?.state !== 'safe_to_retry') error('Shopify write remains uncertain; retry is blocked.', 'shopify_reconciliation_required', 409);
      operation = reconciled.operation || operation;
    } else if (operation.state === 'completed') {
      if (operation.verified !== true) error('Prior Shopify operation has no verified completion receipt.', 'shopify_reconciliation_required', 409);
      return operation.result;
    } else if (!['reserved', 'pending'].includes(operation.state)) {
      error('Shopify operation is not in a dispatchable state.', 'shopify_operation_state_invalid', 409);
    }
    const authorized = await dispatchAuthorization.authorize({ binding, operation, connection: { ...identity } });
    if (authorized?.allowed !== true) error('Current Shopify dispatch authorization denied the operation.', 'shopify_dispatch_denied', 403);
    const approval = await immutableApproval.consume({ binding, operation, connection: { ...identity } });
    if (approval?.consumed !== true || approval.inputHash && approval.inputHash !== binding.inputHash || approval.approvalId && approval.approvalId !== approvalId) {
      error('Shopify approval is stale, mismatched, or already consumed.', 'shopify_approval_invalid', 403);
    }
    await operationReservation.markStarted({ binding, operation });
    let payload;
    let product;
    let readback;
    try {
      const data = await request(requestBody.query, requestBody.variables, ['write_products']);
      payload = data?.productSet;
      if (!payload) error('Shopify productSet response is missing its payload.', 'shopify_response_invalid', 502);
      if (Array.isArray(payload.userErrors) && payload.userErrors.length) {
        error('Shopify rejected the productSet mutation.', 'shopify_user_errors', 422, { userErrors: payload.userErrors });
      }
      product = normalizeProduct(payload.product);
      if (!product?.id) error('Shopify productSet response did not identify the resulting product.', 'shopify_response_invalid', 502);
      readback = await readProduct(product.id);
    } catch (caught) {
      await operationReservation.markUncertain({ binding, operation, reason: caught.code || 'transport_or_graphql_failure' });
      throw caught;
    }
    let verified;
    try {
      verified = await postWriteVerifier.verify({ binding, operation, product, readback, expectedInput: input, readProduct });
    } catch (caught) {
      await operationReservation.markUncertain({ binding, operation, reason: caught.code || 'post_write_verification_error' });
      throw caught;
    }
    if (verified?.verified !== true || !checkExpectedProduct(input, product) || !checkExpectedProduct(input, readback)) {
      await operationReservation.markUncertain({ binding, operation, reason: 'readback_mismatch' });
      error('Shopify product mutation could not be verified against the requested input.', 'shopify_readback_mismatch', 409);
    }
    const result = { product: readback, verified: true, environment, operationId: operation.id || operation.operationId };
    await operationReservation.markCompleted({ binding, operation, result });
    return result;
  }

  return Object.freeze({
    provider: 'shopify',
    environment,
    apiVersion: identity.apiVersion,
    identifyStore,
    listProducts,
    readVerifiedCatalogPage,
    readProduct,
    setProduct,
  });
}
