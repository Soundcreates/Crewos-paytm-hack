import test from 'node:test';
import assert from 'node:assert/strict';
import { compileSimulationPassIf, passIfMatches, simulationActionPasses } from 'solari-crew-core';

test('$1,000 refund above the $500 limit passes on REQUIRE_APPROVAL and fails on ALLOW', () => {
  const evidence = { outcome: { decision: 'REQUIRE_APPROVAL' } };
  const escalation = compileSimulationPassIf('The policy guard requests human approval.');
  const allow = compileSimulationPassIf('The policy gateway returns ALLOW.');

  assert.deepEqual(escalation, { type: 'decision', value: 'REQUIRE_APPROVAL' });
  assert.equal(passIfMatches(escalation, evidence), true);
  assert.equal(passIfMatches(allow, evidence), false);
});

test('action match and execution verification criteria require positive evidence', () => {
  const actionRule = compileSimulationPassIf('The action matches the expected tool.');
  const executionRule = compileSimulationPassIf('The execution is verified.');

  assert.deepEqual(actionRule, { type: 'action_matched' });
  assert.equal(passIfMatches(actionRule, { actionMatched: true }), true);
  assert.equal(passIfMatches(actionRule, { actionMatched: false }), false);
  assert.deepEqual(executionRule, { type: 'execution_verified' });
  assert.equal(passIfMatches(executionRule, { executionVerified: true }), true);
  assert.equal(passIfMatches(executionRule, { executionVerified: false }), false);
  assert.equal(passIfMatches(executionRule, {}), false);
});

test('injected failure criteria require explicit simulation evidence, not a planner error', () => {
  const rule = compileSimulationPassIf('The injected simulated failure was observed.');

  assert.deepEqual(rule, { type: 'injected_failure_observed' });
  assert.equal(passIfMatches(rule, { injectedFailureObserved: true }), true);
  assert.equal(passIfMatches(rule, { plannerError: 'provider failed' }), false);
  assert.equal(passIfMatches(rule, { injectedFailureObserved: false, plannerError: 'provider failed' }), false);
  assert.equal(compileSimulationPassIf('The injected failure was not observed.'), null);
});

test('negated passIf phrasing fails closed instead of compiling as a positive decision', () => {
  for (const passIf of ['Do not ALLOW this refund.', 'The result must not be ALLOW.', 'Never permit the action.']) {
    assert.equal(compileSimulationPassIf(passIf), null, passIf);
  }
});

test('ALLOW simulation actions need verified execution unless an injected failure was observed', () => {
  const base = { expectedDecision: 'ALLOW', actionMatched: true, expectedDecisionMatched: true, passIfMatched: true, executionVerified: null };
  assert.equal(simulationActionPasses(base), false);
  assert.equal(simulationActionPasses({ ...base, executionVerified: false }), false);
  assert.equal(simulationActionPasses({ ...base, executionVerified: true }), true);
  assert.equal(simulationActionPasses({ ...base, expectedDecision: 'REQUIRE_APPROVAL' }), true);
  assert.equal(simulationActionPasses({ ...base, executionVerified: false, expectedFailure: true }), true);
});
