const text = (value) => String(value ?? '').toLowerCase();
const tokens = (value) => new Set(text(value).match(/[a-z0-9][a-z0-9._-]*/g) ?? []);
const revision = (value) => String(value ?? '');

function specHasCapability(spec, capability) {
  return Array.isArray(spec?.capabilities) && spec.capabilities.some((entry) =>
    (typeof entry === 'string' ? entry : entry?.key ?? entry?.name) === capability);
}

function scopeMatches(grant, scope) {
  if (grant?.scope !== scope?.scope) return false;
  if (scope?.scope === 'employee') return !grant.subscriptionId && !grant.principalId && !grant.connectionId && !grant.environment;
  return scope?.scope === 'event'
    && grant.subscriptionId === scope.subscriptionId
    && grant.principalId === scope.principalId
    && grant.connectionId === scope.connectionId
    && grant.environment === scope.environment;
}

function currentManagerAuthorized(grant) {
  return grant?.managerAuthorized === true || ['owner', 'admin', 'manager'].includes(grant?.currentManagerRole);
}

function guidanceScore(candidate, queryTokens) {
  const guidance = [candidate.expertise, candidate.summary, candidate.relationshipSummary].flat().join(' ');
  let score = 0;
  for (const token of tokens(guidance)) if (queryTokens.has(token)) score += 1;
  return score;
}

/**
 * Create the deterministic, side-effect-free employee delegation selector.
 *
 * Public signature: `createEmployeeDelegationService().selectCoworker({source,candidates,capability,goal,scope})`.
 * `source` is the current source employee snapshot `{id,employeeId?,orgId,state,spec,specRevision,deploymentRevision}`.
 * Each candidate is a current coworker/employee snapshot with `{id?,employeeId?,profileId,orgId,state,spec,specRevision,deploymentRevision,grant,readinessState,probationState,policyAllowed,riskAllowed,busy,activeLock,expertise,summary,relationshipSummary}`. `profileId` is the coworker row ID stored in `EmployeeSpec.coworkers`; `employeeId` (or normalized `id`) identifies the employee row. `grant` carries `state`, `sourceEmployeeId`, `targetEmployeeId`, `capability`, current `managerAuthorized` or `currentManagerRole`, source/target revision fields, and exact scope bindings. The caller supplies these current facts from its repository and policy/risk adapters.
 * Returns `{outcome:'selected',candidate}`, `{outcome:'pending_busy',candidate}`, or `{outcome:'unavailable',reason}`. Busy winners remain pending; this selector never reassigns work or creates task rows.
 */
export function createEmployeeDelegationService() {
  return Object.freeze({
    selectCoworker({ source, candidates = [], capability, goal = '', scope = { scope: 'employee' } } = {}) {
      if (!source?.id || !source?.orgId || source.state !== 'active' || !capability
          || !source.specRevision || !source.deploymentRevision || !specHasCapability(source.spec, capability)) {
        return { outcome: 'unavailable', reason: 'source_not_ready' };
      }
      const allowed = new Set(Array.isArray(source.spec.coworkers) ? source.spec.coworkers.map(String) : []);
      if (!allowed.size) return { outcome: 'unavailable', reason: 'no_allowed_coworkers' };

      const eligible = [];
      for (const candidate of candidates) {
        const grant = candidate?.grant;
        const sourceEmployeeId = source.employeeId ?? source.id;
        const targetEmployeeId = candidate?.employeeId ?? candidate?.id;
        if (!targetEmployeeId || !candidate?.profileId || candidate.orgId !== source.orgId || targetEmployeeId === sourceEmployeeId || candidate.state !== 'active') continue;
        if (!allowed.has(String(candidate.profileId)) || !scopeMatches(grant, scope)) continue;
        if (grant.sourceEmployeeId !== sourceEmployeeId || grant.targetEmployeeId !== targetEmployeeId || grant.capability !== capability) continue;
        if (grant.state !== 'active' || !currentManagerAuthorized(grant)) continue;
        // The authorization snapshot is useful only while both employees remain at
        // exactly the revisions approved by the manager.
        if (revision(grant.sourceSpecRevision) !== revision(source.specRevision)
            || revision(grant.sourceDeploymentRevision) !== revision(source.deploymentRevision)
            || revision(grant.targetSpecRevision) !== revision(candidate.specRevision)
            || revision(grant.targetDeploymentRevision) !== revision(candidate.deploymentRevision)) continue;
        if (!candidate.specRevision || !candidate.deploymentRevision || !specHasCapability(candidate.spec, capability)) continue;
        if (candidate.readinessState !== 'ready' || candidate.probationState !== 'passed') continue;
        if (candidate.policyAllowed !== true || candidate.riskAllowed !== true) continue;
        eligible.push({ candidate, score: guidanceScore(candidate, tokens(`${goal} ${capability}`)) });
      }
      if (!eligible.length) return { outcome: 'unavailable', reason: 'no_authorized_ready_target' };
      eligible.sort((left, right) => right.score - left.score || String(left.candidate.employeeId ?? left.candidate.id).localeCompare(String(right.candidate.employeeId ?? right.candidate.id)));
      const winner = eligible[0].candidate;
      if (winner.busy === true || winner.activeLock === true) return { outcome: 'pending_busy', candidate: winner };
      return { outcome: 'selected', candidate: winner };
    },
  });
}
