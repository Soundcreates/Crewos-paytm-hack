export const APP_SESSION_COOKIE = 'crewos_session';

export interface NeonAuthSession {
  user: { id: string; email: string; name: string; emailVerified: boolean };
  session: unknown;
}

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

export function validateNeonAuthBaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('NEON_AUTH_BASE_URL must be a valid Neon Auth endpoint URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.replace(/\/+$/, '').endsWith('/auth')) {
    throw new Error('NEON_AUTH_BASE_URL must be an HTTPS Neon Auth endpoint ending in /auth.');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

export function validateNeonBranchPair(databaseUrl: string, authBaseUrl: string): URL {
  const database = new URL(databaseUrl);
  const auth = validateNeonAuthBaseUrl(authBaseUrl);
  const neonDatabase = database.hostname.endsWith('.neon.tech') && !database.hostname.includes('.neonauth.');
  const neonAuth = auth.hostname.includes('.neonauth.');
  const databaseHost = database.hostname.replace(/-pooler(?=\.)/, '');
  const authHost = auth.hostname.replace('.neonauth.', '.');
  const databaseName = database.pathname.replace(/^\/+|\/+$/g, '');
  const authDatabaseName = auth.pathname.slice(0, -'/auth'.length).replace(/^\/+|\/+$/g, '');
  if (!neonDatabase || !neonAuth || databaseHost !== authHost || databaseName !== authDatabaseName) {
    throw new Error('DATABASE_URL and NEON_AUTH_BASE_URL must point to the same Neon branch and database.');
  }
  return auth;
}

export function neonAuthEndpoint(baseUrl: string, route: unknown, search = ''): URL {
  const url = validateNeonAuthBaseUrl(baseUrl);
  const parts = String(route || '').split('/').filter(Boolean);
  if (parts.some((part) => !/^[A-Za-z0-9._~-]+$/.test(part) || part === '.' || part === '..')) {
    throw new Error('Invalid Neon Auth route.');
  }
  url.pathname += parts.length ? `/${parts.join('/')}` : '';
  url.search = search;
  return url;
}

export function parseNeonAuthSession(value: unknown): NeonAuthSession | null {
  const envelope = record(value);
  const data = record(envelope?.data ?? value);
  const user = record(data?.user);
  if (!user || typeof user.id !== 'string' || !user.id || typeof user.email !== 'string' || !user.email) return null;
  return {
    user: {
      id: user.id,
      email: user.email,
      name: typeof user.name === 'string' ? user.name : '',
      emailVerified: user.emailVerified === true,
    },
    session: data?.session ?? null,
  };
}

export function rewriteNeonAuthCookie(cookie: string, secure?: boolean): string {
  const rewritten = cookie.replace(/;\s*(?:domain|path)=[^;]*/ig, '');
  const localCookie = secure === false
    ? rewritten
      .replace(/^__Secure-/, '')
      .replace(/;\s*secure(?=\s*(?:;|$))/ig, '')
      .replace(/;\s*partitioned(?=\s*(?:;|$))/ig, '')
      .replace(/;\s*samesite\s*=\s*none(?=\s*(?:;|$))/ig, '; SameSite=Lax')
    : rewritten;
  return `${localCookie}; Path=/`;
}

export function prepareNeonAuthCookieHeader(cookieHeader = '', secure?: boolean): string {
  return cookieHeader.split(';').map((pair) => {
    const cookie = pair.trim();
    const separator = cookie.indexOf('=');
    if (separator <= 0) return '';
    const name = cookie.slice(0, separator);
    if (!/^(?:__Secure-)?neon-auth\./.test(name)) return '';
    if (secure !== false || name.startsWith('__Secure-')) return cookie;
    return `__Secure-${name}${cookie.slice(separator)}`;
  }).filter(Boolean).join('; ');
}

export function stripApplicationSessionCookie(cookieHeader = ''): string {
  return cookieHeader.split(';').map((pair) => pair.trim()).filter((pair) => {
    const separator = pair.indexOf('=');
    return separator > 0 && !pair.slice(0, separator).trim().startsWith('crewos_');
  }).join('; ');
}
