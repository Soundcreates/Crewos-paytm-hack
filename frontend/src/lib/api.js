import { isAdmin, isManager } from './format.js';

export class ApiError extends Error {
  constructor(message,status,code,requestId){super(message);this.name='ApiError';this.status=status;this.code=code;this.requestId=requestId;}
}
const announceOperation=detail=>window.dispatchEvent(new CustomEvent('crewos:operation',{detail}));
export async function api(path, options = {}) {
  const background = options.method === 'POST' && (/^\/api\/(documents|simulations\/[^/]+\/run|meetings\/[^/]+\/(prepare|discuss|run)|employees\/[^/]+\/probation)$/.test(path));
  const config = { credentials: 'same-origin', ...options, headers: { ...(background ? {prefer:'respond-async'} : {}), ...(options.body && !(options.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) } };
  const response = await fetch(path, config);
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(data?.message || 'The request could not be completed.',response.status,data?.code,response.headers.get('x-request-id'));
  if (response.status === 202 && data?.jobId) {
    announceOperation({id:data.jobId,path,status:'running'});
    for (;;) {
      await new Promise(resolve => setTimeout(resolve,1000));
      let job;try{job=await api('/api/jobs/'+encodeURIComponent(data.jobId),{signal:options.signal});}catch(error){announceOperation({id:data.jobId,path,status:'failed',error:'Connection lost. The server may still be working. Check Reports → Operations.'});throw error;}
      if (job.status === 'completed') {announceOperation({id:data.jobId,path,status:'completed'});return job.result;}
      if (job.status === 'failed') {announceOperation({id:data.jobId,path,status:'failed',error:job.error});throw new ApiError(job.error || 'The background operation failed.',422,'operation_failed');}
      if (options.signal?.aborted) throw new Error('The request was cancelled. The server job may still be running.');
    }
  }
  return data;
}

export async function neonAuth(path, { method = 'POST', body } = {}) {
  const response = await fetch('/api/auth/neon/' + path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  const error = data?.error;
  if (!response.ok || error) {
    const code = data?.code || data?.errorCode || error?.code || error?.errorCode;
    const message = data?.message || data?.error_description || error?.message || (typeof error === 'string' ? error : '');
    const knownMessages = {
      INVALID_EMAIL_OR_PASSWORD: 'Email or password is incorrect.',
      EMAIL_NOT_VERIFIED: 'Verify this email address before signing in.',
      INVALID_ORIGIN: 'Neon Auth rejected this app origin. Enable localhost access for the Neon Auth branch, or add this local origin to its trusted origins.',
      ORIGIN_NOT_ALLOWED: 'Neon Auth rejected this app origin. Enable localhost access for the Neon Auth branch, or add this local origin to its trusted origins.',
      EMAIL_ALREADY_EXISTS: 'An account with this email already exists. Switch to Sign in.',
    };
    const detail = (code && knownMessages[String(code).toUpperCase()]) || message || (code ? `Neon Auth rejected the request (${code}).` : `Neon Auth rejected the request (${response.status}).`);
    const requestId = response.headers.get('x-request-id');
    throw new ApiError(requestId ? `${detail} Reference: ${requestId}` : detail,response.status,code,requestId);
  }
  return data?.data ?? data;
}

export async function loadRouteData(route, session) {
  const rawRoute=route;
  route=route.split('?')[0];
  const base = route.split('/')[0];
  if (route.startsWith('employee/') && !route.endsWith('/edit')) return api('/api/employees/' + encodeURIComponent(route.split('/')[1]));
  if (route === 'chief') { const [config,v2,documents]=await Promise.all([api('/api/config'),api('/api/org-engine-v2/status').catch(()=>({enabled:false})),api('/api/documents')]);const chief=config.chiefEnabled?await api('/api/chief').catch(()=>({session:null,proposals:[]})):{session:null,proposals:[]};return {...chief,documents,chiefEnabled:Boolean(config.chiefEnabled),v2Enabled:Boolean(v2.enabled)}; }
  if (route === 'voice') {
    if (!isManager(session)) return { status: { enabled: false }, connections: [], tasks: [], onboarding: null };
    const [status, connectionResult, tasks, onboardingResult] = await Promise.all([
      api('/api/sarvam/v2/status').catch(error => ({ enabled: false, message: error.message })),
      api('/api/sarvam/v2/connections').catch(error => ({ connections: [], message: error.message })),
      api('/api/workflows').catch(() => []),
      api('/api/onboarding/v2/session').catch(error => ({ session: null, message: error.message })),
    ]);
    return { status, connections: connectionResult.connections || [], serverAppConfig: connectionResult.serverAppConfig || null, connectionError: connectionResult.message, tasks, onboarding: onboardingResult.session || null, onboardingError: onboardingResult.message };
  }
  if (route==='hire'||route.endsWith('/edit')) {const [catalog,profiles,documents,people,employee]=await Promise.all([api('/api/policies'),api('/api/solari/profiles').catch(()=>[]),api('/api/documents'),api('/api/coworkers'),route==='hire'?Promise.resolve(null):api('/api/employees/'+encodeURIComponent(route.split('/')[1]))]);return {tools:catalog.tools,profiles,documents,people,employee};}
  if (route.startsWith('meeting/')) { const [meeting, employees] = await Promise.all([api('/api/meetings/' + encodeURIComponent(route.split('/')[1])), api('/api/employees')]); return { ...meeting, employees }; }
  switch (base) {
    case 'overview': case 'setup': { const [overview, employees, office, issues,workflows,config] = await Promise.all([api('/api/overview'), api('/api/employees'), api('/api/office'), api('/api/issues'),api('/api/workflows'),api('/api/config')]); return { overview, employees, office, issues,workflows,chiefEnabled:config.chiefEnabled }; }
    case 'employees': return api('/api/employees');
    case 'schedules': { if (!isManager(session)) return {schedules:[],employees:[]}; const [schedules, employees] = await Promise.all([api('/api/schedules'), api('/api/employees')]); return { schedules, employees }; }
    case 'tasks': { const [workflows, employees] = await Promise.all([api('/api/workflows'), api('/api/employees')]); return { workflows, employees }; }
    case 'probation': { const [simulations, employees] = await Promise.all([api('/api/simulations'), api('/api/employees')]); const histories = await Promise.all(simulations.map((item) => api('/api/simulations/' + encodeURIComponent(item.id) + '/runs').catch(() => []))); return { simulations, employees, runs: histories.flat().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))) }; }
    case 'memory': { const [documents, memories] = await Promise.all([api('/api/documents'), api('/api/memories')]); return { documents, memories }; }
    case 'coworkers': { const [people, messages, relationships] = await Promise.all([api('/api/coworkers'), api('/api/messages'), api('/api/coworker-relationships')]); return { people, messages, relationships }; }
    case 'meetings': return api('/api/meetings');
    case 'office': { const [office, environments, profiles] = await Promise.all([api('/api/office'), api('/api/environments'), isManager(session) ? api('/api/solari/profiles').catch(() => []) : Promise.resolve([])]); return { office, environments, profiles }; }
    case 'integrations': { const [integrations, profiles, mcp, slack] = await Promise.all([api('/api/integrations'), isManager(session) ? api('/api/solari/profiles').catch(() => []) : Promise.resolve([]), isAdmin(session) ? api('/api/mcp-connections').catch(() => []) : Promise.resolve([]), api('/api/slack')]); return { integrations, profiles, mcp, slack }; }
    case 'commerce': { const status=await api('/api/commerce/v2/status').catch(error=>({enabled:false,message:error.message}));const [connections,liveConnections,employees]=status.enabled?await Promise.all([api('/api/commerce/v2/shopify/simulation-connections').catch(()=>[]),api('/api/commerce/v2/shopify/connections').catch(()=>[]),api('/api/employees').catch(()=>[])]):[[],[],[]];return {status,connections,liveConnections,employees}; }
    case 'reports': { const [analytics, events, billing, jobs] = await Promise.all([api('/api/analytics'), api('/api/events?limit=80'), isManager(session) ? api('/api/analytics/solari-provider-usage').catch((error) => ({ available: false, message: error.message })) : Promise.resolve(null),isManager(session) ? api('/api/jobs') : Promise.resolve([])]); return { analytics, events, billing, jobs }; }
    case 'settings': { const [organization, members, policies, integrations, mcp] = await Promise.all([api('/api/org'), api('/api/members'), api('/api/policies'), api('/api/integrations'), isAdmin(session) ? api('/api/mcp-connections') : Promise.resolve([])]); return { organization, members, policies, integrations, mcp }; }
    default: return null;
  }
}
