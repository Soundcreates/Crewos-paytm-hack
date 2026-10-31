import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEmployeeSpec, parseEmployeeCapabilities } from 'solari-crew-core';

test('EmployeeSpec builder returns the typed report contract without retaining mutable input arrays', () => {
  const input = {
    id: 'emp_1',
    version: 2,
    profileId: null,
    name: 'Ada',
    title: 'Analyst',
    departmentId: 'Ops',
    managerId: 'user_1',
    avatarId: '◉',
    mission: 'Deliver reliable analysis.',
    responsibilities: ['Review requests'],
    successMetrics: [{ name: 'Accuracy', target: 99 }],
    capabilities: [
      { name: 'Research', description: 'Find and assess source evidence.' },
      { name: 'Reporting', description: 'Create weekly reports.' },
    ],
    tools: ['solari.browser.open'],
    policies: ['manager approval for refunds'],
    coworkers: ['emp_2'],
    evaluationPolicy: 'Pass the probation suite.',
    provenance: [{ field: 'mission', source: 'Manager input', confidence: 1 }],
  };

  const spec = buildEmployeeSpec(input);

  assert.deepEqual(spec, {
    id: input.id,
    version: input.version,
    profileId: input.profileId,
    identity: {
      name: input.name,
      title: input.title,
      departmentId: input.departmentId,
      managerId: input.managerId,
      avatarId: input.avatarId,
    },
    mission: input.mission,
    responsibilities: input.responsibilities,
    successMetrics: input.successMetrics,
    capabilities: input.capabilities,
    tools: input.tools,
    policies: input.policies,
    coworkers: input.coworkers,
    evaluationPolicy: input.evaluationPolicy,
    provenance: input.provenance,
  });
  assert.notStrictEqual(spec.responsibilities, input.responsibilities);
  assert.notStrictEqual(spec.successMetrics, input.successMetrics);
  assert.notStrictEqual(spec.capabilities, input.capabilities);
  assert.notStrictEqual(spec.provenance, input.provenance);
});

test('legacy capability names and editor lines normalize to report-shaped objects', () => {
  assert.deepEqual(parseEmployeeCapabilities([
    'Research',
    'Reporting | Create weekly reports',
    { name: 'Planning', description: 'Sequence operational work.' },
    'Research',
    '',
  ]), [
    { name: 'Research', description: '' },
    { name: 'Reporting', description: 'Create weekly reports' },
    { name: 'Planning', description: 'Sequence operational work.' },
  ]);
  assert.deepEqual(parseEmployeeCapabilities('Research\nReporting | Create weekly reports'), [
    { name: 'Research', description: '' },
    { name: 'Reporting', description: 'Create weekly reports' },
  ]);
});
