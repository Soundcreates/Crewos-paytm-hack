export function parseNamedCookie(header = '', name) {
  return header
    .split(';')
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${name}=`))
    ?.slice(name.length + 1) || null;
}

export function parseCookie(header = '', cookieName) {
  const token = parseNamedCookie(header, cookieName);
  return token ? decodeURIComponent(token) : null;
}

export function requestCookiePresence(header = '', appSessionCookieName) {
  const cookieNames = header.split(';').map((pair) => pair.trim().split('=', 1)[0]);

  return {
    neonAuthCookiePresent: cookieNames.some((name) => /^(?:__Secure-)?neon-auth\.session_token$/.test(name)),
    appSessionCookiePresent: cookieNames.includes(appSessionCookieName),
  };
}

export function appendSetCookies(response, cookies) {
  if (!cookies.length) return;

  const current = response.getHeader('set-cookie');
  const existing = Array.isArray(current) ? current : current ? [current] : [];
  response.setHeader('set-cookie', [...existing, ...cookies]);
}
