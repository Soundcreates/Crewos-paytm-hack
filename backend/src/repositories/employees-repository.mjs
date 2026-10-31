/** SQL access for the employees domain. Business logic should call these named operations. */
export function createEmployeesRepository({ all, get, run }) {
  return {
    findOneEmployeeByIdAndOrgId: (...params) =>
      get(
        "SELECT * FROM employees WHERE id=? AND org_id=?",
        ...params,
      ),
    findOneEmployeeSpecByEmployeeId: (...params) =>
      get(
        "SELECT * FROM employee_specs WHERE employee_id=? ORDER BY version DESC LIMIT 1",
        ...params,
      ),
    findOneCoworkerByOrgIdAndEmployeeId: (...params) =>
      get(
        "SELECT id,name,role,expertise,summary FROM coworkers WHERE org_id=? AND employee_id=? ORDER BY updated_at DESC LIMIT 1",
        ...params,
      ),
    findManyCoworkerByOrgIdAndId: (...params) =>
      all(
        "SELECT id,name,role,expertise,summary,updated_at FROM coworkers WHERE org_id=? AND id<>? ORDER BY updated_at DESC LIMIT 200",
        ...params,
      ),
    findManyCoworkerRelationshipByOrgIdAndFromCoworkerIdAndToCoworkerId: (...params) =>
      all(
        "SELECT id,from_coworker_id,to_coworker_id,last_interaction_summary,last_interaction_at,updated_at FROM coworker_relationships WHERE org_id=? AND (from_coworker_id=? OR to_coworker_id=?) ORDER BY CASE WHEN last_interaction_at IS NULL THEN 1 ELSE 0 END,last_interaction_at DESC,updated_at DESC LIMIT 200",
        ...params,
      ),
    findManyEmployeeSpecByEmployeeId: (...params) =>
      all(
        "SELECT id,version,data,provenance,created_by,created_at FROM employee_specs WHERE employee_id=? ORDER BY version DESC",
        ...params,
      ),
    findOneEmployeeSpecByEmployeeIdSelectVersionData: (...params) =>
      get(
        "SELECT version,data FROM employee_specs WHERE employee_id=? ORDER BY version DESC LIMIT 1",
        ...params,
      ),
    insertEmployeeSpec: (...params) =>
      run(
        "INSERT INTO employee_specs(id,employee_id,version,data,provenance,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
        ...params,
      ),
    updateEmployeeByIdAndOrgId: (...params) =>
      run(
        "UPDATE employees SET name=?,title=?,department=?,profile_id=?,state=CASE WHEN state='active' THEN 'probation' ELSE 'draft' END,updated_at=? WHERE id=? AND org_id=?",
        ...params,
      ),
    updateCoworkerByOrgIdAndEmployeeId: (...params) =>
      run(
        "UPDATE coworkers SET name=?,role=?,expertise=?,summary=?,updated_at=? WHERE org_id=? AND employee_id=?",
        ...params,
      ),
    findOneEmployeeDeploymentByOrgIdAndEmployeeIdAndSpecVersion: (...params) =>
      get(
        "SELECT id,runtime_version,policy_revision,evidence FROM employee_deployments WHERE org_id=? AND employee_id=? AND spec_version=? ORDER BY created_at DESC,id DESC LIMIT 1",
        ...params,
      ),
    updateEmployeeByIdAndOrgIdSetStateUpdatedAt: (...params) =>
      run(
        "UPDATE employees SET state=CASE WHEN state IN ('active','draft') THEN 'probation' ELSE state END,updated_at=? WHERE id=? AND org_id=?",
        ...params,
      ),
    findOneEmployeeByIdAndOrgIdSelectIdOrgId: (...params) =>
      get(
        "SELECT id,org_id FROM employees WHERE id=? AND org_id=?",
        ...params,
      ),
    insertEmployee: (...params) =>
      run(
        "INSERT INTO employees(id,org_id,name,title,department,state,avatar,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
        ...params,
      ),
    insertCoworker: (...params) =>
      run(
        "INSERT INTO coworkers(id,org_id,employee_id,name,role,expertise,summary,updated_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        ...params,
      ),
    updateEmployeeByIdAndOrgIdSetStateUpdatedAtWhenArchived: (...params) =>
      run(
        "UPDATE employees SET state=\"archived\",updated_at=? WHERE id=? AND org_id=?",
        ...params,
      ),
    updateEmployeeByIdAndOrgIdSetStateUpdatedAtWhenDraft: (...params) =>
      run(
        "UPDATE employees SET state='draft',updated_at=? WHERE id=? AND org_id=?",
        ...params,
      ),
    insertEmployeeDeployment: (...params) =>
      run(
        "INSERT INTO employee_deployments(id,org_id,employee_id,spec_version,runtime_version,policy_revision,evidence,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        ...params,
      ),
    updateEmployeeByIdAndOrgIdSetStateUpdatedAtWhenActive: (...params) =>
      run(
        "UPDATE employees SET state='active',updated_at=? WHERE id=? AND org_id=?",
        ...params,
      ),
    updateEmployeeByIdAndOrgIdSetStateUpdatedAtWhenPaused: (...params) =>
      run(
        "UPDATE employees SET state=\"paused\",updated_at=? WHERE id=? AND org_id=?",
        ...params,
      ),
    findOneEmployeeByOrgIdAndProfileId: (...params) =>
      get(
        "SELECT id FROM employees WHERE org_id=? AND profile_id=? LIMIT 1",
        ...params,
      ),
    findManyCoworkerRelationshipByOrgId: (...params) =>
      all(
        "SELECT r.*,f.name AS from_name,t.name AS to_name\n      FROM coworker_relationships r\n      JOIN coworkers f ON f.id=r.from_coworker_id AND f.org_id=r.org_id\n      JOIN coworkers t ON t.id=r.to_coworker_id AND t.org_id=r.org_id\n      WHERE r.org_id=? ORDER BY r.last_interaction_at DESC,r.updated_at DESC",
        ...params,
      ),
    findOneCoworkerByIdAndOrgId: (...params) =>
      get(
        "SELECT id FROM coworkers WHERE id=? AND org_id=?",
        ...params,
      ),
    findOneCoworkerRelationshipByOrgIdAndFromCoworkerIdAndToCoworkerId: (...params) =>
      get(
        "SELECT id FROM coworker_relationships WHERE org_id=? AND from_coworker_id=? AND to_coworker_id=?",
        ...params,
      ),
    insertCoworkerRelationship: (...params) =>
      run(
        "INSERT INTO coworker_relationships(id,org_id,from_coworker_id,to_coworker_id,last_interaction_summary,last_interaction_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        ...params,
      ),
    findOneCoworkerRelationshipByIdAndOrgId: (...params) =>
      get(
        "SELECT * FROM coworker_relationships WHERE id=? AND org_id=?",
        ...params,
      ),
    findOneCoworkerRelationshipByOrgIdAndFromCoworkerIdAndToCoworkerIdSelectId: (...params) =>
      get(
        "SELECT id FROM coworker_relationships WHERE org_id=? AND from_coworker_id=? AND to_coworker_id=? AND id<>?",
        ...params,
      ),
    updateCoworkerRelationshipByIdAndOrgId: (...params) =>
      run(
        "UPDATE coworker_relationships SET from_coworker_id=?,to_coworker_id=?,last_interaction_summary=?,last_interaction_at=?,updated_at=? WHERE id=? AND org_id=?",
        ...params,
      ),
    findOneCoworkerRelationshipByIdAndOrgIdSelectId: (...params) =>
      get(
        "SELECT id FROM coworker_relationships WHERE id=? AND org_id=?",
        ...params,
      ),
    deleteCoworkerRelationshipByIdAndOrgId: (...params) =>
      run(
        "DELETE FROM coworker_relationships WHERE id=? AND org_id=?",
        ...params,
      ),
    findManyCoworkerByOrgId: (...params) =>
      all(
        "SELECT c.*,e.state AS employee_state,e.avatar FROM coworkers c LEFT JOIN employees e ON e.id=c.employee_id WHERE c.org_id=? ORDER BY c.employee_id IS NULL,c.name",
        ...params,
      ),
    insertCoworkerWithIdOrgIdName: (...params) =>
      run(
        "INSERT INTO coworkers(id,org_id,name,role,expertise,summary,updated_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
        ...params,
      ),
    findOneCoworkerByIdAndOrgIdSelectIdNameEmployeeId: (...params) =>
      get(
        "SELECT id,name,employee_id FROM coworkers WHERE id=? AND org_id=?",
        ...params,
      ),
    deleteCoworkerByIdAndOrgIdAndEmployeeId: (...params) =>
      run(
        "DELETE FROM coworkers WHERE id=? AND org_id=? AND employee_id IS NULL",
        ...params,
      ),
    findOneCoworkerByIdAndOrgIdSelectAllFields: (...params) =>
      get(
        "SELECT * FROM coworkers WHERE id=? AND org_id=?",
        ...params,
      ),
    updateCoworkerByIdAndOrgId: (...params) =>
      run(
        "UPDATE coworkers SET name=?,role=?,expertise=?,summary=?,updated_at=? WHERE id=? AND org_id=?",
        ...params,
      ),
    findManyEmployeeByOrgId: (...params) =>
      all(
        "SELECT id,name,title,state,avatar,x,y FROM employees WHERE org_id=? ORDER BY name",
        ...params,
      ),
    updateEmployeeByIdAndOrgIdSetXYUpdatedAt: (...params) =>
      run(
        "UPDATE employees SET x=?,y=?,updated_at=? WHERE id=? AND org_id=?",
        ...params,
      ),
    findOneEmployeeRuntimeSetupByOrgIdAndEmployeeId: (...params) =>
      get(
        "SELECT setup.employee_id,setup.status,setup.lease_expires_at,setup.browser_profile_id,setup.desktop_environment_id,\n      profile.name AS browser_profile_name,profile.key_hash AS browser_profile_key_hash,\n      environment.status AS desktop_status,environment.label AS desktop_label\n    FROM employee_runtime_setups setup\n    LEFT JOIN solari_profiles profile ON profile.id=setup.browser_profile_id AND profile.org_id=setup.org_id\n    LEFT JOIN environments environment ON environment.id=setup.desktop_environment_id AND environment.org_id=setup.org_id\n    WHERE setup.org_id=? AND setup.employee_id=?",
        ...params,
      ),
    findOneEmployeeSpecByEmployeeIdSelectData: (...params) =>
      get(
        "SELECT data FROM employee_specs WHERE employee_id=? ORDER BY version DESC LIMIT 1",
        ...params,
      ),
    insertEmployeeRuntimeSetup: (...params) =>
      run(
        "INSERT INTO employee_runtime_setups(employee_id,org_id,status,created_at,updated_at)\n      VALUES(?,?,'provisioning',?,?)\n      ON CONFLICT(employee_id) DO UPDATE SET status='provisioning',updated_at=excluded.updated_at",
        ...params,
      ),
    updateEmployeeRuntimeSetupByOrgIdAndEmployeeId: (...params) =>
      run(
        "UPDATE employee_runtime_setups SET lease_expires_at=? WHERE org_id=? AND employee_id=?",
        ...params,
      ),
    updateEmployeeRuntimeSetupByOrgIdAndEmployeeIdAndStatus: (...params) =>
      run(
        "UPDATE employee_runtime_setups SET browser_profile_id=?,desktop_environment_id=?,status='ready',updated_at=?\n      WHERE org_id=? AND employee_id=? AND status='provisioning' AND updated_at=?",
        ...params,
      ),
    updateEmployeeRuntimeSetupByOrgIdAndEmployeeIdAndStatusSetStatusUpdatedAt: (...params) =>
      run(
        "UPDATE employee_runtime_setups SET status=?,updated_at=? WHERE org_id=? AND employee_id=? AND status='provisioning' AND updated_at=?",
        ...params,
      ),
    findOneEmployeeRuntimeSetupByOrgIdAndEmployeeIdAndStatus: (...params) =>
      get(
        "SELECT setup.desktop_environment_id AS environment_id,environment.status\n    FROM employee_runtime_setups setup\n    JOIN environments environment ON environment.id=setup.desktop_environment_id AND environment.org_id=setup.org_id\n    WHERE setup.org_id=? AND setup.employee_id=? AND setup.status='ready'",
        ...params,
      ),
    findOneEmployeeRuntimeSetupByOrgIdAndEmployeeIdAndStatusSelectBrowserProfileIdKeyHash: (...params) =>
      get(
        "SELECT setup.browser_profile_id,profile.key_hash\n    FROM employee_runtime_setups setup\n    JOIN solari_profiles profile ON profile.id=setup.browser_profile_id AND profile.org_id=setup.org_id\n    WHERE setup.org_id=? AND setup.employee_id=? AND setup.status='ready'",
        ...params,
      ),
    findOneEmployeeByOrgIdAndId: (...params) =>
      get(
        "SELECT state FROM employees WHERE org_id=? AND id=?",
        ...params,
      ),
    deleteEmployeeRuntimeSetupByOrgIdAndEmployeeId: (...params) =>
      run(
        "DELETE FROM employee_runtime_setups WHERE org_id=? AND employee_id=?",
        ...params,
      ),
    findManyEmployeeByOrgIdSelectAllFields: (...params) =>
      all(
        "SELECT * FROM employees WHERE org_id=? ORDER BY updated_at DESC",
        ...params,
      ),
    findOneEmployeeByOrgId: (...params) =>
      get(
        "SELECT COUNT(*) AS count FROM employees WHERE org_id=?",
        ...params,
      ),
    findOneEmployeeByOrgIdAndState: (...params) =>
      get(
        "SELECT COUNT(*) AS count FROM employees WHERE org_id=? AND state='active'",
        ...params,
      ),
  };
}
