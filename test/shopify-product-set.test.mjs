import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEmployeeToolRegistry, validateEmployeeToolInput } from '../backend/workflows/langgraph/tool-registry.mjs';
import { createShopifyFixtureAdapter } from '../backend/src/integrations/shopify-commerce.mjs';
import { mandatoryRiskDecision } from '../backend/src/services/action-gateway.mjs';
import { actionFingerprint } from '../backend/lib/approvals.mjs';
import { validateShopifyProductApproval } from '../backend/src/services/shopify-product-authorization.mjs';
import { validateShopifyProductInput } from '../backend/src/integrations/shopify-product-contract.mjs';
import { evaluatePolicy } from 'solari-crew-core';

const entry={key:'shopify.product.set',label:'Set Shopify simulation product',providerTool:true,requiresProviderConnection:true,simulationOnly:true,requiredScopes:['read_products','write_products']};
const readiness={state:'ready',connectionId:'conn_sim',connectionStatus:'connected',credentialState:'fixture',environment:'simulation',requiredScopes:['read_products','write_products'],grantedScopes:['read_products','write_products'],handlerId:'shopify-fixture-product-set-v1',verifierId:'shopify-fixture-readback-v1',policyRevision:'rev-1'};

test('product-set tool requires a grant, current simulation readiness, probation and stays out of PILOT_MODE',()=>{
  const available=buildEmployeeToolRegistry([entry],['shopify.product.set'],{providerReadiness:()=>readiness,providerProbation:()=>({passed:true,policyRevision:'rev-1'})});
  assert.equal(available.length,1);
  assert.doesNotThrow(()=>validateEmployeeToolInput(available[0],{connectionId:'conn_sim',idempotencyKey:'draft-key-001',products:[{title:'Mug',variants:[{sku:'MUG-1',priceMinor:1200,currency:'USD'}]}]}));
  assert.throws(()=>validateEmployeeToolInput(available[0],{connectionId:'conn_sim',idempotencyKey:'draft-key-001',products:[{title:'Mug',variants:[{sku:'MUG-1',priceMinor:1200,currency:'USD',inventory:2}]}]}));
  assert.throws(()=>validateEmployeeToolInput(available[0],{connectionId:'conn_sim',idempotencyKey:'draft-key-001',products:[{title:'Mug',variants:[{sku:'MUG-1',priceMinor:1200,currency:'usd'}]}]}),{code:'invalid_tool_input'});
  assert.throws(()=>validateShopifyProductInput({products:[{title:'Mug',variants:[{sku:'MUG-1',priceMinor:1200,currency:'US'}]}]}),{code:'invalid_tool_input'});
  assert.equal(buildEmployeeToolRegistry([entry],[],{providerReadiness:()=>readiness,providerProbation:()=>({passed:true,policyRevision:'rev-1'})}).length,0);
  assert.equal(buildEmployeeToolRegistry([entry],['shopify.product.set'],{providerReadiness:()=>readiness,providerProbation:()=>({passed:true,policyRevision:'rev-old'})}).length,0);
  assert.equal(buildEmployeeToolRegistry([entry],['shopify.product.set'],{providerReadiness:()=>readiness,providerProbation:()=>({passed:false,policyRevision:'rev-1'})}).length,0);
  assert.equal(buildEmployeeToolRegistry([entry],['shopify.product.set'],{providerReadiness:()=>({...readiness,environment:'production',credentialState:'active'}),providerProbation:()=>({passed:true,policyRevision:'rev-1'})}).length,0);
  assert.equal(buildEmployeeToolRegistry([entry],['shopify.product.set'],{providerReadiness:()=>readiness,providerProbation:()=>({passed:true,policyRevision:'rev-1'}),pilotMode:true}).length,0);
  assert.equal(evaluatePolicy({tools:[]},'shopify.product.set',{}).decision,'DENY');
  assert.equal(mandatoryRiskDecision('shopify.product.set','simulation').decision,'REQUIRE_APPROVAL');
});

test('local product-set fixture replays identical idempotency input and conflicts on changed input',async()=>{
  const context={orgId:'org_a',connectionId:'conn_sim',provider:'shopify',providerAccountId:'acme.myshopify.com',environment:'simulation',scopes:['read_products','write_products'],verified:true};
  const product={title:'Test mug',variants:[{sku:'MUG-1',priceMinor:1299,currency:'USD'}]};
  const adapter=createShopifyFixtureAdapter({context,fixture:{},requiredScopes:['read_products','write_products']});
  const first=await adapter.upsertCatalog({products:[product],idempotencyKey:'draft-key-001'});
  const replay=await adapter.upsertCatalog({products:[product],idempotencyKey:'draft-key-001'});
  assert.deepEqual(replay,first);
  await assert.rejects(adapter.upsertCatalog({products:[{...product,title:'Changed'}],idempotencyKey:'draft-key-001'}),{code:'idempotency_conflict'});
});

test('fixture userErrors fail closed and approval fingerprints are input-specific',async()=>{
  const context={orgId:'org_a',connectionId:'conn_sim',provider:'shopify',providerAccountId:'acme.myshopify.com',environment:'simulation',scopes:['read_products','write_products'],verified:true};
  const product={title:'Rejected mug',variants:[{sku:'MUG-2',priceMinor:1299,currency:'USD'}]};
  const adapter=createShopifyFixtureAdapter({context,fixture:{userErrors:[{productTitle:product.title}]},requiredScopes:['read_products','write_products']});
  const result=await adapter.upsertCatalog({products:[product],idempotencyKey:'draft-key-002'});
  assert.equal(result.ok,false);
  assert.equal(result.simulated,true);
  assert.equal(result.userErrors.length,1);
  assert.notEqual(actionFingerprint('shopify.product.set',{products:[product]}),actionFingerprint('shopify.product.set',{products:[{...product,title:'Different'}]}));
  assert.equal(mandatoryRiskDecision('shopify.product.set','production').decision,'REQUIRE_APPROVAL');
  const mismatch=createShopifyFixtureAdapter({context,fixture:{readbackMismatch:true},requiredScopes:['read_products','write_products']});
  await assert.rejects(mismatch.upsertCatalog({products:[product],idempotencyKey:'draft-key-mismatch'}),{code:'verification_failed'});
});

test('approval binding rejects stale policy, changed input, tenant and denied policy decisions',()=>{
  const orgId='org_a',workflowId='wf_a',input={connectionId:'conn_sim',idempotencyKey:'draft-key-003',products:[{title:'Lamp',variants:[{sku:'LAMP-1',priceMinor:500,currency:'USD',inventory:1}]}]},connection={id:'conn_sim',provider_account_id:'acme.myshopify.com'};
  const fingerprint=actionFingerprint('shopify.product.set',input),request={approvalId:'approval-1',fingerprint,params:{commerceBinding:{orgId,workflowId,taskId:workflowId,connectionId:connection.id,storeDomain:connection.provider_account_id,environment:'simulation',inputHash:fingerprint,policyRevision:'rev-1',nonce:'nonce-123456'}}},response={approved:true,reviewedBy:'manager-1'};
  assert.equal(validateShopifyProductApproval({orgId,workflowId,taskId:workflowId,connection,input,request,response,policyRevision:'rev-1',policyDecision:'REQUIRE_APPROVAL'}).signer,'manager-1');
  assert.throws(()=>validateShopifyProductApproval({orgId,workflowId,taskId:workflowId,connection,input,request,response,policyRevision:'rev-2',policyDecision:'REQUIRE_APPROVAL'}),{code:'approval_required'});
  assert.throws(()=>validateShopifyProductApproval({orgId,workflowId,taskId:workflowId,connection,input:{...input,idempotencyKey:'changed-key'},request,response,policyRevision:'rev-1',policyDecision:'REQUIRE_APPROVAL'}),{code:'approval_required'});
  assert.throws(()=>validateShopifyProductApproval({orgId:'org_other',workflowId,taskId:workflowId,connection,input,request,response,policyRevision:'rev-1',policyDecision:'REQUIRE_APPROVAL'}),{code:'approval_required'});
  assert.throws(()=>validateShopifyProductApproval({orgId,workflowId,taskId:workflowId,connection,input,request,response,policyRevision:'rev-1',policyDecision:'DENY'}),{code:'approval_required'});
});
