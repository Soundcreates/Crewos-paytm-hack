import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completedWorkflowSteps, workflowProgress } from 'solari-crew-core';

test('verified step evidence survives a worker resume without marking the task complete', () => {
  const steps = [
    { step: 0, tool: 'solari.browser.open', evidence: { title: 'Example' } },
    { step: 1, tool: 'payments.refund', evidence: { refundId: 'refund_1' } },
  ];
  const inProgress = workflowProgress('Check refund status', steps);
  assert.equal(inProgress.verified, false);
  assert.deepEqual(completedWorkflowSteps(JSON.stringify(inProgress), 2), steps);
  assert.deepEqual(completedWorkflowSteps(inProgress, 1), [steps[0]]);
  assert.deepEqual(completedWorkflowSteps('{bad json', 1), []);
});
