import { actionFingerprint } from '../../lib/approvals.mjs';
export { validateShopifyProductInput } from '../integrations/shopify-product-contract.mjs';

/** Validate the persisted manager decision against the exact simulation action. */
export function validateShopifyProductApproval({orgId,workflowId,taskId,connection,input,request,response,policyRevision,policyDecision}){
  const binding=request?.params?.commerceBinding;
  const expectedHash=actionFingerprint('shopify.product.set',input);
  const valid=policyDecision==='REQUIRE_APPROVAL'&&request&&binding&&response?.approved===true&&response.reviewedBy&&request.fingerprint===expectedHash&&binding.orgId===orgId&&binding.workflowId===workflowId&&binding.taskId===taskId&&binding.connectionId===connection?.id&&binding.storeDomain===connection?.provider_account_id&&binding.environment==='simulation'&&binding.inputHash===expectedHash&&binding.policyRevision===policyRevision&&typeof binding.nonce==='string'&&binding.nonce.length>=8&&request.approvalId;
  if(!valid)throw Object.assign(new Error('A current manager approval for this exact product draft is required.'),{code:'approval_required',status:409});
  return {inputHash:expectedHash,approvalId:request.approvalId,nonce:binding.nonce,signer:response.reviewedBy,policyRevision:binding.policyRevision};
}
