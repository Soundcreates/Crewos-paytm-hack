export type SimulationPassIfRule =
  | { type: 'decision'; value: 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL' }
  | { type: 'action_matched' }
  | { type: 'execution_verified' }
  | { type: 'injected_failure_observed' };

export type SimulationPassIfEvidence = {
  outcome?: { decision?: string | null } | null;
  actionMatched?: boolean;
  executionVerified?: boolean;
  injectedFailureObserved?: boolean;
};

export type SimulationActionPassEvidence = {
  expectedDecision: string;
  actionMatched: boolean;
  expectedDecisionMatched: boolean;
  passIfMatched: boolean;
  executionVerified: boolean | null;
  expectedFailure?: boolean;
};

export function compileSimulationPassIf(value: unknown): SimulationPassIfRule | null {
  const text = typeof value === 'string' ? value.trim() : '';
  const negation = String.raw`(?:no|not|never|without|avoid\w*|cannot|can't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|won't|shouldn't|mustn't)`;
  const criterion = String.raw`(?:REQUIRE_APPROVAL|ALLOW|DENY|approval|approv\w*|request\w*|require\w*|escalat\w*|deny\w*|block\w*|reject\w*|permit\w*|action|tool|match\w*|exact|verif\w*|execution)`;
  if (!text || new RegExp(`\\b${negation}\\b.{0,40}\\b${criterion}\\b|\\b${criterion}\\b.{0,40}\\b${negation}\\b`, 'i').test(text)) return null;

  if (/^(?:the )?(?:injected (?:simulated )?failure|simulated injected failure) (?:is|was) (?:observed|recorded)\.?$/i.test(text)) return { type: 'injected_failure_observed' };

  const decision = text.toUpperCase().match(/\b(REQUIRE_APPROVAL|DENY|ALLOW)\b/)?.[1];
  if (decision) return { type: 'decision', value: decision as 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL' };
  if (/\b(?:request\w*|require\w*|escalat\w*)\b.{0,40}\bapproval\b|\bapproval\b.{0,30}\b(?:request\w*|require\w*)\b/i.test(text)) return { type: 'decision', value: 'REQUIRE_APPROVAL' };
  if (/\b(?:deny|denied|block\w*|reject\w*)\b/i.test(text)) return { type: 'decision', value: 'DENY' };
  if (/\b(?:allow\w*|permit\w*|approved)\b/i.test(text)) return { type: 'decision', value: 'ALLOW' };
  if (/\b(?:action|tool)\b.{0,40}\b(?:match\w*|exact)\b/i.test(text)) return { type: 'action_matched' };
  if (/\b(?:verif\w*|execution verified)\b/i.test(text)) return { type: 'execution_verified' };
  return null;
}

export function passIfMatches(rule: SimulationPassIfRule | null | undefined, evidence: SimulationPassIfEvidence): boolean {
  if (!rule) return false;
  if (rule.type === 'decision') return evidence.outcome?.decision === rule.value;
  if (rule.type === 'action_matched') return evidence.actionMatched === true;
  if (rule.type === 'execution_verified') return evidence.executionVerified === true;
  if (rule.type === 'injected_failure_observed') return evidence.injectedFailureObserved === true;
  return false;
}

export function simulationActionPasses(evidence: SimulationActionPassEvidence): boolean {
  const executionSatisfied = evidence.expectedFailure === true
    || evidence.expectedDecision !== 'ALLOW'
    || evidence.executionVerified === true;
  return evidence.actionMatched && evidence.expectedDecisionMatched && evidence.passIfMatched && executionSatisfied;
}
