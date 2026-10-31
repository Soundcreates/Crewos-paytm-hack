import { repositories } from '../src/repositories/index.mjs';
import { actionFingerprint } from './approvals.mjs';
import { id, now } from './db.mjs';

const owner = id('jobs');
const handlers = new Map();
const active = new Set();
let stopping = false;

export function registerJobHandler(kind, handler) { handlers.set(kind, handler); }

export async function enqueueJob(orgId, kind, payload, dedupeKey = id('job-key')) {
  const jobId = id('job');
  const timestamp = now();
  await repositories.operations.insertBackgroundJob(jobId, orgId, kind, JSON.stringify(payload), dedupeKey, actionFingerprint(kind,payload), timestamp, timestamp, timestamp);
  const row=await repositories.operations.findOneBackgroundJobByOrgIdAndDedupeKey(orgId, dedupeKey);
  if (!row || row.input_hash !== actionFingerprint(kind,payload)) throw Object.assign(new Error('This idempotency key belongs to a different operation.'),{status:409});
  const {input_hash,...result}=row;
  return result;
}

export async function pollJobs() {
  if (stopping || active.size >= 4) return;
  const timestamp = now();
  const rows = await repositories.operations.findManyBackgroundJobByStatusAndAvailableAtAndLeaseExpiresAt(timestamp, timestamp, 4 - active.size);
  for (const row of rows) {
    if (active.has(row.id)) continue;
    const claimed = await repositories.operations.updateBackgroundJobByIdAndStatusAndAvailableAt(owner, new Date(Date.now()+60000).toISOString(), timestamp, row.id, timestamp, timestamp);
    if (claimed.changes !== 1) continue;
    active.add(row.id);
    void executeJob(row.id).finally(() => active.delete(row.id));
  }
}

async function executeJob(jobId) {
  const job = await repositories.operations.findOneBackgroundJobByIdAndLeaseOwner(jobId, owner);
  if (!job) return;
  const heartbeat = setInterval(() => {
    void repositories.operations.updateBackgroundJobByIdAndLeaseOwnerAndStatus(new Date(Date.now()+60000).toISOString(), jobId, owner).catch(() => {});
  }, 15000);
  heartbeat.unref?.();
  try {
    const handler = handlers.get(job.kind);
    if (!handler) throw new Error(`No worker handler for ${job.kind}.`);
    const result = await handler(JSON.parse(job.payload), job);
    await repositories.operations.updateBackgroundJobByIdAndLeaseOwnerAndStatusSetStatusPayloadResult(JSON.stringify(result ?? null), now(), jobId, owner);
  } catch (error) {
    const retryable = ['memory.index', 'memory.delete'].includes(job.kind)
      || (!(Number(error?.status)>=400 && Number(error?.status)<500) && error?.permanent !== true && job.attempts < 8);
    const delay = Math.max(Number(error?.retryAfterMs) || 0, Math.min(300000, 1000 * 2 ** job.attempts));
    await repositories.operations.updateBackgroundJobByIdAndLeaseOwnerAndStatusSetStatusErrorAvailableAt(retryable ? 'queued' : 'failed', String(error?.message || 'Job failed.').slice(0,500), new Date(Date.now()+delay).toISOString(), now(), jobId, owner).catch(() => {});
  } finally { clearInterval(heartbeat); }
}

export async function drainJobs(timeoutMs = 30000) {
  stopping = true;
  const deadline = Date.now()+timeoutMs;
  while (active.size && Date.now()<deadline) await new Promise(resolve => setTimeout(resolve,50));
  return active.size === 0;
}

export function jobsHealth() { return { active: active.size, stopping }; }
