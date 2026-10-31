/** SQL access for additive task/event/action foundations. */
function mutationCount(result) {
  if (typeof result === 'number') return result;
  return Number(result?.changes ?? result?.rowCount ?? result?.count ?? 0);
}

export function createFoundationRepository({ all, get, run }) {
  return {
    findTaskByWorkflow: (...p) => get('SELECT * FROM crew_tasks WHERE org_id=? AND workflow_id=?',...p),
    ensureWorkflowTaskCompanion: async (orgId,workflowId,at) => {
      const workflow=await get('SELECT id,org_id,employee_id,goal,spec_version,runtime_version,created_at,updated_at FROM workflows WHERE org_id=? AND id=?',orgId,workflowId);
      if (!workflow) return null;
      let task=await get('SELECT * FROM crew_tasks WHERE org_id=? AND workflow_id=?',orgId,workflowId);
      if (task) {
        if (task.org_id!==orgId || task.workflow_id!==workflowId || task.owner_employee_id!==workflow.employee_id) throw Object.assign(new Error('Workflow companion task ownership does not match.'),{code:'workflow_task_link_missing'});
        return task;
      }
      await run(`INSERT INTO crew_tasks(id,org_id,workflow_id,owner_employee_id,capability,goal,state,idempotency_key,correlation_id,spec_version,runtime_version,worker_id,lease_generation,lease_expires_at,created_at,updated_at)
        SELECT w.id,w.org_id,w.id,w.employee_id,'legacy.workflow',w.goal,
          CASE w.status WHEN 'working' THEN 'running' WHEN 'input_required' THEN 'waiting_approval' WHEN 'completed' THEN 'completed' WHEN 'failed' THEN 'failed' WHEN 'cancelled' THEN 'cancelled' WHEN 'reconciliation_required' THEN 'reconciling' ELSE 'queued' END,
          'legacy-workflow:' || w.id,w.id,COALESCE(w.spec_version,1),COALESCE(w.runtime_version,'legacy'),CASE WHEN w.status='working' THEN w.worker_id ELSE NULL END,COALESCE(w.lease_generation,0),CASE WHEN w.status='working' THEN w.lease_expires_at ELSE NULL END,COALESCE(w.created_at,?),COALESCE(w.updated_at,?)
        FROM workflows w JOIN employees e ON e.org_id=w.org_id AND e.id=w.employee_id WHERE w.org_id=? AND w.id=?
        ON CONFLICT(org_id,idempotency_key) DO NOTHING`,at,at,orgId,workflowId);
      task=await get('SELECT * FROM crew_tasks WHERE org_id=? AND workflow_id=?',orgId,workflowId);
      if (!task || task.owner_employee_id!==workflow.employee_id || task.org_id!==orgId) throw Object.assign(new Error('Legacy workflow companion ownership could not be validated.'),{code:'workflow_task_link_missing'});
      return task;
    },
    insertWorkflowTask: (...p) => run(`INSERT INTO crew_tasks(id,org_id,workflow_id,owner_employee_id,capability,goal,state,idempotency_key,correlation_id,spec_version,runtime_version,created_at,updated_at)
      VALUES(?,?,?,?,'legacy.workflow',?,'queued',?,?,?,?,?,?) ON CONFLICT(org_id,idempotency_key) DO NOTHING`,...p),
    bindWorkflowTaskToEvent: (orgId,workflowId,eventInboxId,at) => run("UPDATE crew_tasks SET event_inbox_id=?,queue_owner='legacy_workflow',updated_at=? WHERE org_id=? AND workflow_id=?",eventInboxId,at,orgId,workflowId),
    syncWorkflowTaskState: (orgId,workflowId,state,generation,workerId,leaseExpiresAt,updatedAt) => run(`UPDATE crew_tasks SET state=?,lease_generation=?,worker_id=?,lease_expires_at=?,updated_at=? WHERE org_id=? AND workflow_id=?`,state,generation,workerId,leaseExpiresAt,updatedAt,orgId,workflowId),
    refreshWorkflowTaskLease: (orgId,workflowId,workerId,generation,leaseExpiresAt,updatedAt) => run(`UPDATE crew_tasks SET lease_expires_at=?,updated_at=? WHERE org_id=? AND workflow_id=? AND state='running' AND worker_id=? AND lease_generation=? AND lease_expires_at>?`,leaseExpiresAt,updatedAt,orgId,workflowId,workerId,generation,updatedAt),
    claimWorkflowTask: (orgId,workflowId,workerId,generation,leaseExpiresAt,at) => run(`UPDATE crew_tasks SET state='running',worker_id=?,lease_generation=?,lease_expires_at=?,next_attempt_at=NULL,attempts=attempts+1,updated_at=?
      WHERE org_id=? AND workflow_id=? AND lease_generation<? AND (state='queued' OR (state='retry' AND (next_attempt_at IS NULL OR next_attempt_at<=?)) OR (state='running' AND (lease_expires_at IS NULL OR lease_expires_at<=?)))`,workerId,generation,leaseExpiresAt,at,orgId,workflowId,generation,at,at),
    scheduleWorkflowTaskRetry: (orgId,workflowId,generation,retryAt,updatedAt) => run(`UPDATE crew_tasks SET state='retry',next_attempt_at=?,worker_id=NULL,lease_expires_at=NULL,updated_at=? WHERE org_id=? AND workflow_id=? AND state='running' AND lease_generation=?`,retryAt,updatedAt,orgId,workflowId,generation),
    findExecutionLockByWorkflow: (...p) => get('SELECT * FROM employee_execution_locks WHERE org_id=? AND workflow_id=?',...p),
    acquireEmployeeExecutionLock: (orgId,employeeId,workflowId,taskId,workerId,generation,expiresAt,at) => run(`INSERT INTO employee_execution_locks(org_id,employee_id,workflow_id,task_id,worker_id,lease_generation,lease_expires_at,acquired_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(org_id,employee_id) DO UPDATE SET workflow_id=excluded.workflow_id,task_id=excluded.task_id,worker_id=excluded.worker_id,lease_generation=excluded.lease_generation,lease_expires_at=excluded.lease_expires_at,acquired_at=excluded.acquired_at,updated_at=excluded.updated_at
      WHERE employee_execution_locks.lease_expires_at<=?`,orgId,employeeId,workflowId,taskId,workerId,generation,expiresAt,at,at,at),
    refreshEmployeeExecutionLock: (orgId,employeeId,workflowId,workerId,generation,expiresAt,at) => run(`UPDATE employee_execution_locks SET lease_expires_at=?,updated_at=? WHERE org_id=? AND employee_id=? AND workflow_id=? AND worker_id=? AND lease_generation=? AND lease_expires_at>?`,expiresAt,at,orgId,employeeId,workflowId,workerId,generation,at),
    releaseEmployeeExecutionLock: (orgId,workflowId,workerId,generation) => run('DELETE FROM employee_execution_locks WHERE org_id=? AND workflow_id=? AND worker_id=? AND lease_generation=?',orgId,workflowId,workerId,generation),
    findWorkflowExecutionGeneration: (...p) => get('SELECT employee_id,lease_generation,status,worker_id,lease_expires_at,created_by,created_by_principal_id,origin_subscription_id FROM workflows WHERE org_id=? AND id=?',...p),
    findActiveEmployeeExecutionLock: (orgId,employeeId,at) => get('SELECT workflow_id,worker_id,lease_generation FROM employee_execution_locks WHERE org_id=? AND employee_id=? AND lease_expires_at>?',orgId,employeeId,at),
    setEmployeeTeams: (orgId,employeeId) => all('SELECT team_id FROM employee_team_memberships WHERE org_id=? AND employee_id=?',orgId,employeeId),
    verifyEmployeeTeamMemberships: (orgId,employeeId,teamIds) => teamIds.length ? all(`SELECT team_id FROM employee_team_memberships WHERE org_id=? AND employee_id=? AND team_id IN (${teamIds.map(()=>'?').join(',')})`,orgId,employeeId,...teamIds) : Promise.resolve([]),
    findTeamsByOrgAndIds: (orgId,teamIds) => teamIds.length ? all(`SELECT id FROM organization_teams WHERE org_id=? AND id IN (${teamIds.map(()=>'?').join(',')})`,orgId,...teamIds) : Promise.resolve([]),
    findActiveSubscriptionForDispatch: (...p) => get(`SELECT s.*,p.kind AS principal_kind,p.status AS principal_status,pc.provider,pc.provider_account_id,pc.environment,pc.status AS connection_status,pc.granted_scopes,pc.config AS connection_config,pc.credential_expires_at,pc.revoked_at,e.state AS employee_state,e.profile_id,es.version AS spec_version,es.data AS spec_data,d.id AS deployment_id,ptr.readiness_state,ptr.probation_state,ptr.handler_id,ptr.verifier_id,ptr.policy_revision AS readiness_policy_revision
      FROM event_subscriptions s JOIN service_principals p ON p.org_id=s.org_id AND p.id=s.principal_id
      JOIN provider_connections pc ON pc.org_id=s.org_id AND pc.id=s.connection_id
      JOIN employees e ON e.org_id=s.org_id AND e.id=s.employee_id
      LEFT JOIN employee_specs es ON es.employee_id=e.id AND es.version=(SELECT MAX(es2.version) FROM employee_specs es2 WHERE es2.employee_id=e.id)
      LEFT JOIN employee_deployments d ON d.org_id=e.org_id AND d.employee_id=e.id AND d.spec_version=es.version
      LEFT JOIN provider_tool_readiness ptr ON ptr.org_id=s.org_id AND ptr.tool=s.required_capability AND ptr.connection_id=s.connection_id
      WHERE s.org_id=? AND s.id=? AND s.enabled=1`,...p),
    findSubscriptionsForInbox: (...p) => all(`SELECT s.id,s.org_id,s.principal_id,s.authorized_by FROM event_subscriptions s JOIN event_inbox i ON i.org_id=s.org_id AND i.connection_id=s.connection_id AND i.event_type=s.event_type WHERE i.org_id=? AND i.id=? ORDER BY s.id`,...p),
    findDispatchInputs: (...p) => get(`SELECT r.*,i.provider,i.event_type,i.external_event_id,i.environment AS inbox_environment,i.simulated,i.normalized,i.connection_id,s.enabled,s.employee_id,s.required_capability,s.required_scopes,s.capability_grant_hash,s.principal_id,s.authorized_by,p.kind AS principal_kind,p.status AS principal_status,pc.environment AS connection_environment,pc.status AS connection_status,pc.granted_scopes,pc.credential_expires_at,pc.revoked_at,pc.credential_version,e.state AS employee_state,es.version AS spec_version,es.data AS spec_data,d.id AS deployment_id
      FROM event_dispatch_records r JOIN event_inbox i ON i.org_id=r.org_id AND i.id=r.inbox_id JOIN event_subscriptions s ON s.org_id=r.org_id AND s.id=r.subscription_id
      JOIN service_principals p ON p.org_id=s.org_id AND p.id=s.principal_id JOIN provider_connections pc ON pc.org_id=s.org_id AND pc.id=s.connection_id JOIN employees e ON e.org_id=s.org_id AND e.id=s.employee_id
      LEFT JOIN employee_specs es ON es.employee_id=e.id AND es.version=(SELECT MAX(x.version) FROM employee_specs x WHERE x.employee_id=e.id)
      LEFT JOIN employee_deployments d ON d.org_id=e.org_id AND d.employee_id=e.id AND d.spec_version=es.version WHERE r.org_id=? AND r.id=?`,...p),
    findMembershipRole: (...p) => get('SELECT role FROM memberships WHERE org_id=? AND user_id=?',...p),
    findOrganizationFlagAllowlist: (...p) => get('SELECT 1 AS allowed FROM feature_flag_org_allowlist WHERE flag=? AND org_id=?',...p),
    insertEventDispatchRecord: (...p) => run(`INSERT INTO event_dispatch_records(id,org_id,inbox_id,subscription_id,service_principal_id,manager_grant_user_id,state,worker_owner,blocked_reason,outcome_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'pending','event_dispatcher',?,?,?,?) ON CONFLICT(org_id,inbox_id,subscription_id) DO NOTHING`,...p),
    findDispatchByEventSubscription: (...p) => get('SELECT * FROM event_dispatch_records WHERE org_id=? AND inbox_id=? AND subscription_id=?',...p),
    findDispatchById: (...p) => get('SELECT * FROM event_dispatch_records WHERE org_id=? AND id=?',...p),
    claimEventDispatch: (orgId,id,owner,leaseUntil,at) => run(`UPDATE event_dispatch_records SET state='checking',worker_owner=?,lease_generation=lease_generation+1,lease_expires_at=?,attempts=attempts+1,updated_at=?
      WHERE org_id=? AND id=? AND ((state IN ('pending','retry') AND (next_attempt_at IS NULL OR next_attempt_at<=?)) OR (state IN ('checking','running') AND lease_expires_at<=?))`,owner,leaseUntil,at,orgId,id,at,at),
    finishEventDispatch: (orgId,id,owner,generation,state,reason,outcome,at) => run(`UPDATE event_dispatch_records SET state=?,blocked_reason=?,outcome_json=?,lease_expires_at=NULL,updated_at=? WHERE org_id=? AND id=? AND worker_owner=? AND state='checking' AND lease_generation=? AND lease_expires_at>?`,state,reason,JSON.stringify(outcome),at,orgId,id,owner,generation,at),
    retryEventDispatch: (orgId,id,owner,generation,nextAt,reason,at,state='retry') => run(`UPDATE event_dispatch_records SET state=?,next_attempt_at=?,blocked_reason=?,lease_expires_at=NULL,updated_at=? WHERE org_id=? AND id=? AND worker_owner=? AND state IN ('checking','running') AND lease_generation=?`,state,nextAt,reason,at,orgId,id,owner,generation),
    findReadyEventDispatches: (at,limit=10) => all(`SELECT org_id,id FROM event_dispatch_records WHERE
      (state IN ('pending','retry') AND (next_attempt_at IS NULL OR next_attempt_at<=?))
      OR (state IN ('checking','running') AND lease_expires_at<=?) ORDER BY created_at LIMIT ?`,at,at,Math.max(1,Math.min(50,Number(limit)||10))),
    findProviderConnectionForDispatch: (...p) => get('SELECT * FROM provider_connections WHERE org_id=? AND id=?',...p),
    findSubscriptionByIdAndOrg: (...p) => get('SELECT * FROM event_subscriptions WHERE org_id=? AND id=?',...p),
    findEmployeeDeploymentForDispatch: (...p) => get("SELECT e.id,e.org_id,e.state,e.profile_id,es.version,es.data AS spec_data,d.id AS deployment_id FROM employees e JOIN employee_specs es ON es.employee_id=e.id AND es.version=(SELECT MAX(v.version) FROM employee_specs v WHERE v.employee_id=e.id) LEFT JOIN employee_deployments d ON d.org_id=e.org_id AND d.employee_id=e.id AND d.spec_version=es.version WHERE e.org_id=? AND e.id=?",...p),
    findCoworkerByEmployee: (...p) => get('SELECT id,org_id,employee_id,name,role,expertise,summary FROM coworkers WHERE org_id=? AND employee_id=? ORDER BY updated_at DESC LIMIT 1',...p),
    findEventDelegationSubscription: (orgId,subscriptionId) => get(`SELECT s.id,s.org_id,s.principal_id,s.employee_id,s.connection_id,s.event_type,s.required_capability,s.authorized_by,s.enabled,
        p.kind AS principal_kind,p.status AS principal_status,pc.environment,pc.provider,pc.status AS connection_status,pc.config AS connection_config,e.state AS employee_state,es.version AS spec_version,es.data AS spec_data,d.id AS deployment_id
      FROM event_subscriptions s JOIN provider_connections pc ON pc.org_id=s.org_id AND pc.id=s.connection_id
      JOIN service_principals p ON p.org_id=s.org_id AND p.id=s.principal_id
      JOIN employees e ON e.org_id=s.org_id AND e.id=s.employee_id
      LEFT JOIN employee_specs es ON es.employee_id=e.id AND es.version=(SELECT MAX(x.version) FROM employee_specs x WHERE x.employee_id=e.id)
      LEFT JOIN employee_deployments d ON d.org_id=e.org_id AND d.employee_id=e.id AND d.spec_version=es.version
      WHERE s.org_id=? AND s.id=?`,orgId,subscriptionId),
    findActiveOnboardingSession: (...p) => get("SELECT * FROM onboarding_sessions WHERE org_id=? AND state IN ('collecting','validating','blueprint_review','provisioning') ORDER BY created_at DESC LIMIT 1", ...p),
    findOnboardingSession: (...p) => get('SELECT * FROM onboarding_sessions WHERE org_id=? AND id=?', ...p),
    insertOnboardingSession: (...p) => run("INSERT INTO onboarding_sessions(id,org_id,graph_thread_id,state,current_profile_version,state_json,created_at,updated_at) VALUES(?,?,?,'collecting',0,'{}',?,?)", ...p),
    findOrganizationProfile: (...p) => get('SELECT * FROM organization_profiles WHERE org_id=? ORDER BY version DESC LIMIT 1', ...p),
    findOnboardingTurn: (...p) => get('SELECT * FROM onboarding_turns WHERE org_id=? AND session_id=? AND client_turn_id=?', ...p),
    insertOnboardingTurn: (...p) => run('INSERT INTO onboarding_turns(id,org_id,session_id,client_turn_id,request_hash,response_json,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(org_id,session_id,client_turn_id) DO NOTHING', ...p),
    insertOrganizationProfile: (...p) => run('INSERT INTO organization_profiles(org_id,version,profile_json,created_at) VALUES(?,?,?,?) ON CONFLICT(org_id,version) DO NOTHING', ...p),
    insertProfileClaim: (...p) => run('INSERT INTO profile_claims(id,org_id,session_id,field_path,value_json,source_turn_id,confirmed,provenance_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)', ...p),
    findOwnedDocuments: (orgId, ids) => ids.length ? all(`SELECT id FROM documents WHERE org_id=? AND id IN (${ids.map(()=>'?').join(',')})`,orgId,...ids) : Promise.resolve([]),
    advanceOnboardingProfileVersion: (...p) => run('UPDATE onboarding_sessions SET current_profile_version=?,state_json=?,updated_at=? WHERE org_id=? AND id=? AND current_profile_version=?', ...p),
    findBlueprint: (...p) => get('SELECT * FROM organization_blueprints WHERE org_id=? ORDER BY version DESC LIMIT 1', ...p),
    insertBlueprint: (...p) => run("INSERT INTO organization_blueprints(org_id,version,profile_version,blueprint_json,status,created_at) VALUES(?,?,?,?,'proposed',?) ON CONFLICT(org_id,version) DO NOTHING", ...p),
    reviewBlueprint: (orgId,version,status,managerId,at,blueprintJson=null) => run("UPDATE organization_blueprints SET status=?,reviewed_by=?,reviewed_at=?,blueprint_json=COALESCE(?,blueprint_json) WHERE org_id=? AND version=? AND status='proposed'",status,managerId,at,blueprintJson,orgId,version),
    findConnectionById: (...p) => get('SELECT id,org_id,provider,provider_account_id,environment,status,granted_scopes,config FROM provider_connections WHERE id=?', ...p),
    findSimulationShopifyConnection: (...p) => get("SELECT id,org_id,provider,provider_account_id,environment,status,granted_scopes,config FROM provider_connections WHERE org_id=? AND provider='shopify' AND provider_account_id=? AND environment='simulation'",...p),
    findSimulationShopifyConnections: (...p) => all("SELECT id,org_id,provider,provider_account_id,environment,status,granted_scopes,config FROM provider_connections WHERE org_id=? AND provider='shopify' AND environment='simulation' ORDER BY provider_account_id",...p),
    insertSimulationShopifyConnection: (...p) => run("INSERT INTO provider_connections(id,org_id,provider,provider_account_id,environment,status,granted_scopes,config,created_at,updated_at) VALUES(?,?,'shopify',?,'simulation','connected',?,?,?,?) ON CONFLICT(org_id,provider,provider_account_id,environment) DO NOTHING",...p),
    insertShopifyConnection: (...p) => run("INSERT INTO provider_connections(id,org_id,provider,provider_account_id,environment,status,granted_scopes,config,created_at,updated_at) VALUES(?,?,'shopify',?,?,'setup_required',?,?,?,?) ON CONFLICT(org_id,provider,provider_account_id,environment) DO NOTHING",...p),
    findShopifyConnectionByAccount: (orgId,domain,environment,at) => get(`SELECT id,org_id,provider,provider_account_id,environment,status,granted_scopes,config,credential_expires_at,
      CASE WHEN credential_ciphertext IS NOT NULL AND revoked_at IS NULL AND (credential_expires_at IS NULL OR credential_expires_at>?) THEN 1 ELSE 0 END AS credential_ready
      FROM provider_connections WHERE org_id=? AND provider='shopify' AND provider_account_id=? AND environment=?`,at,orgId,domain,environment),
    findShopifyConnectionByOrgAndId: (orgId,connectionId,at) => get(`SELECT id,org_id,provider,provider_account_id,environment,status,granted_scopes,config,credential_expires_at,
      CASE WHEN credential_ciphertext IS NOT NULL AND revoked_at IS NULL AND (credential_expires_at IS NULL OR credential_expires_at>?) THEN 1 ELSE 0 END AS credential_ready
      FROM provider_connections WHERE org_id=? AND id=? AND provider='shopify'`,at,orgId,connectionId),
    listShopifyConnections: (orgId,at) => all(`SELECT id,org_id,provider,provider_account_id,environment,status,granted_scopes,config,credential_expires_at,
      CASE WHEN credential_ciphertext IS NOT NULL AND revoked_at IS NULL AND (credential_expires_at IS NULL OR credential_expires_at>?) THEN 1 ELSE 0 END AS credential_ready
      FROM provider_connections WHERE org_id=? AND provider='shopify' ORDER BY environment,provider_account_id`,at,orgId),
    findActiveShopifyOAuthIntent: (...p) => get("SELECT id,status,expires_at FROM shopify_oauth_intents WHERE org_id=? AND connection_id=? AND status IN ('pending','processing') AND expires_at>? ORDER BY created_at DESC LIMIT 1",...p),
    insertShopifyOAuthIntent: async (id,orgId,connectionId,managerId,domain,environment,stateHash,scopes,expiresAt,createdAt,updatedAt) => {
      await run("UPDATE shopify_oauth_intents SET status='expired',updated_at=? WHERE org_id=? AND connection_id=? AND status='pending' AND expires_at<=?",updatedAt,orgId,connectionId,updatedAt);
      await run("UPDATE shopify_oauth_intents SET status='superseded',updated_at=? WHERE org_id=? AND connection_id=? AND status='pending' AND expires_at>?",updatedAt,orgId,connectionId,updatedAt);
      return run("INSERT INTO shopify_oauth_intents(id,org_id,connection_id,manager_user_id,store_domain,environment,state_hash,requested_scopes,status,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?, 'pending',?,?,?) ON CONFLICT(state_hash) DO NOTHING",id,orgId,connectionId,managerId,domain,environment,stateHash,scopes,expiresAt,createdAt,updatedAt);
    },
    findShopifyOAuthIntent: (stateHash,at) => get('SELECT * FROM shopify_oauth_intents WHERE state_hash=? AND expires_at>?',stateHash,at),
    claimShopifyOAuthIntent: (stateHash,orgId,managerId,domain,at) => run("UPDATE shopify_oauth_intents SET status='processing',consumed_at=?,updated_at=? WHERE state_hash=? AND org_id=? AND manager_user_id=? AND store_domain=? AND status='pending' AND expires_at>?",at,at,stateHash,orgId,managerId,domain,at),
    finishShopifyOAuthIntent: (stateHash,status,at) => run("UPDATE shopify_oauth_intents SET status=?,consumed_at=COALESCE(consumed_at,?),updated_at=? WHERE state_hash=? AND status='processing'",status,at,at,stateHash),
    completeShopifyConnection: (orgId,connectionId,scopes,config,at) => run("UPDATE provider_connections SET status='connected',granted_scopes=?,config=?,updated_at=? WHERE org_id=? AND id=? AND provider='shopify' AND environment IN ('staging','production')",scopes,config,at,orgId,connectionId),
    disconnectShopifyConnection: (orgId,connectionId,config,at) => run("UPDATE provider_connections SET status='revoked',granted_scopes='[]',config=?,updated_at=? WHERE org_id=? AND id=? AND provider='shopify'",config,at,orgId,connectionId),
    upsertCommerceCatalogProjection: (...p) => run(`INSERT INTO commerce_catalog_projection(id,org_id,connection_id,environment,remote_product_id,product_json,verified_at,simulated) VALUES(?,?,?,?,?,?,?,1)
      ON CONFLICT(connection_id,remote_product_id) DO UPDATE SET product_json=excluded.product_json,verified_at=excluded.verified_at WHERE commerce_catalog_projection.org_id=excluded.org_id AND commerce_catalog_projection.environment=excluded.environment`,...p),
    findCommerceCatalogByConnection: (...p) => all('SELECT * FROM commerce_catalog_projection WHERE org_id=? AND connection_id=? ORDER BY remote_product_id LIMIT 500',...p),
    findCommerceSimulationOperation: (...p) => get('SELECT * FROM commerce_simulation_operations WHERE org_id=? AND connection_id=? AND idempotency_key=?',...p),
    insertCommerceSimulationOperation: (...p) => run('INSERT INTO commerce_simulation_operations(id,org_id,connection_id,idempotency_key,input_hash,result_json,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(org_id,connection_id,idempotency_key) DO NOTHING',...p),
    findOrInsertEventServicePrincipal: async (id,orgId,name,at) => {await run("INSERT INTO service_principals(id,org_id,kind,name,status,created_at) VALUES(?,?,'org_service',?,'active',?) ON CONFLICT(org_id,kind,name) DO NOTHING",id,orgId,name,at);return get("SELECT * FROM service_principals WHERE org_id=? AND kind='org_service' AND name=? ORDER BY id LIMIT 1",orgId,name);},
    findEventSubscription: (...p) => get('SELECT * FROM event_subscriptions WHERE org_id=? AND connection_id=? AND employee_id=? AND event_type=?',...p),
    listEventSubscriptions: (...p) => all(`SELECT s.id,s.org_id,s.principal_id,s.employee_id,s.connection_id,s.event_type,s.required_capability,s.authorized_by,s.enabled,s.created_at,
      pc.provider,pc.provider_account_id,pc.environment,pc.status AS connection_status,e.name AS employee_name,e.title AS employee_title
      FROM event_subscriptions s JOIN provider_connections pc ON pc.org_id=s.org_id AND pc.id=s.connection_id
      JOIN employees e ON e.org_id=s.org_id AND e.id=s.employee_id WHERE s.org_id=? ORDER BY s.created_at DESC`,...p),
    insertEventSubscription: (...p) => run('INSERT INTO event_subscriptions(id,org_id,principal_id,employee_id,connection_id,event_type,filter_json,required_capability,authorized_by,enabled,required_scopes,capability_grant_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,\'{}\',?,?,1,?,?,?,?) ON CONFLICT(org_id,connection_id,employee_id,event_type) DO NOTHING',...p),
    disableEventSubscription: (...p) => run('UPDATE event_subscriptions SET enabled=0,updated_at=? WHERE org_id=? AND id=?',...p),
    findReadinessForEventCapability: (...p) => get('SELECT * FROM provider_tool_readiness WHERE org_id=? AND tool=? AND connection_id=?',...p),
    upsertProviderToolReadiness: (...p) => run(`INSERT INTO provider_tool_readiness(org_id,tool,connection_id,capability,required_scopes,handler_id,verifier_id,readiness_state,probation_state,updated_at,policy_revision) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(org_id,tool,connection_id) DO UPDATE SET capability=excluded.capability,required_scopes=excluded.required_scopes,handler_id=excluded.handler_id,verifier_id=excluded.verifier_id,readiness_state=excluded.readiness_state,probation_state=excluded.probation_state,updated_at=excluded.updated_at,policy_revision=excluded.policy_revision`,...p),
    setProviderToolReadinessUnavailable: (...p) => run("UPDATE provider_tool_readiness SET readiness_state='setup_required',probation_state='not_run',updated_at=? WHERE org_id=? AND tool=? AND connection_id=?",...p),
    findEventSupportCandidates: (...p) => all(`SELECT e.id,e.name,e.title,e.state,es.data AS spec_data,es.version AS spec_version,d.id AS deployment_id
      FROM employees e JOIN employee_specs es ON es.employee_id=e.id AND es.version=(SELECT MAX(x.version) FROM employee_specs x WHERE x.employee_id=e.id)
      JOIN employee_deployments d ON d.org_id=e.org_id AND d.employee_id=e.id AND d.spec_version=es.version WHERE e.org_id=? AND e.state='active' ORDER BY e.id`,...p),
    findDispatchByTask: (...p) => get('SELECT * FROM event_dispatch_records WHERE org_id=? AND task_id=?',...p),
    linkEventDispatchTask: (orgId,id,taskId,owner,generation,leaseExpiresAt,at) => run("UPDATE event_dispatch_records SET task_id=?,updated_at=? WHERE org_id=? AND id=? AND worker_owner=? AND state='checking' AND lease_generation=? AND lease_expires_at=? AND lease_expires_at>?",taskId,at,orgId,id,owner,generation,leaseExpiresAt,at),
    markEventDispatchCompleted: (...p) => run("UPDATE event_dispatch_records SET state='completed',blocked_reason=NULL,outcome_json=?,updated_at=? WHERE org_id=? AND id=? AND state='enqueued' AND task_id=?",...p),
    findConnectionSecret: (...p) => get('SELECT id,org_id,provider,provider_account_id,environment,status,credential_ciphertext,credential_key_id,credential_version,credential_expires_at,revoked_at FROM provider_connections WHERE org_id=? AND id=?', ...p),
    saveConnectionSecret: (...p) => run(`UPDATE provider_connections SET credential_ciphertext=?,credential_key_id=?,credential_version=credential_version+1,credential_expires_at=?,revoked_at=NULL,status='connected',updated_at=? WHERE org_id=? AND id=? AND provider_account_id=? AND environment=?`,...p),
    revokeConnectionSecret: (...p) => run(`UPDATE provider_connections SET credential_ciphertext=NULL,revoked_at=?,status='revoked',updated_at=? WHERE org_id=? AND id=?`,...p),
    findInboxEvent: (...p) => get('SELECT id FROM event_inbox WHERE org_id=? AND connection_id=? AND external_event_id=?', ...p),
    findCanonicalOrder: (...p) => get('SELECT * FROM canonical_orders WHERE org_id=? AND connection_id=? AND remote_order_id=?',...p),
    findCanonicalOrderById: (...p) => get('SELECT * FROM canonical_orders WHERE org_id=? AND id=?',...p),
    upsertCanonicalOrder: (...p) => run(`INSERT INTO canonical_orders(id,org_id,connection_id,environment,remote_order_id,currency,total_minor,payment_state,order_state,occurred_at,updated_at,simulated,last_event_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id,remote_order_id) DO UPDATE SET currency=excluded.currency,total_minor=excluded.total_minor,payment_state=excluded.payment_state,order_state=excluded.order_state,occurred_at=excluded.occurred_at,updated_at=excluded.updated_at,simulated=excluded.simulated,last_event_id=excluded.last_event_id
      WHERE canonical_orders.org_id=excluded.org_id AND canonical_orders.environment=excluded.environment AND canonical_orders.occurred_at<=excluded.occurred_at`,...p),
    insertOrderEventReceipt: (...p) => run('INSERT INTO order_event_receipts(connection_id,external_event_id,order_id,event_type,created_at) VALUES(?,?,?,?,?) ON CONFLICT(connection_id,external_event_id) DO NOTHING',...p),
    findCanonicalOrdersByConnection: (...p) => all('SELECT * FROM canonical_orders WHERE org_id=? AND connection_id=? ORDER BY updated_at DESC LIMIT 200',...p),
    findLatestStorefrontRevision: (...p) => get('SELECT * FROM storefront_revisions WHERE org_id=? AND connection_id=? ORDER BY revision DESC LIMIT 1',...p),
    insertStorefrontRevision: (...p) => run('INSERT INTO storefront_revisions(id,org_id,connection_id,template_id,revision,artifact_hash,files_json,local_check_json,status,simulated,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,\'local_preview\',1,?,?) ON CONFLICT(org_id,connection_id,revision) DO NOTHING',...p),
    findStorefrontRevision: (...p) => get('SELECT * FROM storefront_revisions WHERE org_id=? AND connection_id=? AND id=?',...p),
    findStorefrontRevisions: (...p) => all('SELECT id,org_id,connection_id,template_id,revision,artifact_hash,local_check_json,status,simulated,created_by,created_at FROM storefront_revisions WHERE org_id=? AND connection_id=? ORDER BY revision DESC LIMIT 50',...p),
    findActionBindings: (orgId, workflowId, toolRunId, connectionId) => get(
      `SELECT w.id AS workflow_id,w.org_id,w.employee_id,w.status AS workflow_state,
        tr.id AS tool_run_id,tr.tool,tr.input,tr.status AS tool_state,
        pc.id AS connection_id,pc.provider,pc.provider_account_id,pc.environment,pc.status AS connection_state
       FROM workflows w JOIN tool_runs tr ON tr.workflow_id=w.id AND tr.org_id=w.org_id
       JOIN provider_connections pc ON pc.org_id=w.org_id
       WHERE w.org_id=? AND w.id=? AND tr.id=? AND pc.id=?`, orgId, workflowId, toolRunId, connectionId,
    ),
    findOperationByIdempotency: (...p) => get('SELECT * FROM external_operations WHERE org_id=? AND connection_id=? AND environment=? AND idempotency_key=?', ...p),
    updateExternalOperationState: (orgId,id,expectedState,nextState,at) => run('UPDATE external_operations SET state=?,updated_at=? WHERE org_id=? AND id=? AND state=?',nextState,at,orgId,id,expectedState),
    insertOperationArtifact: (...p) => run('INSERT INTO operation_artifacts(id,org_id,operation_id,artifact_type,revision_hash,path,metadata,created_at) VALUES(?,?,?,?,?,?,?,?)',...p),
    findOperationArtifacts: (...p) => all('SELECT * FROM operation_artifacts WHERE org_id=? AND operation_id=? ORDER BY created_at,id',...p),
    findOperationApprovalBinding: (...p) => get(`SELECT op.*,pc.status AS connection_status,pc.credential_version,pc.credential_expires_at,pc.revoked_at,t.state AS task_state,a.revision_hash AS artifact_hash
      FROM external_operations op JOIN provider_connections pc ON pc.org_id=op.org_id AND pc.id=op.connection_id LEFT JOIN crew_tasks t ON t.org_id=op.org_id AND t.id=op.task_id
      LEFT JOIN operation_artifacts a ON a.org_id=op.org_id AND a.operation_id=op.id WHERE op.org_id=? AND op.id=? ORDER BY a.created_at DESC LIMIT 1`,...p),
    insertOperationApproval: (...p) => run(`INSERT INTO operation_approvals(id,org_id,operation_id,connection_id,environment,task_id,action,policy_revision,nonce,signer_user_id,artifact_hash,state,expires_at,created_at,input_hash,credential_version)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?) ON CONFLICT(nonce) DO NOTHING`,...p),
    findOperationApproval: (...p) => get('SELECT * FROM operation_approvals WHERE org_id=? AND id=?',...p),
    findOperationApprovalByNonce: (...p) => get('SELECT * FROM operation_approvals WHERE org_id=? AND nonce=?',...p),
    approveOperationApproval: (...p) => run(`UPDATE operation_approvals SET state='approved',approved_by_user_id=?,approved_at=? WHERE org_id=? AND id=? AND signer_user_id=? AND state='pending' AND expires_at>?`,...p),
    consumeOperationApproval: (...p) => run(`UPDATE operation_approvals SET state='consumed',consumed_at=? WHERE org_id=? AND id=? AND state='approved' AND expires_at>? AND operation_id=? AND connection_id=? AND environment=? AND task_id=? AND action=? AND input_hash=? AND artifact_hash=? AND policy_revision=? AND nonce=? AND credential_version=?`,...p),
    findOperationApprovalState: (...p) => get(`SELECT a.*,op.state AS operation_state,op.policy_revision AS current_policy_revision,op.input_hash AS current_input_hash,op.action AS current_action,op.task_id AS current_task_id,op.connection_id AS current_connection_id,op.environment AS current_environment,pc.status AS connection_status,pc.credential_version AS current_credential_version,pc.credential_expires_at,pc.revoked_at,t.state AS task_state,art.revision_hash AS current_artifact_hash
      FROM operation_approvals a JOIN external_operations op ON op.org_id=a.org_id AND op.id=a.operation_id JOIN provider_connections pc ON pc.org_id=a.org_id AND pc.id=a.connection_id
      LEFT JOIN crew_tasks t ON t.org_id=a.org_id AND t.id=op.task_id LEFT JOIN operation_artifacts art ON art.org_id=op.org_id AND art.operation_id=op.id
      WHERE a.org_id=? AND a.id=? ORDER BY art.created_at DESC LIMIT 1`,...p),
    insertExternalOperation: (...p) => run(
      `INSERT INTO external_operations(id,org_id,workflow_id,tool_run_id,connection_id,environment,task_id,action,input_hash,idempotency_key,policy_revision,state,created_at,updated_at)
       SELECT ?,?,?,?,?,?,?,?,?,?,?, 'pending',?,? WHERE EXISTS (
         SELECT 1 FROM tool_runs tr JOIN workflows w ON w.id=tr.workflow_id AND w.org_id=tr.org_id
         JOIN provider_connections pc ON pc.org_id=w.org_id
         WHERE tr.org_id=? AND tr.id=? AND w.id=? AND pc.id=?
       ) ON CONFLICT(org_id,connection_id,environment,idempotency_key) DO NOTHING`, ...p,
    ),
    findTaskByOrgAndId: (...p) => get('SELECT * FROM crew_tasks WHERE org_id=? AND id=?', ...p),
    findTasksByOrgAndIds: (orgId, ids) => ids.length ? all(`SELECT id,org_id FROM crew_tasks WHERE org_id=? AND id IN (${ids.map(()=>'?').join(',')})`,orgId,...ids) : Promise.resolve([]),
    insertTaskIfAbsent: (...p) => run(`INSERT INTO crew_tasks(id,org_id,workflow_id,parent_task_id,owner_employee_id,capability,goal,input_refs,success_criteria,state,priority,idempotency_key,correlation_id,spec_version,runtime_version,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(org_id,idempotency_key) DO NOTHING`, ...p),
    findTaskByIdempotency: (...p) => get('SELECT * FROM crew_tasks WHERE org_id=? AND idempotency_key=?', ...p),
    findTaskGraphStats: (orgId, rootId) => get(`WITH RECURSIVE tree(id,parent_task_id,depth) AS (
      SELECT id,parent_task_id,0 FROM crew_tasks WHERE org_id=? AND id=?
      UNION ALL SELECT child.id,child.parent_task_id,tree.depth+1 FROM crew_tasks child JOIN tree ON child.parent_task_id=tree.id WHERE child.org_id=? AND tree.depth<32
    ) SELECT COUNT(*) AS width,MAX(depth) AS depth FROM tree`,orgId,rootId,orgId),
    findExpiredStandaloneTasks: (orgId,at,limit=100) => all(`SELECT t.id,t.state,t.lease_generation FROM crew_tasks t WHERE t.org_id=? AND t.workflow_id IS NULL AND t.deadline_at IS NOT NULL AND t.deadline_at<=? AND t.state IN ('queued','planning','retry','waiting_dependency','waiting_approval','waiting_external','reconciling') ORDER BY t.deadline_at LIMIT ?`,orgId,at,limit),
    findFailedDependencyChildren: (orgId,limit=100) => all(`SELECT DISTINCT child.id,child.state,child.lease_generation FROM task_dependencies dep JOIN crew_tasks parent ON parent.org_id=dep.org_id AND parent.id=dep.parent_task_id JOIN crew_tasks child ON child.org_id=dep.org_id AND child.id=dep.child_task_id WHERE dep.org_id=? AND child.workflow_id IS NULL AND child.state='waiting_dependency' AND parent.state IN ('failed','cancelled') ORDER BY child.id LIMIT ?`,orgId,limit),
    findSatisfiedDependencyChildren: (orgId,limit=100) => all(`SELECT child.id,child.state,child.lease_generation FROM crew_tasks child WHERE child.org_id=? AND child.workflow_id IS NULL AND child.state='waiting_dependency' AND EXISTS(SELECT 1 FROM task_dependencies dep WHERE dep.org_id=child.org_id AND dep.child_task_id=child.id) AND NOT EXISTS(SELECT 1 FROM task_dependencies dep JOIN crew_tasks parent ON parent.org_id=dep.org_id AND parent.id=dep.parent_task_id WHERE dep.org_id=child.org_id AND dep.child_task_id=child.id AND parent.state<>dep.required_outcome) ORDER BY child.created_at LIMIT ?`,orgId,limit),
    findTaskRoot: (orgId, taskId) => get(`WITH RECURSIVE ancestors(id,parent_task_id,depth) AS (
      SELECT id,parent_task_id,0 FROM crew_tasks WHERE org_id=? AND id=?
      UNION ALL SELECT parent.id,parent.parent_task_id,ancestors.depth+1 FROM crew_tasks parent JOIN ancestors ON ancestors.parent_task_id=parent.id WHERE parent.org_id=? AND ancestors.depth<32
    ) SELECT id,parent_task_id,MAX(depth) AS depth FROM ancestors WHERE parent_task_id IS NULL`,orgId,taskId,orgId),
    isDependencyReachable: (orgId, startId, targetId) => get(`WITH RECURSIVE reachable(id) AS (
      SELECT child_task_id FROM task_dependencies WHERE org_id=? AND parent_task_id=?
      UNION SELECT dep.child_task_id FROM task_dependencies dep JOIN reachable r ON dep.parent_task_id=r.id WHERE dep.org_id=?
    ) SELECT 1 AS found FROM reachable WHERE id=? LIMIT 1`,orgId,startId,orgId,targetId),
    insertTaskDependency: (...p) => run('INSERT INTO task_dependencies(org_id,parent_task_id,child_task_id,required_outcome,created_at) VALUES(?,?,?,?,?) ON CONFLICT(org_id,parent_task_id,child_task_id) DO NOTHING',...p),
    transitionTaskFenced: (orgId, taskId, expectedState, nextState, expectedGeneration, updates, timestamp) => {
      const allowed = new Set(['attempts','next_attempt_at','deadline_at','result_json','last_error','workflow_id','worker_id','lease_expires_at']);
      const entries = Object.entries(updates).filter(([key]) => allowed.has(key));
      const fields = ['state=?','lease_generation=lease_generation+1','updated_at=?', ...entries.map(([key]) => `${key}=?`)];
      return run(`UPDATE crew_tasks SET ${fields.join(',')} WHERE org_id=? AND id=? AND state=? AND lease_generation=?`, nextState,timestamp,...entries.map(([,value])=>value),orgId,taskId,expectedState,expectedGeneration);
    },
    createInboxEvent: (...p) => run(`INSERT INTO event_inbox(id,org_id,provider,connection_id,external_event_id,event_type,environment,simulated,occurred_at,received_at,normalized,correlation_id,state)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'received' WHERE EXISTS(SELECT 1 FROM provider_connections WHERE org_id=? AND id=? AND status='connected' AND environment=?)
      ON CONFLICT(connection_id,external_event_id) DO NOTHING`, ...p),
    enqueueOutbox: (...p) => run('INSERT INTO outbox_messages(id,org_id,type,payload,dedup_key,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(org_id,dedup_key) DO NOTHING',...p),
    claimOutbox: (id, leaseUntil, updatedAt) => run(`UPDATE outbox_messages SET state='leased',lease_generation=lease_generation+1,lease_expires_at=? WHERE id=? AND ((state='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?)) OR (state='leased' AND lease_expires_at<=?))`,leaseUntil,id,updatedAt,updatedAt),
    findOutboxById: (...p) => get('SELECT * FROM outbox_messages WHERE id=?',...p),
    findOutboxByOrgAndDedupKey: (...p) => get('SELECT * FROM outbox_messages WHERE org_id=? AND dedup_key=?',...p),
    finishOutboxLease: (id,generation,deliveredAt) => run("UPDATE outbox_messages SET state='delivered',delivered_at=?,lease_expires_at=NULL WHERE id=? AND state='leased' AND lease_generation=?",deliveredAt,id,generation),
    retryOutboxLease: (id,generation,nextAttemptAt,error,state) => run("UPDATE outbox_messages SET state=?,attempts=attempts+1,next_attempt_at=?,lease_expires_at=NULL,last_error=? WHERE id=? AND state='leased' AND lease_generation=?",state,nextAttemptAt,String(error).slice(0,1000),id,generation),
    claimInbox: (orgId,id,leaseUntil,at) => run("UPDATE event_inbox SET state='leased',lease_generation=lease_generation+1,lease_expires_at=?,attempts=attempts+1 WHERE org_id=? AND id=? AND ((state IN ('received','retry') AND (next_attempt_at IS NULL OR next_attempt_at<=?)) OR (state='leased' AND lease_expires_at<=?))",leaseUntil,orgId,id,at,at),
    findInboxById: (...p) => get('SELECT * FROM event_inbox WHERE org_id=? AND id=?',...p),
    updateInboxNormalized: (orgId,id,normalized) => run('UPDATE event_inbox SET normalized=? WHERE org_id=? AND id=?',normalized,orgId,id),
    finishInboxLease: (orgId,id,generation,at) => run("UPDATE event_inbox SET state='processed',processed_at=?,lease_expires_at=NULL WHERE org_id=? AND id=? AND state='leased' AND lease_generation=?",at,orgId,id,generation),
    retryInboxLease: (orgId,id,generation,nextAt,error,state) => run("UPDATE event_inbox SET state=?,last_error=?,next_attempt_at=?,lease_expires_at=NULL WHERE org_id=? AND id=? AND state='leased' AND lease_generation=?",state,String(error).slice(0,1000),nextAt,orgId,id,generation),
    /** Insert an immutable parent/child binding for a stable delegation slot. Signature: (id,orgId,parentTaskId,childTaskId,slot,requestHash,dispatchId,createdAt,updatedAt). */
    createTaskDelegation: async (id,orgId,parentTaskId,childTaskId,slot,requestHash,dispatchId,createdAt,updatedAt) => mutationCount(await run(`INSERT INTO task_delegations(id,org_id,parent_task_id,child_task_id,delegation_slot,request_hash,dispatch_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(org_id,parent_task_id,delegation_slot) DO NOTHING`,id,orgId,parentTaskId,childTaskId,slot,requestHash,dispatchId,createdAt,updatedAt)),
    /** Read a delegation slot. Signature: (orgId,parentTaskId,slot). */
    findTaskDelegationBySlot: (orgId,parentTaskId,slot) => get('SELECT * FROM task_delegations WHERE org_id=? AND parent_task_id=? AND delegation_slot=?',orgId,parentTaskId,slot),
    /** Read a delegation by ID within its organization. Signature: (orgId,id). */
    findTaskDelegationById: (orgId,id) => get('SELECT * FROM task_delegations WHERE org_id=? AND id=?',orgId,id),
    /** Resolve only the matching waiting slot/hash/capability and a task linked to a same-org completed workflow. Signature: (orgId,parentTaskId,slot,requestHash,capability,evidenceJson,resolutionJson,at). */
    resolveTaskDelegation: async (orgId,parentTaskId,slot,requestHash,capability,evidenceJson,resolutionJson,at) => mutationCount(await run(`UPDATE task_delegations SET state='resolved',evidence_json=?,resolution_json=?,resolved_at=?,updated_at=?
      WHERE org_id=? AND parent_task_id=? AND delegation_slot=? AND request_hash=? AND state='waiting'
        AND EXISTS(SELECT 1 FROM crew_tasks child JOIN workflows workflow ON workflow.org_id=child.org_id AND workflow.id=child.workflow_id AND workflow.status='completed'
          WHERE child.org_id=task_delegations.org_id AND child.id=task_delegations.child_task_id AND child.state='completed' AND child.workflow_id IS NOT NULL AND child.capability=? AND child.capability<>'legacy.workflow')`,evidenceJson,resolutionJson,at,at,orgId,parentTaskId,slot,requestHash,capability)),
    /** Fail only the matching waiting slot/hash. Signature: (orgId,parentTaskId,slot,requestHash,resolutionJson,at). */
    failTaskDelegation: async (orgId,parentTaskId,slot,requestHash,resolutionJson,at) => mutationCount(await run(`UPDATE task_delegations SET state='failed',resolution_json=?,resolved_at=?,updated_at=? WHERE org_id=? AND parent_task_id=? AND delegation_slot=? AND request_hash=? AND state='waiting'`,resolutionJson,at,at,orgId,parentTaskId,slot,requestHash)),
    /** Insert an authorized grant. Signature: (id,orgId,scope,sourceEmployeeId,targetEmployeeId,capability,subscriptionId,principalId,connectionId,environment,managerSignerUserId,authorizedByUserId,authorizationJson,sourceSpecRevision,sourceDeploymentRevision,targetSpecRevision,targetDeploymentRevision,createdAt,updatedAt). */
    createEmployeeDelegationGrant: async (...p) => {
      const [id,orgId,scope,source,target,capability,...rest]=p;
      return mutationCount(await run(`INSERT INTO employee_delegation_grants(id,org_id,grant_scope,source_employee_id,target_employee_id,capability,delegated_capability,subscription_id,principal_id,connection_id,environment,manager_signer_user_id,authorized_by_user_id,authorization_json,source_spec_revision,source_deployment_revision,target_spec_revision,target_deployment_revision,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(org_id,id) DO NOTHING`,id,orgId,scope,source,target,capability,capability,...rest));
    },
    createEventDelegationGrant: async (...p) => mutationCount(await run(`INSERT INTO employee_delegation_grants(id,org_id,grant_scope,source_employee_id,target_employee_id,capability,delegated_capability,subscription_id,principal_id,connection_id,environment,manager_signer_user_id,authorized_by_user_id,authorization_json,source_spec_revision,source_deployment_revision,target_spec_revision,target_deployment_revision,created_at,updated_at)
      VALUES(?,?,'event',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(org_id,id) DO NOTHING`,...p)),
    /** Read one grant by organization and ID. Signature: (orgId,id). */
    findEmployeeDelegationGrant: (orgId,id) => get('SELECT * FROM employee_delegation_grants WHERE org_id=? AND id=?',orgId,id),
    listEventDelegationGrants: (orgId,subscriptionId) => all("SELECT * FROM employee_delegation_grants WHERE org_id=? AND grant_scope='event' AND subscription_id=? ORDER BY created_at,id",orgId,subscriptionId),
    /** Read active grants for an employee delegation capability and exact scope binding. Signature: ({orgId,sourceEmployeeId,capability,scope,subscriptionId,principalId,connectionId,environment}). */
    findActiveEmployeeDelegationGrants: ({orgId,sourceEmployeeId,capability,delegatedCapability=capability,scope='employee',subscriptionId=null,principalId=null,connectionId=null,environment=null}) => all(`SELECT * FROM employee_delegation_grants WHERE org_id=? AND source_employee_id=? AND capability=? AND grant_scope=? AND state='active' AND (grant_scope<>'event' OR delegated_capability=?)
      AND ((?='employee' AND subscription_id IS NULL AND principal_id IS NULL AND connection_id IS NULL AND environment IS NULL)
        OR (?='event' AND subscription_id=? AND principal_id=? AND connection_id=? AND environment=?)) ORDER BY target_employee_id,id`,orgId,sourceEmployeeId,capability,scope,delegatedCapability,scope,scope,subscriptionId,principalId,connectionId,environment),
    /** Revoke an active grant with a version CAS. Signature: (orgId,id,expectedVersion,revokerUserId,at). */
    revokeEmployeeDelegationGrant: async (orgId,id,expectedVersion,revokerUserId,at) => mutationCount(await run(`UPDATE employee_delegation_grants SET state='revoked',version=version+1,revoked_by_user_id=?,revoked_at=?,updated_at=? WHERE org_id=? AND id=? AND state='active' AND version=?`,revokerUserId,at,at,orgId,id,expectedVersion)),
    get, all, run,
  };
}
