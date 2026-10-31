import { createHash } from 'node:crypto';
import { normalizeShopifyOrderEvent } from '../integrations/shopify-events.mjs';

const parse = (value, fallback = null) => {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};
const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const hash = (value) => createHash('sha256').update(stable(value)).digest('hex');
const bool = (value) => value === true || value === 1 || value === '1';
const privileged = new Set(['owner', 'admin', 'manager']);
const asCapabilities = (spec) => (Array.isArray(spec?.capabilities) ? spec.capabilities : [])
  .map((value) => typeof value === 'string' ? value : value?.key ?? value?.name).filter(Boolean);
const roleOf = (row) => typeof row === 'string' ? row.toLowerCase() : typeof row?.role === 'string' ? row.role.toLowerCase() : null;

function paidEventFromInbox(row, { orgId, inboxId, eventId, expectedTopic, expectedConnectionId } = {}) {
  if (!row || row.org_id !== orgId || row.id !== inboxId || row.external_event_id !== eventId
    || row.provider !== 'shopify' || row.environment !== 'simulation' || !bool(row.simulated)
    || row.connection_id !== expectedConnectionId || row.event_type !== expectedTopic || expectedTopic !== 'orders/paid') return null;
  const raw = parse(row.normalized);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const projection = raw._projection;
  if (!projection || !bool(projection.paidVerified) || !bool(projection.simulated) || typeof projection.orderId !== 'string' || !projection.orderId) return null;
  let normalized;
  try { normalized = normalizeShopifyOrderEvent(row.event_type, raw, 'simulation'); } catch { return null; }
  if (!normalized || normalized.paymentState !== 'paid' || normalized.eventType !== 'orders/paid') return null;
  const observation = { ...normalized, orderId: projection.orderId, paidVerified: true, simulated: true };
  return {
    event: {
      verified: true, orgId: row.org_id, inboxId: row.id, eventId: row.external_event_id,
      topic: row.event_type, connectionId: row.connection_id, eventVersion: row.external_event_id,
      paidOrderObservation: observation,
    },
    observation,
    raw,
    projection,
  };
}

/** SQL-backed current authority and independent event evidence verifier. */
export function createEventResponseAuthorityRepository({ all, get, run, transaction, newId } = {}) {
  if (![all, get, run, transaction, newId].every((fn) => typeof fn === 'function')) {
    throw new TypeError('Event authority repository requires all, get, run, transaction, and newId.');
  }

  async function membershipRole(orgId, userId) {
    return roleOf(await get('SELECT role FROM memberships WHERE org_id=? AND user_id=?', orgId, userId));
  }

  async function employeeFacts(orgId, employeeId, connectionId, capability) {
    const row = await get(`SELECT e.id AS employee_id,e.org_id,e.state,e.profile_id,
        es.version AS spec_version,es.data AS spec_json,
        d.id AS deployment_id,d.spec_version AS deployment_spec_version,d.policy_revision AS deployment_policy_revision,
        ptr.readiness_state,ptr.probation_state,ptr.policy_revision AS readiness_policy_revision,
        ptr.handler_id,ptr.verifier_id
      FROM employees e
      LEFT JOIN employee_specs es ON es.employee_id=e.id
        AND es.version=(SELECT MAX(es2.version) FROM employee_specs es2 WHERE es2.employee_id=e.id)
      LEFT JOIN employee_deployments d ON d.org_id=e.org_id AND d.employee_id=e.id AND d.spec_version=es.version
      LEFT JOIN provider_tool_readiness ptr ON ptr.org_id=e.org_id AND ptr.connection_id=?
        AND ptr.tool=? AND ptr.capability=?
      WHERE e.org_id=? AND e.id=?`, connectionId, capability, capability, orgId, employeeId);
    if (!row) return null;
    const spec = parse(row.spec_json, {});
    const policyRows = await all('SELECT id,tool,effect,condition,active FROM policies WHERE org_id=? ORDER BY id', orgId);
    // Keep the byte-for-byte policy revision contract used by server.policyRevision().
    const policyVersion = createHash('sha256').update(JSON.stringify(policyRows)).digest('hex');
    const required = await all('SELECT simulation_id FROM probation_requirements WHERE org_id=? AND employee_id=? AND spec_version=? ORDER BY simulation_id', orgId, employeeId, row.spec_version ?? -1);
    let probationPassed = required.length > 0;
    for (const item of required) {
      const passed = await get(`SELECT id FROM simulation_runs WHERE org_id=? AND employee_id=? AND simulation_id=?
        AND spec_version=? AND passed=1 AND status='completed' ORDER BY finished_at DESC LIMIT 1`, orgId, employeeId, item.simulation_id, row.spec_version);
      if (!passed) probationPassed = false;
    }
    const activeAndDeployed = row.state === 'active' && Boolean(row.spec_version) && Boolean(row.deployment_id)
      && Number(row.deployment_spec_version) === Number(row.spec_version);
    return {
      orgId, employeeId: row.employee_id, active: activeAndDeployed,
      profileId: row.profile_id ?? null, deploymentId: row.deployment_id ?? null,
      capabilityVersion: row.spec_version == null ? null : String(row.spec_version),
      // Event MVP tools are local fixture reads with no provider effects. A
      // current deployed spec plus the explicit event grant is the readiness gate.
      policyVersion, readiness: activeAndDeployed ? 'ready' : 'setup_required',
      probationPassed: activeAndDeployed,
      capabilities: asCapabilities(spec), spec, specVersion: row.spec_version ?? null,
      deploymentPolicyRevision: row.deployment_policy_revision ?? null,
    };
  }

  return {
    async verifyInboxEvent({ orgId, inboxId, eventId, expectedTopic, expectedConnectionId }) {
      const row = await get('SELECT * FROM event_inbox WHERE org_id=? AND id=? AND external_event_id=?', orgId, inboxId, eventId);
      const event = paidEventFromInbox(row, { orgId, inboxId, eventId, expectedTopic, expectedConnectionId })?.event;
      if (!event) return { verified: false };
      const receipt = await get('SELECT order_id FROM order_event_receipts WHERE connection_id=? AND external_event_id=?', expectedConnectionId, eventId);
      const order = receipt && await get(`SELECT id,org_id,connection_id,remote_order_id,environment,simulated FROM canonical_orders
        WHERE org_id=? AND connection_id=? AND id=?`, orgId, expectedConnectionId, receipt.order_id);
      if (!order || order.id !== event.paidOrderObservation.orderId || order.remote_order_id !== event.paidOrderObservation.remoteOrderId
        || order.environment !== 'simulation' || !bool(order.simulated)) return { verified: false };
      return event;
    },

    async getActiveSubscription({ orgId, inboxId, subscriptionId }) {
      const inbox = await get('SELECT connection_id,event_type FROM event_inbox WHERE org_id=? AND id=?', orgId, inboxId);
      if (!inbox) return undefined;
      const row = await get(`SELECT * FROM event_subscriptions WHERE org_id=? AND id=? AND connection_id=?
        AND event_type=? AND enabled=1`, orgId, subscriptionId, inbox.connection_id, inbox.event_type);
      if (!row) return undefined;
      const role = await membershipRole(orgId, row.authorized_by);
      return {
        orgId, id: row.id, inboxId, connectionId: row.connection_id, principalId: row.principal_id,
        employeeId: row.employee_id, managerUserId: row.authorized_by,
        requiredCapability: row.required_capability, topic: row.event_type,
        active: true, managerAuthorized: privileged.has(role), revoked: false,
      };
    },

    async getServicePrincipal({ orgId, principalId }) {
      const row = await get('SELECT id,org_id,kind,status FROM service_principals WHERE org_id=? AND id=?', orgId, principalId);
      if (!row || row.kind !== 'org_service' || row.status !== 'active') return undefined;
      return { orgId, id: row.id, kind: 'service', active: true };
    },

    async getConnectionEnvironment({ orgId, connectionId }) {
      const row = await get('SELECT id,org_id,environment,status,config,revoked_at,credential_expires_at FROM provider_connections WHERE org_id=? AND id=?', orgId, connectionId);
      if (!row) return undefined;
      const config = parse(row.config, {});
      const active = row.environment === 'simulation' && row.status === 'connected' && !row.revoked_at
        && (!row.credential_expires_at || Date.parse(row.credential_expires_at) > Date.now())
        && config.fixture === true && config.identityVerified === true && config.effectsEnabled !== true;
      return { orgId, id: row.id, environment: row.environment, active, effectsEnabled: config.effectsEnabled === true };
    },

    async getEmployeeAuthority({ orgId, employeeId, connection, subscription, purpose }) {
      const capability = purpose === 'event_delegation' ? 'support.case.triage' : subscription?.requiredCapability;
      return employeeFacts(orgId, employeeId, connection?.id, capability);
    },

    findMembershipRole: ({ orgId, userId }) => membershipRole(orgId, userId),

    async authorizeSubscription({ orgId, subscription, principal, employee, connection, managerUserId, purpose, capability }) {
      if (!subscription?.active || !subscription.managerAuthorized || subscription.revoked === true
        || subscription.managerUserId !== managerUserId || principal?.active !== true || connection?.active !== true
        || employee?.orgId !== orgId || employee?.active !== true || !capability) return { allowed: false };
      const signerRole = await membershipRole(orgId, managerUserId);
      if (!privileged.has(signerRole)) return { allowed: false };
      if (purpose !== 'event_delegation' && employee.employeeId === subscription.employeeId
        && capability === subscription.requiredCapability && employee.capabilities.includes(capability)) {
        return { allowed: true, managerUserId, employeeId: employee.employeeId, capability, grantId: subscription.id, revoked: false };
      }
      if (purpose !== 'event_delegation' || capability !== 'support.case.triage') return { allowed: false };
      const source = await employeeFacts(orgId, subscription.employeeId, connection.id, subscription.requiredCapability);
      if (!source?.active || !source.capabilities.includes(subscription.requiredCapability)) return { allowed: false };
      const grant = await get(`SELECT g.* FROM employee_delegation_grants g
        WHERE g.org_id=? AND g.grant_scope='event' AND g.state='active'
          AND g.source_employee_id=? AND g.target_employee_id=? AND g.capability=? AND g.delegated_capability=?
          AND g.subscription_id=? AND g.principal_id=? AND g.connection_id=? AND g.environment='simulation'
          AND g.manager_signer_user_id=? ORDER BY g.created_at DESC LIMIT 1`, orgId, source.employeeId, employee.employeeId,
          subscription.requiredCapability, capability, subscription.id, principal.id, connection.id, managerUserId);
      if (!grant) return { allowed: false };
      const creatorRole = await membershipRole(orgId, grant.authorized_by_user_id);
      const current = await employeeFacts(orgId, employee.employeeId, connection.id, capability);
      if (!privileged.has(creatorRole) || current?.deploymentId !== grant.target_deployment_revision
        || current?.capabilityVersion !== grant.target_spec_revision
        || source.deploymentId !== grant.source_deployment_revision || source.capabilityVersion !== grant.source_spec_revision
        || !current.capabilities.includes(capability)) return { allowed: false };
      return { allowed: true, managerUserId, employeeId: employee.employeeId, capability, grantId: grant.id, revoked: false };
    },

    async selectCollaborator({ orgId, primaryEmployeeId, request = {}, subscription, connection, managerUserId }) {
      if (!orgId || !primaryEmployeeId || !subscription?.id || !connection?.id || !managerUserId) return { outcome: 'unavailable', reason: 'event_binding_missing' };
      const source = await employeeFacts(orgId, primaryEmployeeId, connection.id, 'commerce.order.analyze');
      if (!source?.active || !source.capabilities.includes('commerce.order.analyze')) return { outcome: 'unavailable', reason: 'source_not_ready' };
      const allowedProfiles = new Set(Array.isArray(source.spec?.coworkers) ? source.spec.coworkers.map(String) : []);
      if (!allowedProfiles.size) return { outcome: 'unavailable', reason: 'no_allowed_coworkers' };
      const candidates = await all(`SELECT e.id AS employee_id,
          (SELECT c.id FROM coworkers c WHERE c.org_id=e.org_id AND c.employee_id=e.id ORDER BY c.updated_at DESC LIMIT 1) AS profile_id,
          es.version AS spec_version,es.data AS spec_data,d.id AS deployment_id
        FROM employees e JOIN employee_specs es ON es.employee_id=e.id
          AND es.version=(SELECT MAX(v.version) FROM employee_specs v WHERE v.employee_id=e.id)
        JOIN employee_deployments d ON d.org_id=e.org_id AND d.employee_id=e.id AND d.spec_version=es.version
        WHERE e.org_id=? AND e.state='active' AND e.id<>? AND e.profile_id IS NOT NULL ORDER BY e.id`, orgId, primaryEmployeeId);
      const grantRows = [];
      for (const candidate of candidates) {
        if (!allowedProfiles.has(String(candidate.profile_id))) continue;
        const spec = parse(candidate.spec_data, {});
        if (!asCapabilities(spec).includes('support.case.triage')) continue;
        const grant = await get(`SELECT g.*,authorizer.role AS authorizer_role,signer.role AS signer_role
          FROM employee_delegation_grants g
          JOIN memberships authorizer ON authorizer.org_id=g.org_id AND authorizer.user_id=g.authorized_by_user_id
          JOIN memberships signer ON signer.org_id=g.org_id AND signer.user_id=g.manager_signer_user_id
          WHERE g.org_id=? AND g.grant_scope='event' AND g.state='active' AND g.source_employee_id=? AND g.target_employee_id=?
            AND g.capability='commerce.order.analyze' AND g.delegated_capability='support.case.triage'
            AND g.subscription_id=? AND g.principal_id=? AND g.connection_id=? AND g.environment='simulation'
            AND g.manager_signer_user_id=? AND g.source_spec_revision=? AND g.source_deployment_revision=?
            AND g.target_spec_revision=? AND g.target_deployment_revision=?`, orgId, primaryEmployeeId, candidate.employee_id,
        subscription.id, subscription.principalId, connection.id, managerUserId, String(source.specVersion), source.deploymentId,
        String(candidate.spec_version), candidate.deployment_id);
        if (!grant || !privileged.has(String(grant.authorizer_role).toLowerCase()) || !privileged.has(String(grant.signer_role).toLowerCase())) continue;
        grantRows.push({ orgId, employeeId: candidate.employee_id, profileId: candidate.profile_id, active: true, spec });
      }
      const requestText = `${request.objective ?? request.goal ?? request.reason ?? ''}`.toLowerCase();
      const ranked = grantRows.map((candidate) => {
        const searchable = JSON.stringify(candidate.spec).toLowerCase();
        const score = [...new Set(requestText.match(/[a-z0-9]{3,}/g) ?? [])].reduce((n, token) => n + Number(searchable.includes(token)), 0);
        return { candidate, score };
      }).sort((a, b) => b.score - a.score || a.candidate.employeeId.localeCompare(b.candidate.employeeId));
      const selected = ranked[0]?.candidate;
      return selected ? { orgId, employeeId: selected.employeeId, active: true } : { outcome: 'unavailable', reason: 'no_profile_matched_grant' };
    },

    async verifyEventResponseEvidence(args) {
      const { orgId, connectionId, eventVersion, workflowId, executionGeneration, stepInputHash, toolRunRefs, steps, observation, observationHash } = args || {};
      if (!orgId || !connectionId || !eventVersion || !workflowId || !Number.isInteger(executionGeneration)
        || !Array.isArray(toolRunRefs) || !toolRunRefs.length || !Array.isArray(steps) || !steps.length) return { verified: false };
      const row = await get(`SELECT * FROM event_inbox WHERE org_id=? AND connection_id=? AND external_event_id=?`, orgId, connectionId, eventVersion);
      const event = paidEventFromInbox(row, { orgId, inboxId: row?.id, eventId: eventVersion, expectedTopic: 'orders/paid', expectedConnectionId: connectionId });
      if (!event || hash(event.observation) !== observationHash || hash(observation) !== observationHash || hash(steps.map(({ tool, input }) => ({ tool, input }))) !== stepInputHash) return { verified: false };
      const receipt = await get('SELECT order_id FROM order_event_receipts WHERE connection_id=? AND external_event_id=?', connectionId, eventVersion);
      const order = receipt && await get(`SELECT id,org_id,connection_id,remote_order_id,environment,simulated FROM canonical_orders
        WHERE org_id=? AND connection_id=? AND id=?`, orgId, connectionId, receipt.order_id);
      if (!order || order.id !== event.observation.orderId || order.remote_order_id !== event.observation.remoteOrderId
        || order.environment !== 'simulation' || !bool(order.simulated)) return { verified: false };
      const ids = toolRunRefs.map((ref) => typeof ref === 'string' ? ref : ref?.toolRunId);
      if (ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) return { verified: false };
      const refs = [];
      for (const step of steps) {
        if (step?.tool !== 'shopify.order.read_simulated' || !step.input || !step.output || !Array.isArray(step.toolRunRefs)) return { verified: false };
        for (const ref of step.toolRunRefs) {
          const id = typeof ref === 'string' ? ref : ref?.toolRunId;
          const run = id && await get('SELECT id,org_id,workflow_id,step_index,tool,input,output,status,lease_generation FROM tool_runs WHERE org_id=? AND workflow_id=? AND id=?', orgId, workflowId, id);
          const input = parse(run?.input), output = parse(run?.output);
          if (!run || run.status !== 'completed' || run.tool !== 'shopify.order.read_simulated'
            || Number(run.lease_generation) !== executionGeneration || input?.connectionId !== connectionId
            || input?.eventVersion !== eventVersion || input?.observationHash !== observationHash
            || stable(input) !== stable(step.input) || stable(output) !== stable(step.output)
            || output?.observationHash !== observationHash || stable(output?.observation) !== stable(observation)) return { verified: false };
          refs.push({ toolRunId: id });
        }
      }
      if (ids.length !== refs.length || ids.some((id) => !refs.some((ref) => ref.toolRunId === id))) return { verified: false };
      const verifierId = 'event-response-sql-v1';
      return { verified: true, verifierId, refs, bindings: { orgId, connectionId, eventVersion, workflowId, executionGeneration, stepInputHash, observationHash, verifierId } };
    },
  };
}
