const LOCAL_DEVELOPMENT_ORIGINS = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://[::1]:3000',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://[::1]:4173',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://[::1]:5173',
]);

// The current public UI is served by Vercel while its API is reverse-proxied
// to the backend's ngrok origin. Keep this exact-origin fallback so the
// hackathon deployment works without another backend setting; deployments
// with a different UI origin should set APP_ALLOWED_ORIGINS explicitly.
const DEFAULT_ALLOWED_APP_ORIGINS = new Set([
  'https://crewos-paytm-hack-three.vercel.app',
]);

function toOrigin(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

function requestOrigin(request) {
  const host = request?.headers?.host;
  if (typeof host !== 'string' || !host) return null;
  return toOrigin(`${request.socket?.encrypted ? 'https' : 'http'}://${host}`);
}

/**
 * Check whether a browser Origin is trusted by the app.
 * APP_ORIGIN remains the canonical public origin; local Vite/backend origins
 * are additionally trusted only outside production for the development proxy.
 */
export function isAllowedAppOrigin(origin, env = process.env, request = null) {
  const normalized = toOrigin(origin);
  if (!normalized || normalized !== origin) return false;

  const canonical = toOrigin(env.APP_ORIGIN);
  if (canonical && normalized === canonical) return true;

  const configured = String(env.APP_ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => toOrigin(value.trim()))
    .filter(Boolean);
  if (configured.includes(normalized) || DEFAULT_ALLOWED_APP_ORIGINS.has(normalized)) return true;

  if (String(env.NODE_ENV || '').toLowerCase() !== 'production' && LOCAL_DEVELOPMENT_ORIGINS.has(normalized)) return true;

  return !canonical && Boolean(requestOrigin(request)) && normalized === requestOrigin(request);
}

/** Return the app origin used to validate same-origin browser routes. */
export function expectedAppOrigin(request, env = process.env) {
  return toOrigin(env.APP_ORIGIN) || requestOrigin(request);
}
