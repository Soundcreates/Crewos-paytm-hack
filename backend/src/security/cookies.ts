interface CookieRequest {
  socket?: { encrypted?: boolean } | null;
}

export function useSecureCookie(req?: CookieRequest | null): boolean {
  const env = (globalThis as typeof globalThis & { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
  if (env.NODE_ENV === 'production' || env.COOKIE_SECURE === 'true') return true;
  if (env.COOKIE_SECURE === 'false') return false;
  return Boolean(req?.socket?.encrypted);
}
