import { isIP } from 'node:net';
import { validateNeonBranchPair } from '../build/auth/neon-auth.js';

const IPV4_NON_PUBLIC_CIDRS = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].map(([network, prefixLength]) => [ipv4ToBigInt(network), prefixLength]);

const IPV6_NON_PUBLIC_CIDRS = [
  ['::', 96], // Unspecified, loopback, and deprecated IPv4-compatible addresses.
  ['64:ff9b:1::', 48], // Local-use translation prefix.
  ['100::', 64], // Discard-only range.
  ['2001::', 32], // Teredo.
  ['2001:2::', 48], // Benchmarking.
  ['2001:10::', 28], // Deprecated ORCHID.
  ['2001:20::', 28], // ORCHIDv2.
  ['2001:db8::', 32], // Documentation.
  ['2002::', 16], // Deprecated 6to4.
  ['3fff::', 20], // Documentation.
  ['fc00::', 7], // Unique local.
  ['fe80::', 10], // Link local.
  ['fec0::', 10], // Deprecated site local.
  ['ff00::', 8], // Multicast.
].map(([network, prefixLength]) => [ipv6ToBigInt(network), prefixLength]);

const IPV4_MAPPED_IPV6_PREFIX = ipv6ToBigInt('::ffff:0:0');
const NAT64_WELL_KNOWN_PREFIX = ipv6ToBigInt('64:ff9b::');

function ipv4ToBigInt(address) {
  return address.split('.').reduce((result, octet) => (result << 8n) | BigInt(octet), 0n);
}

function ipv6ToBigInt(address) {
  return ipv6Groups(address).reduce((result, group) => (result << 16n) | BigInt(group), 0n);
}

function isInCidr(address, network, prefixLength, width) {
  const hostBits = BigInt(width - prefixLength);
  return (address >> hostBits) === (network >> hostBits);
}

function isNonPublicIpv4(address) {
  const numericAddress = ipv4ToBigInt(address);
  return IPV4_NON_PUBLIC_CIDRS.some(([network, prefixLength]) => isInCidr(numericAddress, network, prefixLength, 32));
}

function ipv6Groups(address) {
  let normalized = address.toLowerCase();
  const embeddedIpv4 = /(^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (embeddedIpv4) {
    const ipv4 = ipv4ToBigInt(embeddedIpv4[2]);
    const high = Number((ipv4 >> 16n) & 0xffffn).toString(16);
    const low = Number(ipv4 & 0xffffn).toString(16);
    normalized = `${normalized.slice(0, -embeddedIpv4[2].length)}${high}:${low}`;
  }
  const halves = normalized.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  return (halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right])
    .map(group => Number.parseInt(group || '0', 16));
}

function isNonPublicIpv6(address) {
  const numericAddress = ipv6ToBigInt(address);
  if (IPV6_NON_PUBLIC_CIDRS.some(([network, prefixLength]) => isInCidr(numericAddress, network, prefixLength, 128))) return true;

  const mappedIpv4 = isInCidr(numericAddress, IPV4_MAPPED_IPV6_PREFIX, 96, 128);
  const nat64Ipv4 = isInCidr(numericAddress, NAT64_WELL_KNOWN_PREFIX, 96, 128);
  if (!mappedIpv4 && !nat64Ipv4) return false;

  const groups = ipv6Groups(address);
  const embeddedIpv4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  return isNonPublicIpv4(embeddedIpv4);
}

/** Rejects known local/special-use hosts without making DNS requests. */
function isKnownNonPublicOriginHost(hostname) {
  const unbracketed = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  const addressType = isIP(unbracketed);
  if (addressType === 4) return isNonPublicIpv4(unbracketed);
  if (addressType === 6) return isNonPublicIpv6(unbracketed);

  const normalizedHostname = hostname.toLowerCase().replace(/\.+$/, '');
  return normalizedHostname === 'localhost'
    || normalizedHostname.endsWith('.localhost')
    || normalizedHostname === 'localhost.localdomain'
    || normalizedHostname.endsWith('.localdomain')
    || normalizedHostname === 'local'
    || normalizedHostname.endsWith('.local')
    || normalizedHostname === 'host.docker.internal'
    || normalizedHostname === 'home.arpa'
    || normalizedHostname.endsWith('.home.arpa');
}

/** Static checks only: never open a database, call a provider, or return credential values. */
export function inspectConfiguration(env, { production = env.NODE_ENV === 'production' } = {}) {
  const checks = [];
  const add = (id, status, message) => checks.push({ id, status, message });
  const present = key => typeof env[key] === 'string' && Boolean(env[key].trim());
  const required = (key, message) => add(key, present(key) ? 'pass' : 'error', message);
  add('mode', 'pass', production ? 'Checking production configuration.' : 'Checking local development configuration.');
  if (production) required('DATABASE_URL', 'Production requires a PostgreSQL database URL.');
  if (present('DATABASE_URL') || present('NEON_AUTH_BASE_URL')) {
    if (!present('DATABASE_URL')) add('database_auth_pair', 'error', 'NEON_AUTH_BASE_URL requires its matching DATABASE_URL.');
    else if (!present('NEON_AUTH_BASE_URL')) {
      try {
        const database = new URL(env.DATABASE_URL);
        const localHosts = new Set(['localhost','127.0.0.1','::1','postgres','crewos-postgres','host.docker.internal']);
        if (production || env.NODE_ENV !== 'development' || !['postgres:','postgresql:'].includes(database.protocol) || !localHosts.has(database.hostname.replace(/^\[|\]$/g,'').toLowerCase())) throw new Error();
        add('database_auth_pair', 'pass', 'Using development-only local PostgreSQL with local password authentication.');
      } catch { add('database_auth_pair', 'error', 'PostgreSQL without Neon Auth is allowed only in development and only on a configured local host.'); }
    }
    else {
      try {
        const database = new URL(env.DATABASE_URL);
        if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error();
        validateNeonBranchPair(env.DATABASE_URL, env.NEON_AUTH_BASE_URL);
        add('database_auth_pair', 'pass', 'The configured Neon database and Auth endpoints match. Live authentication is still required.');
      } catch { add('database_auth_pair', 'error', 'The database/Auth URLs must be valid and identify the same Neon branch and database.'); }
    }
  } else if (!production) add('database', 'pass', 'Using local SQLite and development password authentication.');
  if (production || present('APP_ORIGIN')) {
    let valid = false;
    try {
      const origin = new URL(env.APP_ORIGIN);
      valid = (production ? origin.protocol === 'https:' : ['http:','https:'].includes(origin.protocol))
        && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash
        && (!production || !isKnownNonPublicOriginHost(origin.hostname));
    } catch {}
    add('APP_ORIGIN', valid ? 'pass' : 'error', production ? 'APP_ORIGIN must be a public HTTPS origin without a path, query or credentials.' : 'APP_ORIGIN must be an HTTP(S) origin without a path, query or credentials.');
  }
  if (production || present('APP_MASTER_KEY')) add('APP_MASTER_KEY', String(env.APP_MASTER_KEY || '').length >= 24 ? 'pass' : 'error', 'APP_MASTER_KEY needs at least 24 characters to protect saved integration keys. Back it up separately.');
  if (production && env.COOKIE_SECURE === 'false') add('COOKIE_SECURE', 'error', 'Production session cookies must remain secure. Remove COOKIE_SECURE=false.');
  const local = !production && env.NODE_ENV === 'development';
  const modelKey = local ? 'DEV_LLM_API_KEY' : 'OPENROUTER_API_KEY';
  add('model_provider', present(modelKey) ? 'pass' : 'warning', present(modelKey) ? 'A server model key is configured; model access has not been verified.' : local ? 'Set DEV_LLM_API_KEY for model features in development.' : 'No server model key is set. Configure OpenRouter or an encrypted workspace integration before running agents.');
  const evaluator = env[local ? 'DEV_LLM_EVALUATOR_MODEL' : 'OPENROUTER_EVALUATOR_MODEL'];
  const planner = env[local ? 'DEV_LLM_MODEL' : 'OPENROUTER_MODEL'] || (local ? 'gpt-6-luna' : 'openai/gpt-4o-mini');
  add('independent_evaluator', evaluator?.trim() && evaluator !== planner ? 'pass' : production ? 'error' : 'warning', 'Configure an evaluator model distinct from the planner to enable independent task grading.');
  for (const [id, keys, message] of [
    ['slack', ['SLACK_CLIENT_ID','SLACK_CLIENT_SECRET','SLACK_SIGNING_SECRET'], 'Set all Slack app credentials before installation and signed command delivery.'],
    ['jira', ['ATLASSIAN_OAUTH_CLIENT_ID','ATLASSIAN_OAUTH_CLIENT_SECRET','ATLASSIAN_OAUTH_REDIRECT_URI'], 'Set the Jira client ID, client secret and OAuth callback URL before connecting a Jira project.'],
    ['vector_memory', ['PINECONE_INDEX_HOST','PINECONE_API_KEY'], 'Set both Pinecone index host and API key for remote semantic memory. SQL and lexical retrieval remain available.'],
  ]) {
    const count = keys.filter(present).length;
    add(id, count === keys.length ? 'pass' : count ? 'error' : 'warning', count === keys.length ? `${id.replaceAll('_',' ')} configuration is present; live acceptance has not run.` : message);
  }
  for (const [key, route] of [['ATLASSIAN_OAUTH_REDIRECT_URI','/oauth/jira/callback']]) {
    if (present(key) && present('APP_ORIGIN')) {
      let valid = false;
      try { valid = new URL(env[key]).href === new URL(route, env.APP_ORIGIN).href; } catch {}
      add('jira_callback', valid ? 'pass' : 'error', 'The Jira callback must match APP_ORIGIN/oauth/jira/callback exactly.');
    }
  }
  if (present('OPENROUTER_EMBEDDING_DIMENSIONS')) {
    const dimensions = Number(env.OPENROUTER_EMBEDDING_DIMENSIONS);
    add('embedding_dimensions', Number.isInteger(dimensions) && dimensions > 0 && dimensions <= 65536 ? 'pass' : 'error', 'Embedding dimensions must be a positive integer matching the configured vector index.');
  }
  add('solari', present('SOLARI_API_KEY') ? 'pass' : 'warning', present('SOLARI_API_KEY') ? 'A Solari key is configured; browser, desktop and sandbox capability still need live acceptance.' : 'Solari tools require a server key or an encrypted workspace integration.');
  add('mcp_verifier', present('MCP_VERIFIER_MODULE') ? 'pass' : 'warning', present('MCP_VERIFIER_MODULE') ? 'An operator verifier module is configured; verify its supported tools and postconditions live.' : 'External MCP tool dispatch stays blocked until an operator verifier is configured.');
  return { ready: !checks.some(check => check.status === 'error'), production, liveVerified: false, checks };
}
