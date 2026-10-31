import { createOnboardingV2Service } from '../services/onboarding-v2.mjs';
import { organizationEngineV2Status } from '../services/feature-flags.mjs';

export function createOnboardingV2Controller({ repositories, HttpError, requireRole, transaction, id, now, sendJson, env = process.env, provisionEmployeeDrafts = null }) {
  const service = createOnboardingV2Service({repository:repositories.foundation,transaction,newId:id,timestamp:now,provisionEmployeeDrafts});
  return {
    async handle({path,method,response,body,context,org}) {
      if (!path.startsWith('/api/onboarding/v2')) return false;
      requireRole(context,'manager');
      const rollout = organizationEngineV2Status(org.id,env);
      if (!rollout.enabled) throw new HttpError(404,'Organization Engine V2 onboarding is disabled for this workspace.');
      if (path === '/api/onboarding/v2/session' && method === 'POST') {
        const session = await transaction(() => service.start(org.id));
        sendJson(response,200,{session}); return true;
      }
      if (path === '/api/onboarding/v2/session' && method === 'GET') {
        const session = await repositories.foundation.findActiveOnboardingSession(org.id);
        const state = session ? await service.get(org.id,session.id) : null;
        sendJson(response,200,{session:state?.session || null,profile:state?.profile || null}); return true;
      }
      const turn = path.match(/^\/api\/onboarding\/v2\/sessions\/([^/]+)\/turns$/);
      if (turn && method === 'POST') {
        const result = await service.turn({orgId:org.id,sessionId:turn[1],clientTurnId:body.clientTurnId,expectedProfileVersion:body.expectedProfileVersion,text:body.text||'',documentIds:body.documentIds||[],confirmedClaimIds:body.confirmedClaimIds||[],claims:body.claims,preview:body.preview===true});
        sendJson(response,200,result); return true;
      }
      const blueprint = path.match(/^\/api\/onboarding\/v2\/sessions\/([^/]+)\/blueprint$/);
      if (blueprint && method === 'GET') { sendJson(response,200,await service.proposeBlueprint(org.id,blueprint[1])); return true; }
      const review=path.match(/^\/api\/onboarding\/v2\/sessions\/([^/]+)\/approve$/);
      if (review && method === 'POST') {
        if(!Number.isInteger(body.blueprintVersion)||typeof body.approved!=='boolean') throw new HttpError(400,'A blueprint version and approve/decline decision are required.');
        const result=await service.reviewBlueprint(org.id,review[1],body.blueprintVersion,body.approved,context.user?.id);
        sendJson(response,200,result); return true;
      }
      throw new HttpError(404,'Onboarding route not found.');
    },
  };
}
