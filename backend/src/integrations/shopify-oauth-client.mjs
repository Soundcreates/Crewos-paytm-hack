import '@shopify/shopify-api/adapters/node';
import { shopifyApi } from '@shopify/shopify-api';

export const SHOPIFY_OAUTH_CALLBACK_PATH = '/api/commerce/v2/shopify/oauth/callback';
export const SHOPIFY_OAUTH_SCOPES = Object.freeze(['read_products']);

const QUARTERLY_API_VERSION = /^\d{4}-(01|04|07|10)$/;

/** Build Shopify's official OAuth helper only from complete, explicit public server config. */
export function createShopifyOAuthClientFromEnv(env = process.env) {
  const apiKey = String(env.SHOPIFY_API_KEY || env.SHOPIFY_CLIENT_ID || '').trim();
  const apiSecretKey = String(env.SHOPIFY_API_SECRET || env.SHOPIFY_CLIENT_SECRET || '').trim();
  const callbackValue = String(env.SHOPIFY_OAUTH_CALLBACK_URL || '').trim();
  const apiVersion = String(env.SHOPIFY_ADMIN_API_VERSION || '').trim();
  if (!apiKey || !apiSecretKey || !callbackValue || !apiVersion || String(env.APP_MASTER_KEY || '').length < 24) return null;
  if (!QUARTERLY_API_VERSION.test(apiVersion)) return null;
  let callback;
  try { callback = new URL(callbackValue); } catch { return null; }
  if (callback.protocol !== 'https:' || callback.username || callback.password || callback.search || callback.hash ||
      callback.pathname !== SHOPIFY_OAUTH_CALLBACK_PATH || !callback.hostname ||
      callback.hostname === 'localhost' || callback.hostname.endsWith('.localhost') || callback.hostname.endsWith('.local')) return null;

  try {
    const client = shopifyApi({
      apiKey,
      apiSecretKey,
      scopes: [...SHOPIFY_OAUTH_SCOPES],
      hostName: callback.host,
      hostScheme: 'https',
      apiVersion,
      isEmbeddedApp: false,
      isCustomStoreApp: false,
      logger: { log: () => {}, httpRequests: false },
    });
    return { client, callbackUrl: callback.toString(), apiVersion, scopes: [...SHOPIFY_OAUTH_SCOPES] };
  } catch {
    return null;
  }
}
