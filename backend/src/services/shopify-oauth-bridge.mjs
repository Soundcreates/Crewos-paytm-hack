import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE = 'crewos_shopify_callback';
const PATH = '/api/commerce/v2/shopify/oauth/callback';
const sign = (key, value) => createHmac('sha256', key).update(`shopify-oauth-callback:${value}`).digest('base64url');

export function createShopifyOAuthBridge({ key, repository, parseCookie, now = () => Date.now() }) {
  const enabled = typeof key === 'string' && key.length >= 24;
  function issue(context) {
    if (!enabled || !/^[a-f0-9]{64}$/i.test(context?.tokenHash || '') || !context?.org?.id || !context?.user?.id) return null;
    const payload = Buffer.from(JSON.stringify({ session: context.tokenHash, org: context.org.id, user: context.user.id, expires: now() + 60_000 })).toString('base64url');
    return `${COOKIE}=${payload}.${sign(key, payload)}; HttpOnly; Secure; SameSite=Lax; Path=${PATH}; Max-Age=60`;
  }
  async function resolve(request) {
    if (!enabled) return null;
    let token;
    try { token = parseCookie(request.headers.cookie || '', COOKIE); } catch { return null; }
    if (typeof token !== 'string' || token.length > 2048) return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return null;
    const expected = Buffer.from(sign(key, payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    let data;
    try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
    if (!data || !/^[a-f0-9]{64}$/i.test(data.session || '') || typeof data.org !== 'string' || typeof data.user !== 'string' || !Number.isFinite(data.expires) || data.expires <= now() || data.expires > now() + 60_000) return null;
    const session = await repository.findOneSessionByTokenHashAndExpiresAt(data.session, new Date(now()).toISOString());
    if (!session || session.org_id !== data.org || session.user_id !== data.user) return null;
    const [user, org] = await Promise.all([repository.findOneUserByIdSelectIdNameEmail(data.user), repository.findOneOrganizationByIdAndUserId(data.org, data.user)]);
    return user && org ? { user, org, tokenHash: data.session } : null;
  }
  return { issue, resolve };
}
