import { repositories } from '../src/repositories/index.mjs';
import { createHash } from 'node:crypto';
import { id, now, transaction } from './db.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const actionFingerprint = (tool, input) => createHash('sha256').update(JSON.stringify(canonical({tool,input}))).digest('hex');

export async function recordApproval(orgId, workflowId, requestKey, request) {
  const fingerprint = actionFingerprint(request.params?.tool, request.params?.input);
  const approvalId = id('approval');
  await repositories.workflows.insertApproval(approvalId, orgId, workflowId, requestKey, fingerprint, JSON.stringify(request), now(), new Date(Date.now()+86400000).toISOString());
  const row = await repositories.workflows.findOneApprovalByOrgIdAndWorkflowIdAndRequestKeySelectIdExpiresAt(orgId, workflowId, requestKey, fingerprint);
  return { ...request, approvalId: row.id, fingerprint, expiresAt: row.expires_at };
}

export async function consumeApproval({ orgId, workflowId, requestKey, request, approvalId, approved, note, userId, transition }) {
  if (!approvalId || approvalId !== request.approvalId) throw Object.assign(new Error('This approval is stale. Reload the pending action.'), {status:409,code:'stale_approval'});
  return transaction(async () => {
    const response = { approved, note: String(note || '').slice(0,1000), reviewedBy:userId, reviewedAt:now() };
    const consumed = await repositories.workflows.updateApprovalByIdAndOrgIdAndWorkflowId(approved ? 'approved' : 'rejected', JSON.stringify(response), userId, approvalId, orgId, workflowId, requestKey, request.fingerprint, now());
    if (consumed.changes !== 1) throw Object.assign(new Error('This approval was already consumed or expired.'), {status:409,code:'stale_approval'});
    await transition(response);
    return response;
  });
}
