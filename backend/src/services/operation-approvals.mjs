import { mandatoryRiskDecision } from './action-gateway.mjs';

const required = ['orgId','operationId','connectionId','environment','taskId','action','inputHash','artifactHash','policyRevision','nonce','signerUserId'];

/** One-time, immutable approval gate. This service records and consumes approvals only;
 * callers must still use tool_runs as the execution/reconciliation authority. */
export function createOperationApprovalService({ repository, newId, timestamp, authorizeSigner, recheckAtExecution, transaction, lockOrganization, lockConnection }) {
  return {
    async request(binding) {
      if (required.some(key => typeof binding?.[key] !== 'string' || !binding[key])) throw new Error('Approval is missing an immutable action binding.');
      const operation=await repository.findOperationApprovalBinding(binding.orgId,binding.operationId);
      if (!operation || operation.connection_id!==binding.connectionId || operation.environment!==binding.environment || operation.task_id!==binding.taskId || operation.action!==binding.action || operation.input_hash!==binding.inputHash || operation.policy_revision!==binding.policyRevision || operation.artifact_hash!==binding.artifactHash) throw Object.assign(new Error('Approval does not match the immutable operation and artifact.'),{code:'approval_binding_conflict'});
      if (!['pending','awaiting_approval'].includes(operation.state)) throw Object.assign(new Error('Operation is no longer awaiting approval.'),{code:'approval_stale'});
      if (mandatoryRiskDecision(binding.action,binding.environment).decision!=='REQUIRE_APPROVAL') throw Object.assign(new Error('This action does not require a V2 operation approval.'),{code:'approval_not_required'});
      const at=timestamp();
      const expiresAt=binding.expiresAt || new Date(Date.now()+15*60_000).toISOString();
      if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt)<=Date.parse(at)) throw new Error('Approval expiry must be in the future.');
      await repository.insertOperationApproval(newId('approval'),binding.orgId,binding.operationId,binding.connectionId,binding.environment,binding.taskId,binding.action,binding.policyRevision,binding.nonce,binding.signerUserId,binding.artifactHash,expiresAt,at,binding.inputHash,operation.credential_version);
      const saved=await repository.findOperationApprovalByNonce(binding.orgId,binding.nonce);
      if (!saved || saved.operation_id!==binding.operationId || saved.connection_id!==binding.connectionId || saved.environment!==binding.environment || saved.task_id!==binding.taskId || saved.action!==binding.action || saved.input_hash!==binding.inputHash || saved.artifact_hash!==binding.artifactHash || saved.policy_revision!==binding.policyRevision || saved.signer_user_id!==binding.signerUserId) throw Object.assign(new Error('Approval nonce conflicts with a different immutable binding.'),{code:'approval_nonce_conflict'});
      return saved;
    },
    async approve({ orgId,approvalId,userId }) {
      const row=await repository.findOperationApproval(orgId,approvalId);
      if (!row || row.signer_user_id!==userId || row.state!=='pending' || Date.parse(row.expires_at)<=Date.parse(timestamp())) throw Object.assign(new Error('Approval signer, state, or expiry is invalid.'),{code:'approval_unauthorized'});
      if (typeof authorizeSigner!=='function' || !await authorizeSigner({orgId,userId,operationId:row.operation_id})) throw Object.assign(new Error('Signer is not authorized to approve this action.'),{code:'approval_unauthorized'});
      const changed=await repository.approveOperationApproval(userId,timestamp(),orgId,approvalId,userId,timestamp());
      if (changed?.changes!==1) throw Object.assign(new Error('Approval was already changed or consumed.'),{code:'approval_replay'});
      return repository.findOperationApproval(orgId,approvalId);
    },
    async consume({ orgId,approvalId,expected }) {
      const consumeUnderFence=async()=>{
      if (typeof lockOrganization==='function' && !await lockOrganization(orgId)) throw Object.assign(new Error('Approval organization is unavailable.'),{code:'approval_stale'});
      const row=await repository.findOperationApprovalState(orgId,approvalId);
      if (!row || row.state!=='approved' || Date.parse(row.expires_at)<=Date.parse(timestamp())) throw Object.assign(new Error('Approval is missing, expired, or already consumed.'),{code:'approval_stale'});
      if (mandatoryRiskDecision(row.action,row.environment).decision!=='REQUIRE_APPROVAL') throw Object.assign(new Error('Mandatory risk approval floor no longer matches this operation.'),{code:'approval_stale'});
      if (typeof lockConnection!=='function' || !await lockConnection(orgId,row.connection_id)) throw Object.assign(new Error('Approval connection could not be fenced.'),{code:'approval_transaction_required'});
      const exact={operationId:row.operation_id,connectionId:row.connection_id,environment:row.environment,taskId:row.task_id,action:row.action,inputHash:row.input_hash,artifactHash:row.artifact_hash,policyRevision:row.policy_revision,nonce:row.nonce,credentialVersion:Number(row.credential_version)};
      for (const [key,value] of Object.entries(exact)) if (expected?.[key]!==value) throw Object.assign(new Error(`Approval binding changed: ${key}.`),{code:'approval_stale'});
      if (row.current_input_hash!==row.input_hash || row.current_action!==row.action || row.current_task_id!==row.task_id || row.current_connection_id!==row.connection_id || row.current_environment!==row.environment || row.current_artifact_hash!==row.artifact_hash || row.current_policy_revision!==row.policy_revision) throw Object.assign(new Error('Operation, artifact, or policy changed after approval.'),{code:'approval_stale'});
      if (row.connection_status!=='connected' || row.revoked_at || Number(row.current_credential_version)!==Number(row.credential_version) || row.credential_expires_at && Date.parse(row.credential_expires_at)<=Date.parse(timestamp())) throw Object.assign(new Error('Connection credential is no longer valid.'),{code:'approval_stale'});
      if (typeof recheckAtExecution!=='function' || !await recheckAtExecution({orgId,approval:row,expected})) throw Object.assign(new Error('Current feature flag, grants, policy, or credentials reject this approval.'),{code:'approval_recheck_denied'});
      const changed=await repository.consumeOperationApproval(timestamp(),orgId,approvalId, row.expires_at, row.operation_id,row.connection_id,row.environment,row.task_id,row.action,row.input_hash,row.artifact_hash,row.policy_revision,row.nonce,Number(row.credential_version));
      if (changed?.changes!==1) throw Object.assign(new Error('Approval nonce was already consumed or became stale.'),{code:'approval_replay'});
      return { consumed:true, nonce:row.nonce, signerUserId:row.approved_by_user_id };
      };
      if (typeof transaction!=='function' || typeof lockOrganization!=='function' || typeof lockConnection!=='function') throw Object.assign(new Error('Operation approval requires transaction-backed organization and connection fences.'),{code:'approval_transaction_required'});
      return transaction(consumeUnderFence);
    },
  };
}
