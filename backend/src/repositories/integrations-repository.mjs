/** SQL access for the integrations domain. Business logic should call these named operations. */
export function createIntegrationsRepository({ all, get, run }) {
  return {
    findManyMcpConnectionByOrgIdAndStatus: (...params) =>
      all(
        "SELECT id,name,tools FROM mcp_connections WHERE org_id=? AND status='connected' ORDER BY name",
        ...params,
      ),
    findOneIntegrationByOrgIdAndProvider: (...params) =>
      get(
        "SELECT status,config FROM integrations WHERE org_id=? AND provider=?",
        ...params,
      ),
    findManyMcpConnectionByOrgIdAndStatusSelectIdNameEndpoint: (...params) =>
      all(
        "SELECT id,name,endpoint,token_ciphertext,tools FROM mcp_connections WHERE org_id=? AND status='connected'",
        ...params,
      ),
    findManyMcpConnectionByOrgId: (...params) =>
      all(
        "SELECT id FROM mcp_connections WHERE org_id=?",
        ...params,
      ),
    findOneSolariProfileByIdAndOrgId: (...params) =>
      get(
        "SELECT id FROM solari_profiles WHERE id=? AND org_id=?",
        ...params,
      ),
    findOneEnvironmentByIdAndOrgId: (...params) =>
      get(
        "SELECT metadata FROM environments WHERE id=? AND org_id=?",
        ...params,
      ),
    findOneJiraOauthStateByStateHashAndExpiresAt: (...params) =>
      get(
        "SELECT * FROM jira_oauth_states WHERE state_hash=? AND expires_at>?",
        ...params,
      ),
    deleteJiraOauthStateByStateHash: (...params) =>
      run(
        "DELETE FROM jira_oauth_states WHERE state_hash=?",
        ...params,
      ),
    findOneIntegrationByOrgIdAndProviderSelectConfig: (...params) =>
      get(
        "SELECT config FROM integrations WHERE org_id=? AND provider=?",
        ...params,
      ),
    deleteJiraOauthStateByExpiresAt: (...params) =>
      run(
        "DELETE FROM jira_oauth_states WHERE expires_at<=?",
        ...params,
      ),
    insertJiraOauthState: (...params) =>
      run(
        "INSERT INTO jira_oauth_states(state_hash,org_id,user_id,expires_at,created_at) VALUES(?,?,?,?,?)",
        ...params,
      ),
    findOneEnvironmentByIdAndOrgIdSelectKindStatusMetadata: (...params) =>
      get(
        "SELECT kind,status,metadata FROM environments WHERE id=? AND org_id=?",
        ...params,
      ),
    findManyMcpConnectionByOrgIdSelectIdNameEndpoint: (...params) =>
      all(
        "SELECT id,name,endpoint,tools,status,created_at,updated_at FROM mcp_connections WHERE org_id=? ORDER BY name",
        ...params,
      ),
    insertMcpConnection: (...params) =>
      run(
        "INSERT INTO mcp_connections(id,org_id,name,endpoint,token_ciphertext,tools,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ...params,
      ),
    findOneMcpConnectionByIdAndOrgId: (...params) =>
      get(
        "SELECT * FROM mcp_connections WHERE id=? AND org_id=?",
        ...params,
      ),
    updateMcpConnectionByIdAndOrgId: (...params) =>
      run(
        "UPDATE mcp_connections SET tools=?,status=?,token_ciphertext=?,updated_at=? WHERE id=? AND org_id=?",
        ...params,
      ),
    findOneMcpConnectionByIdAndOrgIdSelectIdName: (...params) =>
      get(
        "SELECT id,name FROM mcp_connections WHERE id=? AND org_id=?",
        ...params,
      ),
    updateMcpConnectionByIdAndOrgIdSetStatusTokenCiphertextUpdatedAt: (...params) =>
      run(
        "UPDATE mcp_connections SET status=?,token_ciphertext=NULL,updated_at=? WHERE id=? AND org_id=?",
        ...params,
      ),
    findManyEnvironmentByOrgId: (...params) =>
      all(
        "SELECT id,kind,profile_id AS profileId,status,label,metadata,created_at AS createdAt FROM environments WHERE org_id=? ORDER BY created_at DESC",
        ...params,
      ),
    findOneEnvironmentByIdAndOrgIdSelectProviderIdKindStatus: (...params) =>
      get(
        "SELECT provider_id,kind,status FROM environments WHERE id=? AND org_id=?",
        ...params,
      ),
    findOneEnvironmentByIdAndOrgIdSelectKindStatus: (...params) =>
      get(
        "SELECT kind,status FROM environments WHERE id=? AND org_id=?",
        ...params,
      ),
    updateEnvironmentByIdAndOrgId: (...params) =>
      run(
        "UPDATE environments SET metadata=? WHERE id=? AND org_id=?",
        ...params,
      ),
    findOneEnvironmentByIdAndOrgIdSelectAllFields: (...params) =>
      get(
        "SELECT * FROM environments WHERE id=? AND org_id=?",
        ...params,
      ),
    findManyIntegrationByOrgId: (...params) =>
      all(
        "SELECT id,provider,display_name,status,config,updated_at FROM integrations WHERE org_id=? ORDER BY provider",
        ...params,
      ),
    updateIntegrationByOrgIdAndProvider: (...params) =>
      run(
        "UPDATE integrations SET config=?,updated_at=? WHERE org_id=? AND provider=?",
        ...params,
      ),
    findManyEnvironmentByOrgIdAndKindAndProviderId: (...params) =>
      all(
        "SELECT provider_id,created_at FROM environments WHERE org_id=? AND kind='browser' AND provider_id IS NOT NULL ORDER BY created_at DESC LIMIT 100",
        ...params,
      ),
    findOneEnvironmentByOrgIdAndStatus: (...params) =>
      get(
        "SELECT COUNT(*) AS count FROM environments WHERE org_id=? AND status=\"running\"",
        ...params,
      ),
    findManyEnvironmentByOrgIdSelectKindStatusMetadata: (...params) =>
      all(
        "SELECT kind,status,metadata FROM environments WHERE org_id=?",
        ...params,
      ),
    findOneSolariProfileByIdAndOrgIdSelectIdProviderIdKeyHash: (...params) =>
      get(
        "SELECT id,provider_id,key_hash FROM solari_profiles WHERE id=? AND org_id=?",
        ...params,
      ),
    findOneSolariProfile: (...params) =>
      get(
        "INSERT INTO solari_profiles(id,org_id,provider_id,key_hash,name,created_by,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(org_id,provider_id) DO UPDATE SET key_hash=excluded.key_hash,name=excluded.name RETURNING id",
        ...params,
      ),
    insertSolariProfile: (...params) =>
      run(
        "INSERT INTO solari_profiles(id,org_id,provider_id,key_hash,name,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
        ...params,
      ),
    deleteSolariProfileByIdAndOrgId: (...params) =>
      run(
        "DELETE FROM solari_profiles WHERE id=? AND org_id=?",
        ...params,
      ),
    insertEnvironment: (...params) =>
      run(
        "INSERT INTO environments(id,org_id,kind,provider_id,profile_id,status,label,metadata,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ...params,
      ),
    findOneEnvironmentByIdAndOrgIdAndKind: (...params) =>
      get(
        "SELECT provider_id FROM environments WHERE id=? AND org_id=? AND kind='desktop' AND status='running'",
        ...params,
      ),
    updateEnvironmentByIdAndOrgIdAndStatus: (...params) =>
      run(
        "UPDATE environments SET status='paused' WHERE id=? AND org_id=? AND status='running'",
        ...params,
      ),
    updateEnvironmentByIdAndOrgIdAndStatusSetStatus: (...params) =>
      run(
        "UPDATE environments SET status='running' WHERE id=? AND org_id=? AND status='paused'",
        ...params,
      ),
    updateEnvironmentByIdAndOrgIdSetStatus: (...params) =>
      run(
        "UPDATE environments SET status='stopped' WHERE id=? AND org_id=?",
        ...params,
      ),
    findOneIntegrationByOrgIdAndProviderSelectSecretCiphertextStatus: (...params) =>
      get(
        "SELECT secret_ciphertext,status FROM integrations WHERE org_id=? AND provider=?",
        ...params,
      ),
    findOneIntegration: (...params) =>
      get(
        "INSERT INTO integrations(id,org_id,provider,display_name,secret_ciphertext,config,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(org_id,provider) DO UPDATE SET secret_ciphertext=excluded.secret_ciphertext,config=excluded.config,status=excluded.status,updated_at=excluded.updated_at RETURNING id,provider,display_name,status,config,updated_at",
        ...params,
      ),
    updateIntegrationByOrgIdAndProviderSetSecretCiphertextUpdatedAt: (...params) =>
      run(
        "UPDATE integrations SET secret_ciphertext=?,updated_at=? WHERE org_id=? AND provider=?",
        ...params,
      ),
    deleteIntegrationByOrgIdAndProvider: (...params) =>
      run(
        "DELETE FROM integrations WHERE org_id=? AND provider=?",
        ...params,
      ),
  };
}
