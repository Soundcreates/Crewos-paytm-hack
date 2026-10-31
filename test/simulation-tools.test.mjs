import test from 'node:test';
import assert from 'node:assert/strict';
import { canExecuteSimulationTool, executeSimulatedRefund, verifySimulatedRefund } from 'solari-crew-core';

test('simulation refund executes and verifies only in the simulated ledger', () => {
  const input = { amount: '125.50', currency: 'usd', caseId: 'CASE-42' };
  const output = executeSimulatedRefund(input, 'simrun_1', 0);
  assert.deepEqual(output, { ok: true, simulated: true, refundId: 'simrun_1:0', caseId: 'CASE-42', amount: 125.5, currency: 'USD', status: 'simulated' });
  assert.equal(verifySimulatedRefund(input, output).verified, true);
  assert.equal(verifySimulatedRefund(input, { ...output, amount: 126 }).verified, false);
});

test('simulation refund rejects invalid amount, currency, and case identifiers', () => {
  for (const input of [
    { amount: 0, currency: 'USD', caseId: 'C-1' },
    { amount: 1_000_001, currency: 'USD', caseId: 'C-1' },
    { amount: 1, currency: 'US', caseId: 'C-1' },
    { amount: 1, currency: 'USD', caseId: ' ' },
  ]) assert.throws(() => executeSimulatedRefund(input, 'simrun_1', 0));
});

test('simulation ALLOW actions are limited to simulated or read-only tools', () => {
  assert.equal(canExecuteSimulationTool('payments.refund', {}), true);
  assert.equal(canExecuteSimulationTool('solari.sandbox.echo', { message: 'hello' }), true);
  assert.equal(canExecuteSimulationTool('solari.browser.open', { url: 'https://example.com' }), true);
  assert.equal(canExecuteSimulationTool('solari.desktop.exec', { command: 'echo' }), false);
  assert.equal(canExecuteSimulationTool('jira.create_issue', {}), false);

  assert.equal(canExecuteSimulationTool('solari.browser.interact', {
    actions: [{ action: 'assertText', text: 'Read-only page content' }],
  }), true);
  assert.equal(canExecuteSimulationTool('solari.browser.interact', {
    actions: [
      { action: 'click', selector: '#submit' },
      { action: 'assertText', text: 'Submitted' },
    ],
  }), false);
  assert.equal(canExecuteSimulationTool('solari.browser.interact', {
    actions: [{ action: 'wait', selector: '#loading', state: 'hidden' }],
  }), false);
});
