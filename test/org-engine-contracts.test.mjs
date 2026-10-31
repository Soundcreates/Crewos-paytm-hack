import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBusinessProfile, validateTaskContract, validateEventEnvelope, canTransitionTask } from '../lib/build/contracts.js';

test('business profile accepts integer minor-unit prices and rejects floating money and duplicate SKU', () => {
  const profile = { orgId:'org_a',version:1,business:{},brand:{},products:[{localId:'p1',title:'Item',variants:[{sku:'A',priceMinor:1250,currency:'USD'}]}],policy:{},integrationsRequested:[],missingFields:[],evidenceRefs:[] };
  assert.equal(validateBusinessProfile(profile), true);
  assert.equal(validateBusinessProfile({...profile,products:[{...profile.products[0],variants:[{priceMinor:12.5,currency:'USD'}]}]}), false);
  assert.equal(validateBusinessProfile({...profile,products:[...profile.products,{localId:'p2',title:'Other',variants:[{sku:'A',priceMinor:1,currency:'USD'}]}]}), false);
});

test('task and event contracts validate tenant bindings and legal task transitions', () => {
  assert.equal(validateTaskContract({id:'t1',orgId:'org_a',goal:'do work',capability:'read',state:'queued',inputRefs:[],idempotencyKey:'k'}),true);
  assert.equal(validateTaskContract({id:'t1',orgId:'org_a',goal:'do work',capability:'read',state:'completed',inputRefs:[],idempotencyKey:'k'}),true);
  assert.equal(validateEventEnvelope({id:'e1',orgId:'org_a',connectionId:'c1',provider:'fixture',eventType:'x',externalEventId:'1',environment:'simulation',simulated:true,payload:{orgId:'attacker'}}),true);
  assert.equal(canTransitionTask('queued','running'),false);
  assert.equal(canTransitionTask('running','reconciling'),true);
  assert.equal(canTransitionTask('completed','queued'),false);
});
