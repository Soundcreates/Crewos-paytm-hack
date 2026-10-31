import { createEventResponseAuthorityRepository } from './event-response-authority-repository.mjs';
import { createEventResponseDelegationRepository } from './event-response-delegation-repository.mjs';
import { createEventResponseStoreRepository } from './event-response-store-repository.mjs';

/**
 * Compose the schema-backed adapters used by the event response worker.
 * The task-graph planner remains an explicit dependency so this factory cannot
 * silently bypass the organization's serialized width/depth/cycle checks.
 * SQL helper signature is `{ all, get, run, transaction, newId }`.
 */
export function createEventResponseRepository({ all, get, run, transaction, newId, planDelegation, lockOrganization, lockEmployee } = {}) {
  if (![all, get, run, transaction, newId, planDelegation, lockOrganization, lockEmployee].every((fn) => typeof fn === 'function')) {
    throw new TypeError('Event response repository requires SQL helpers, organization and employee locks, and an authoritative planDelegation adapter.');
  }
  const authorityReads = createEventResponseAuthorityRepository({ all, get, run, transaction, newId });
  const store = createEventResponseStoreRepository({
    all,
    get,
    run,
    transaction,
    newId,
    verifyEvidence: (args) => authorityReads.verifyEventResponseEvidence(args),
  });
  const delegations = createEventResponseDelegationRepository({ all, get, run, transaction, newId, planDelegation, lockOrganization, lockEmployee });
  return Object.freeze({ store, delegations, authorityReads, taskGraph: Object.freeze({ planDelegation }) });
}
