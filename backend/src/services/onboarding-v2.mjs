import { validateBusinessProfile } from 'solari-crew-core';
import { createHash } from 'node:crypto';

const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const pathAllowed = (path) => /^(business\.(name|description|category|targetAudiences|locales|goals|operatingPreferences)|brand\.(name|logoAssetId|palette|tone|themeStyle)|policy\.(returns|shipping|customerSupport)|products)$/.test(path);
const setPath = (root, path, value) => { const [section, key] = path.split('.'); if (key) root[section][key] = value; else root[section] = value; };
export const blankProfile = (orgId) => ({orgId,version:0,business:{targetAudiences:[],locales:[],goals:[]},brand:{},products:[],policy:{},integrationsRequested:[],missingFields:['business.name','business.description','business.targetAudiences','products'],evidenceRefs:[]});
const missing = (profile) => [!profile.business.name && 'business.name',!profile.business.description && 'business.description',!profile.business.targetAudiences?.length && 'business.targetAudiences',!profile.products.length && 'products'].filter(Boolean);

/** Deterministic, injectable extraction fallback. It only proposes claims; manager confirmation is separate. */
export function extractOnboardingClaims(text, { sourceTurnId, documentIds = [] } = {}) {
  const sourceRefs = [...documentIds.map(id => `document:${id}`), `turn:${sourceTurnId}`];
  const claims=[];
  const add=(fieldPath,value,confidence=0.72)=>claims.push({id:createHashString(`${sourceTurnId}:${fieldPath}:${canonical(value)}`).slice(0,20),fieldPath,value,sourceTurnId,confirmed:false,confidence,evidenceRefs:sourceRefs});
  const name=text.match(/\b(?:our business is called|our company is called|we are called|company name is)\s+([^.!?\n]{2,100})/i);
  if(name) add('business.name',name[1].trim(),0.86);
  const description=text.match(/\b(?:we sell|we make|our business sells|our company makes|we provide)\s+([^.!?\n]{8,400})/i);
  if(description) add('business.description',description[1].trim(),0.78);
  const audience=text.match(/\b(?:our customers are|we serve|target customers are)\s+([^.!?\n]{2,180})/i);
  if(audience) add('business.targetAudiences',[audience[1].trim()],0.76);
  const money=[...text.matchAll(/(?:\b([A-Z]{3})\s*)?([$₹€£])\s*(\d+(?:\.\d{1,2})?)(?:\s*([A-Z]{3}))?/g)];
  const ambiguous=money.length>1 && new Set(money.map(m=>`${m[1]||m[4]||({$:'USD','₹':'INR','€':'EUR','£':'GBP'}[m[2]])}:${m[3]}`)).size>1;
  const product=text.match(/\b(?:product|item)\s+([A-Za-z0-9][A-Za-z0-9 _-]{1,80})\s+(?:costs|is priced at|price is)\s+(?:[A-Z]{3}\s*)?([$₹€£])\s*(\d+(?:\.\d{1,2})?)(?:\s*([A-Z]{3}))?/i);
  if(product && !ambiguous) {
    const currency=product[4]||({$:'USD','₹':'INR','€':'EUR','£':'GBP'}[product[2]]);
    const amount=Number(product[3]);
    if(Number.isSafeInteger(Math.round(amount*100)) && amount>=0) add('products',[{localId:`product_${createHashString(`${sourceTurnId}:${product[1].trim()}`).slice(0,12)}`,title:product[1].trim(),variants:[{sku:null,priceMinor:Math.round(amount*100),currency,inventory:null}]}],0.74);
  }
  return { claims, contradictions: ambiguous ? [{fieldPath:'products',reason:'multiple_conflicting_prices',evidenceRefs:sourceRefs}] : [] };
}

export function createOnboardingV2Service({ repository, transaction, newId, timestamp, extractClaims = extractOnboardingClaims, provisionEmployeeDrafts = null }) {
  return {
    async start(orgId) {
      const existing = await repository.findActiveOnboardingSession(orgId);
      if (existing) return existing;
      const at = timestamp(), sessionId = newId('onboard');
      try { await repository.insertOnboardingSession(sessionId,orgId,`onboarding:${sessionId}`,at,at); }
      catch (error) { const winner = await repository.findActiveOnboardingSession(orgId); if (winner) return winner; throw error; }
      return repository.findOnboardingSession(orgId,sessionId) || repository.findActiveOnboardingSession(orgId);
    },
    async get(orgId, sessionId) {
      const session = await repository.findOnboardingSession(orgId,sessionId);
      if (!session) return null;
      const saved = await repository.findOrganizationProfile(orgId);
      return { session, profile:saved ? JSON.parse(saved.profile_json) : blankProfile(orgId) };
    },
    async turn({ orgId, sessionId, clientTurnId, expectedProfileVersion, text = '', documentIds = [], confirmedClaimIds = [], claims: suppliedClaims, preview = false }) {
      if (typeof clientTurnId !== 'string' || !clientTurnId.trim() || clientTurnId.length > 160) throw Object.assign(new Error('clientTurnId is required.'),{status:400});
      if (!Number.isInteger(expectedProfileVersion) || expectedProfileVersion < 0 || typeof text !== 'string' || text.length>5000 || !Array.isArray(documentIds) || documentIds.length>10 || !Array.isArray(confirmedClaimIds)) throw Object.assign(new Error('Turn version or input is invalid.'),{status:400});
      const extracted = typeof suppliedClaims === 'undefined' ? await extractClaims(text,{sourceTurnId:clientTurnId,documentIds}) : {claims:suppliedClaims,contradictions:[]};
      const claims=extracted.claims||[];
      if (!Array.isArray(claims) || claims.length>40) throw Object.assign(new Error('Extracted claims are invalid.'),{status:400});
      for(const claim of claims) { claim.confidence=Number.isFinite(Number(claim.confidence))?Number(claim.confidence):1;claim.evidenceRefs=Array.isArray(claim.evidenceRefs)?claim.evidenceRefs:[`turn:${clientTurnId}`];claim.sourceTurnId=clientTurnId; }
      if(preview){const current=await this.get(orgId,sessionId);if(!current)throw Object.assign(new Error('Onboarding session is unavailable.'),{status:404});return {claims:claims.map(claim=>({...claim,confirmed:false})),contradictions:extracted.contradictions||[],profileVersion:current.profile.version,question:current.profile.missingFields.length?`What is the ${current.profile.missingFields[0].replaceAll('.',' ')} for your business?`:null,state:current.session.state,sourceDocuments:documentIds};}
      const confirmed=new Set(confirmedClaimIds);
      for(const claim of claims) claim.confirmed=claim.confirmed===true || confirmed.has(claim.id);
      const requestHash = createHashString(canonical({expectedProfileVersion,text,documentIds,claims,confirmedClaimIds}));
      return transaction(async () => {
        const session = await repository.findOnboardingSession(orgId,sessionId);
        if (!session || !['collecting','validating','blueprint_review'].includes(session.state)) throw Object.assign(new Error('Onboarding session is unavailable.'),{status:404});
        const previous = await repository.findOnboardingTurn(orgId,sessionId,clientTurnId);
        if (previous) {
          if (previous.request_hash !== requestHash) throw Object.assign(new Error('clientTurnId was already used for a different request.'),{status:409,code:'turn_id_conflict'});
          return JSON.parse(previous.response_json);
        }
        const currentRow = await repository.findOrganizationProfile(orgId);
        const current = currentRow ? JSON.parse(currentRow.profile_json) : blankProfile(orgId);
        const currentVersion = Number(currentRow?.version || 0);
        if (currentVersion !== expectedProfileVersion || Number(session.current_profile_version || 0) !== expectedProfileVersion) throw Object.assign(new Error('The business profile changed. Refresh before submitting this turn.'),{status:409,code:'profile_version_conflict'});
        if (extracted.contradictions?.length) return {profile:current,profileVersion:currentVersion,claims,contradictions:extracted.contradictions,question:'I found conflicting price details. Which exact price and currency should I record?',state:'collecting'};
        const ownedDocuments=documentIds.length?await repository.findOwnedDocuments(orgId,documentIds):[];
        if (ownedDocuments.length!==new Set(documentIds).size) throw Object.assign(new Error('One or more selected source documents are unavailable.'),{status:404,code:'source_document_unavailable'});
        const next = structuredClone(current);
        const confirmedClaims=[];
        for (const claim of claims) {
          if (!claim || !pathAllowed(claim.fieldPath) || !('value' in claim) || !Number.isFinite(Number(claim.confidence)) || Number(claim.confidence)<0 || Number(claim.confidence)>1) throw Object.assign(new Error('Extracted claims do not match the profile schema.'),{status:400,code:'claim_invalid'});
          if(!claim.confirmed) continue;
          if(claim.fieldPath==='products') for(const proposed of claim.value) {
            const prior=current.products.find(item=>item.title.toLowerCase()===proposed.title.toLowerCase());
            if(prior && canonical(prior.variants)!==canonical(proposed.variants)) throw Object.assign(new Error('This product already has a different confirmed price or inventory. Resolve the conflict before updating it.'),{status:409,code:'profile_claim_conflict'});
          }
          setPath(next,claim.fieldPath,claim.value);
          confirmedClaims.push(claim);
        }
        next.evidenceRefs=[...new Set([...(next.evidenceRefs||[]),...confirmedClaims.flatMap(claim=>claim.evidenceRefs||[`turn:${clientTurnId}`])])];
        next.version = currentVersion + 1;
        next.missingFields = missing(next);
        if (!validateBusinessProfile(next)) throw Object.assign(new Error('Confirmed profile claims do not form a valid business profile.'),{status:400,code:'profile_invalid'});
        const at = timestamp();
        const response = { profile:next, profileVersion:next.version, claims, contradictions:[], question:next.missingFields.length ? `What is the ${next.missingFields[0].replaceAll('.',' ')} for your business?` : null, state:next.missingFields.length ? 'collecting' : 'blueprint_review' };
        const turnRowId = newId('turn');
        const turnInsert = await repository.insertOnboardingTurn(turnRowId,orgId,sessionId,clientTurnId,requestHash,JSON.stringify(response),at);
        const duplicate = await repository.findOnboardingTurn(orgId,sessionId,clientTurnId);
        if (duplicate?.request_hash !== requestHash) throw Object.assign(new Error('clientTurnId was already used for a different request.'),{status:409,code:'turn_id_conflict'});
        if (!turnInsert?.changes) return JSON.parse(duplicate.response_json);
        await repository.insertOrganizationProfile(orgId,next.version,JSON.stringify(next),at);
        for (const claim of confirmedClaims) await repository.insertProfileClaim(newId('claim'),orgId,sessionId,claim.fieldPath,JSON.stringify(claim.value),turnRowId,1,JSON.stringify({sourceTurnId:clientTurnId,source:'manager_confirmed',confirmed:true,confidence:claim.confidence,evidenceRefs:claim.evidenceRefs||[]} ),at);
        const changed = await repository.advanceOnboardingProfileVersion(next.version,JSON.stringify({question:response.question}),at,orgId,sessionId,expectedProfileVersion);
        if (!changed?.changes) throw Object.assign(new Error('The business profile changed during this turn.'),{status:409,code:'profile_version_conflict'});
        return response;
      });
    },
    async proposeBlueprint(orgId, sessionId) {
      const current = await this.get(orgId,sessionId);
      if (!current) throw Object.assign(new Error('Onboarding session is unavailable.'),{status:404});
      const previous = await repository.findBlueprint(orgId);
      if (previous && Number(previous.profile_version) === Number(current.profile.version)) return {...JSON.parse(previous.blueprint_json),status:previous.status,reviewedBy:previous.reviewed_by||null,reviewedAt:previous.reviewed_at||null};
      const version = Number(previous?.version || 0) + 1;
      const roles=[{role:'Sales',capabilities:['commerce.order.analyze'],why:'Review order evidence and surface customer or product follow-up grounded in confirmed business facts.'},{role:'Support',capabilities:['support.case.triage'],why:'Organize customer cases for manager review; outbound communication remains unavailable.'}];
      const blueprint = { version, profileVersion:current.profile.version, employees:roles.map((entry,index)=>({employeeCard:{id:`proposal_${version}_${index+1}`,role:entry.role,capabilities:entry.capabilities,status:'draft'},purpose:entry.why,evidenceRefs:[...current.profile.evidenceRefs],missingPrerequisites:[...current.profile.missingFields,...current.profile.integrationsRequested],managerReviewRequired:true})), missingConnections:[...current.profile.integrationsRequested], missingFields:[...current.profile.missingFields], executable:false, status:'proposal_only' };
      await repository.insertBlueprint(orgId,version,current.profile.version,JSON.stringify(blueprint),timestamp());
      return blueprint;
    },
    async reviewBlueprint(orgId,sessionId,version,approved,managerId) {
      return transaction(async()=>{
        const active=await repository.findOnboardingSession(orgId,sessionId);
        if(!active) throw Object.assign(new Error('Onboarding session is unavailable.'),{status:404});
        const current=await repository.findBlueprint(orgId);
        if(!current || Number(current.version)!==Number(version)) throw Object.assign(new Error('Blueprint version is stale.'),{status:409,code:'blueprint_version_conflict'});
        const blueprint=JSON.parse(current.blueprint_json);
        if(approved && (blueprint.profileVersion!==Number(active.current_profile_version) || blueprint.missingFields.length || blueprint.missingConnections.length)) throw Object.assign(new Error('Resolve missing profile fields and integration prerequisites before approving this proposal.'),{status:409,code:'blueprint_prerequisites_missing'});
        if(current.status!=='proposed') {
          if(approved && current.status==='manager_approved') return {version,status:current.status,provisioning:blueprint.provisionedEmployees?.length?'drafts_created':'setup_required',employees:blueprint.provisionedEmployees||[]};
          throw Object.assign(new Error('Blueprint review was already recorded.'),{status:409,code:'blueprint_review_conflict'});
        }
        let employees=[];
        if(approved && typeof provisionEmployeeDrafts==='function') {
          employees=await provisionEmployeeDrafts({orgId,managerId,blueprint});
          blueprint.provisionedEmployees=employees;
          blueprint.provisioning='drafts_created';
        } else blueprint.provisioning='setup_required';
        blueprint.status=approved?'manager_approved':'manager_rejected';
        const changed=await repository.reviewBlueprint(orgId,version,blueprint.status,managerId,timestamp(),JSON.stringify(blueprint));
        if(changed?.changes!==1) throw Object.assign(new Error('Blueprint review was already recorded.'),{status:409,code:'blueprint_review_conflict'});
        return {version,status:blueprint.status,provisioning:blueprint.provisioning,employees};
      });
    },
  };
}

function createHashString(value) {
  return createHash('sha256').update(value).digest('hex');
}
