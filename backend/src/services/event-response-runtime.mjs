const TOOL = 'shopify.order.read_simulated';
const TOOLS = Object.freeze([TOOL]);

const need = (o, k) => {
  if (typeof o?.[k] !== 'function') throw new TypeError(`Missing event response runtime function: ${k}`);
  return o[k].bind(o);
};
const roleOf = (x) => typeof x === 'string' ? x.toLowerCase() : typeof x?.role === 'string' ? x.role.toLowerCase() : null;
const allow = (tools) => Array.isArray(tools) && tools.length > 0 && tools.every((x) => x === TOOL);

/** Compose simulation-only adapters for createEventEmployeeResponseService. */
export function createEventResponseRuntime({ repository, currentAuthority, selector, worker, policies, llmJson }) {
  if (!repository?.store || !repository?.delegations || !repository?.authorityReads) throw new TypeError('Expected repository { store, delegations, authorityReads }.');
  const ar = repository.authorityReads;
  const authority = {
    verifyInboxEvent: need(ar, 'verifyInboxEvent'), getActiveSubscription: need(ar, 'getActiveSubscription'),
    getServicePrincipal: need(ar, 'getServicePrincipal'), getConnectionEnvironment: need(ar, 'getConnectionEnvironment'),
    getEmployeeAuthority: need(ar, 'getEmployeeAuthority'), findMembershipRole: need(ar, 'findMembershipRole'),
    authorizeSubscription: need(ar, 'authorizeSubscription'), assessRisk: need(policies, 'assessRisk'),
    selectCollaborator: async (args) => need(selector, 'selectCollaborator')({ ...args, profileTextIsUntrusted: true }),
  };
  // Normalize membership's supported string/{role} return shape; coordinator applies allowlist.
  const rawMembership = authority.findMembershipRole;
  authority.findMembershipRole = async (args) => roleOf(await rawMembership(args));
  const workflowWorker = {
    runWorkflow: async (args) => {
      if (!allow(args.allowedTools)) throw Object.assign(new Error('Only simulated Shopify order reads are allowed.'), { code: 'tool_not_allowed' });
      const result = await need(worker, 'runWorkflow')({ ...args, allowedTools: TOOLS });
      if (result?.plan && result.plan.some((s) => s?.tool !== TOOL)) throw Object.assign(new Error('Worker plan exceeded simulation allowlist.'), { code: 'tool_not_allowed' });
      return result;
    },
    resumeWorkflow: async (args) => {
      if (!allow(args.allowedTools)) throw Object.assign(new Error('Only simulated Shopify order reads are allowed.'), { code: 'tool_not_allowed' });
      return need(worker, 'resumeWorkflow')({ ...args, allowedTools: TOOLS });
    },
  };
  const taskGraph = { planDelegation: need(repository.taskGraph, 'planDelegation') };
  const reasoner = { reason: async (args) => {
    if (!allow(args.allowedTools)) throw Object.assign(new Error('Only simulated Shopify order reads are allowed.'), { code: 'tool_not_allowed' });
    // LLM output is untrusted; coordinator validates substantive steps and the worker enforces tools.
    return need(llmJson, 'reason')({ ...args, allowedTools: TOOLS, untrustedObservation: true, untrustedEmployeeInstructions: true });
  } };
  const evidenceVerifier = { verify: need(ar, 'verifyEventResponseEvidence') };
  return { store: repository.store, authority, workflowWorker, taskGraph, delegations: repository.delegations, reasoner, evidenceVerifier };
}
