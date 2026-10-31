import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function env(): Record<string, string | undefined> {
  return (globalThis as typeof globalThis & { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
}

const browserGateway = env().SOLARI_BROWSER_BASE_URL || 'https://api.getsolari.com';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function validateSolariBrowserSession(sessionId: unknown, session: unknown, baseUrl = browserGateway): string {
  const value = record(session);
  if (typeof sessionId !== 'string' || !sessionId || value?.id !== sessionId) {
    throw new Error('The prior Solari browser session returned an invalid identity.');
  }
  const sessionOrg = sessionId.split(':')[2];
  if (!sessionOrg || value?.org !== sessionOrg) {
    throw new Error('The prior Solari browser session returned an invalid identity.');
  }
  if (value?.status === 'released' || value?.status === 'expired') {
    const error = Object.assign(new Error('The prior Solari browser session has ended.'), { code: 'solari_session_ended' });
    throw error;
  }
  if (value?.status !== 'active') {
    throw new Error('The prior Solari browser session could not be confirmed active.');
  }
  let base: URL;
  let endpoint: URL;
  try {
    base = new URL(baseUrl);
    endpoint = new URL(String(value.wsEndpoint));
  } catch {
    throw new Error('The prior Solari browser session returned an invalid endpoint.');
  }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('The configured Solari browser gateway URL is invalid.');
  }
  const expectedProtocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  const expectedPath = `/ws/${encodeURIComponent(sessionId)}`;
  if (endpoint.protocol !== expectedProtocol || endpoint.hostname !== base.hostname || endpoint.port !== base.port || endpoint.pathname !== expectedPath || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('The prior Solari browser session returned an invalid endpoint.');
  }
  return endpoint.toString();
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0);
  }
  if (version === 6) {
    const value = address.toLowerCase();
    if (value.startsWith('::ffff:')) {
      const mapped = value.slice(7);
      if (isIP(mapped) === 4) return isPrivateAddress(mapped);
    }
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value) || value.startsWith('ff') || !/^2[0-9a-f]{3}:/.test(value) || value.startsWith('2001:db8:');
  }
  return true;
}

export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Private network targets are blocked.');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error('Private network targets are blocked.');
}
