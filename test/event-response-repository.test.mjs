import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventResponseRepository } from '../backend/src/repositories/event-response-repository.mjs';

test('event response repository composes schema-backed stores and requires a task graph planner', () => {
  const helpers = { all: async () => [], get: async () => null, run: async () => ({ changes: 0 }),
    transaction: async (operation) => operation(), newId: () => 'id', lockOrganization: async () => ({ id: 'org' }), lockEmployee: async () => ({ id: 'employee' }) };
  assert.throws(() => createEventResponseRepository(helpers), /authoritative planDelegation/);
  const repository = createEventResponseRepository({ ...helpers, planDelegation: async () => ({ allowed: false }) });
  assert.equal(typeof repository.store.ensurePrimaryFenced, 'function');
  assert.equal(typeof repository.store.recordWorkflowEvidenceFenced, 'function');
  assert.equal(typeof repository.delegations.ensureChildFenced, 'function');
  assert.equal(typeof repository.delegations.resolveFenced, 'function');
  assert.equal(typeof repository.authorityReads.verifyEventResponseEvidence, 'function');
});
