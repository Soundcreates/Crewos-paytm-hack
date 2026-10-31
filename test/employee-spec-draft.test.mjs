import assert from 'node:assert/strict';
import test from 'node:test';
import { compileFallback, provenanceForDraft, provenanceSupportsField } from 'solari-crew-core';

const jobDescription = [
  'Customer Operations Specialist',
  'Own customer cases from intake through resolution.',
  '- Review customer requests within one business day.',
  '- Escalate refund requests over $500 for manager approval.',
  '- Create Jira issues to track unresolved vendor defects.',
].join('\n');

test('sample job description produces an ungranted fallback EmployeeSpec draft', () => {
  const draft = compileFallback(jobDescription, 'Customer Operations Specialist', 'Support');
  assert.equal(draft.mission, 'Deliver reliable customer operations specialist work for Support.');
  assert.deepEqual(draft.responsibilities, [
    'Own customer cases from intake through resolution.',
    'Review customer requests within one business day.',
    'Escalate refund requests over $500 for manager approval.',
    'Create Jira issues to track unresolved vendor defects.',
  ]);
  assert.deepEqual(draft.capabilities, [
    { name: 'Ownership: customer cases', description: 'Own customer cases from intake through resolution.' },
    { name: 'Review: customer requests', description: 'Review customer requests within one business day.' },
    { name: 'Escalation: refund requests', description: 'Escalate refund requests over $500 for manager approval.' },
    { name: 'Creation: Jira issues', description: 'Create Jira issues to track unresolved vendor defects.' },
  ]);
  assert.deepEqual(draft.successMetrics, [
    { name: 'Review customer requests within one business day', target: 1 },
  ]);
  assert.deepEqual(draft.tools, []);
  assert.deepEqual(draft.policies, []);
});

test('fallback emits only bounded, explicitly evidenced numeric metrics', () => {
  const draft = compileFallback([
    'Maintain at least 95% resolution rate across support cases.',
    'Resolve customer cases within 420 days.',
    'Escalate refunds over $500 for manager approval.',
    'Achieve 101% accuracy across reviewed customer requests.',
  ].join('\n'), 'Support specialist', 'Support');

  assert.deepEqual(draft.successMetrics, [
    { name: 'Maintain at least 95% resolution rate across support cases', target: 95 },
  ]);
  assert.deepEqual(draft.tools, []);
});

test('draft provenance accepts exact source excerpts and labels unsupported fields as inference', () => {
  const draft = compileFallback(jobDescription, 'Customer Operations Specialist', 'Support');
  draft.successMetrics = [{ name: 'Resolution quality', target: 95 }];
  const provenance = provenanceForDraft(draft, [{ name: 'sample-job.md', text: jobDescription }], [
    { field: 'mission', source: 'sample-job.md', evidence: 'Escalate refund requests over $500 for manager approval.' },
    { field: 'responsibilities', source: 'sample-job.md', evidence: 'A fabricated responsibility not in the job description.' },
  ]);

  assert.deepEqual(provenance.find((item) => item.field === 'mission'), { field: 'mission', source: 'Unattributed draft inference', confidence: 0.25 });
  assert.equal(provenanceSupportsField(draft.responsibilities, 'customer cases from intake through resolution'), true);
  assert.equal(provenanceSupportsField(draft.mission, 'Escalate refund requests over $500 for manager approval.'), false);
  assert.equal(provenance.find((item) => item.field === 'responsibilities').confidence, 0.95);
  assert.deepEqual(provenance.find((item) => item.field === 'successMetrics'), {
    field: 'successMetrics', source: 'Unattributed draft inference', confidence: 0.25,
  });
});
