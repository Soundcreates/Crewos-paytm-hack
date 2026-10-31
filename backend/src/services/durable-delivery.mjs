/** Fenced leases for durable outbox and webhook inbox work; dispatch is injected by a later slice. */
export function createDurableDelivery({ repository, timestamp, leaseMs = 30_000, maxAttempts = 8 }) {
  const leaseUntil = () => new Date(Date.now()+leaseMs).toISOString();
  return {
    async claimOutbox(id) {
      const at=timestamp(), changed=await repository.claimOutbox(id,leaseUntil(),at);
      if (!changed?.changes) return null;
      return repository.findOutboxById(id);
    },
    async finishOutbox(id,generation) { return repository.finishOutboxLease(id,generation,timestamp()); },
    async failOutbox(id,generation,attempts,error) {
      const dead=Number(attempts)>=maxAttempts;
      const retryAt=dead?null:new Date(Date.now()+Math.min(300_000,1000*2**Math.max(0,Number(attempts)-1))).toISOString();
      return repository.retryOutboxLease(id,generation,retryAt,error,dead?'dead_letter':'pending');
    },
    async claimInbox(orgId,id) {
      const at=timestamp(), changed=await repository.claimInbox(orgId,id,leaseUntil(),at);
      if (!changed?.changes) return null;
      return repository.findInboxById(orgId,id);
    },
    async finishInbox(orgId,id,generation) { return repository.finishInboxLease(orgId,id,generation,timestamp()); },
    async failInbox(orgId,id,generation,attempts,error) {
      const dead=Number(attempts)>=maxAttempts;
      const retryAt=dead?null:new Date(Date.now()+Math.min(300_000,1000*2**Math.max(0,Number(attempts)-1))).toISOString();
      return repository.retryInboxLease(orgId,id,generation,retryAt,error,dead?'dead_letter':'retry');
    },
  };
}
