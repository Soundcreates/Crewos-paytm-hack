import assert from 'node:assert/strict';
import test from 'node:test';
import { provenanceForEditedFields } from 'solari-crew-core';

test('only manager-edited spec fields lose their source citations', () => {
  const source = { identity: { name: 'Refund Agent', managerId: 'user_1' }, mission: 'Resolve refunds.', responsibilities: ['Verify the customer case.'] };
  const provenance = [
    { field: 'mission', source: 'Job description.pdf', evidence: 'Resolve customer refund questions.' },
    { field: 'responsibilities', source: 'Refund SOP.txt', evidence: 'Verify the customer case before taking action.' },
  ];
  const edited = { ...source, mission: 'Resolve refunds and escalate unusual cases.' };
  assert.deepEqual(provenanceForEditedFields(source, edited, provenance), [
    provenance[1],
    { field: 'mission', source: 'Manager input', confidence: 1 },
  ]);
});
