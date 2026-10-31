import assert from 'node:assert/strict';
import test from 'node:test';
import { createOnboardingV2Service } from '../backend/src/services/onboarding-v2.mjs';
import { extractOnboardingClaims } from '../backend/src/services/onboarding-v2.mjs';
import { createOnboardingV2Controller } from '../backend/src/controllers/onboarding-v2-controller.mjs';

test('onboarding client turn replays same hash and rejects duplicate key with changed body or stale version', async () => {
  const sessions = new Map(), profiles = new Map(), turns = new Map();
  const repository = {
    findActiveOnboardingSession: async org => [...sessions.values()].find(s=>s.org_id===org&&s.state==='collecting') || null,
    insertOnboardingSession: async (id,org,thread,at) => {sessions.set(id,{id,org_id:org,graph_thread_id:thread,state:'collecting',current_profile_version:0});return {changes:1};},
    findOnboardingSession: async (org,id) => sessions.get(id)?.org_id===org?sessions.get(id):null,
    findOrganizationProfile: async org => profiles.get(org)||null,
    findOnboardingTurn: async (org,sid,cid) => turns.get(`${org}:${sid}:${cid}`)||null,
    insertOnboardingTurn: async (id,org,sid,cid,hash,response) => {const k=`${org}:${sid}:${cid}`;if(turns.has(k))return {changes:0};turns.set(k,{request_hash:hash,response_json:response});return {changes:1};},
    insertOrganizationProfile: async (org,version,json) => {profiles.set(org,{version,profile_json:json});return {changes:1};},
    insertProfileClaim: async()=>({changes:1}),
    advanceOnboardingProfileVersion: async (version,_state,_at,org,sid,expected) => {const s=sessions.get(sid);if(s.org_id!==org||s.current_profile_version!==expected)return {changes:0};s.current_profile_version=version;return {changes:1};},
  };
  let serial=0;
  const service=createOnboardingV2Service({repository,transaction:fn=>fn(),newId:prefix=>`${prefix}_${++serial}`,timestamp:()=>new Date(0).toISOString()});
  const session=await service.start('org_a');
  const req={orgId:'org_a',sessionId:session.id,clientTurnId:'turn_1',expectedProfileVersion:0,claims:[{fieldPath:'business.name',value:'Acme',confirmed:true}]};
  const first=await service.turn(req);
  assert.deepEqual(await service.turn(req),first);
  await assert.rejects(service.turn({...req,claims:[{fieldPath:'business.name',value:'Other',confirmed:true}]}),{code:'turn_id_conflict'});
  await assert.rejects(service.turn({...req,clientTurnId:'turn_2'}),{code:'profile_version_conflict'});
  assert.equal(await service.get('org_b',session.id),null);
});

test('blueprint approval records a manager decision but never claims provisioning is complete', async () => {
  let blueprintStatus='proposed';const repository={foundation:{findOnboardingSession:async()=>({current_profile_version:1}),findBlueprint:async()=>({version:1,profile_version:1,blueprint_json:JSON.stringify({version:1,profileVersion:1,missingFields:[],missingConnections:[]})}),reviewBlueprint:async(_org,_version,status)=>{if(blueprintStatus!=='proposed')return{changes:0};blueprintStatus=status;return{changes:1};}}};
  const controller=createOnboardingV2Controller({repositories:repository,HttpError:class extends Error{constructor(status,message,code){super(message);this.status=status;this.code=code;}},requireRole:context=>{if(context?.role!=='manager')throw Object.assign(new Error('forbidden'),{status:403});},transaction:fn=>fn(),id:()=>'',now:()=>'',sendJson:(response,status,payload)=>{response.body=payload;response.status=status;},env:{CREWOS_ORG_ENGINE_V2:'true',CREWOS_ORG_ENGINE_V2_ORGS:'org_a'}});
  await assert.rejects(controller.handle({path:'/api/onboarding/v2/sessions/s1/approve',method:'POST',body:{},context:{role:'member'},org:{id:'org_a'}}),{status:403});
  const response={};await controller.handle({path:'/api/onboarding/v2/sessions/s1/approve',method:'POST',body:{blueprintVersion:1,approved:true},context:{role:'manager',user:{id:'manager_a'}},org:{id:'org_a'},response});
  assert.equal(response.body.status,'manager_approved');assert.equal(response.body.provisioning,'setup_required');
});

test('text extraction preserves source ids and refuses to choose between contradictory prices',()=>{
  const result=extractOnboardingClaims('Our company is called Acme. We sell handmade mugs. Product Mug costs $12.00 or $15.00.',{sourceTurnId:'turn-1',documentIds:['doc-stable-7']});
  assert.equal(result.contradictions[0].reason,'multiple_conflicting_prices');
  assert.ok(result.claims.every(claim=>claim.confirmed===false&&claim.sourceTurnId==='turn-1'&&claim.evidenceRefs.includes('document:doc-stable-7')));
  assert.ok(result.claims.some(claim=>claim.fieldPath==='business.name'&&claim.value==='Acme'));
});
