const truthy = new Set(['1','true','on','yes']);
const csv = (value) => new Set(String(value || '').split(',').map(value => value.trim()).filter(Boolean));

/** V2 is opt-in independently of the legacy CREWOS_CHIEF switch. */
export function organizationEngineV2Status(orgId, env = process.env) {
  const enabled = truthy.has(String(env.CREWOS_ORG_ENGINE_V2 || '').toLowerCase());
  const allowlist = csv(env.CREWOS_ORG_ENGINE_V2_ORGS);
  const allowed = enabled && allowlist.has(orgId);
  return { enabled: allowed, globallyEnabled: enabled, allowlisted: allowlist.has(orgId), status: allowed ? 'foundation_only' : 'disabled' };
}

export const V2_UNAVAILABLE_REASON = 'Organization Engine V2 foundations exist locally but no new provider or executable task adapter is enabled.';
