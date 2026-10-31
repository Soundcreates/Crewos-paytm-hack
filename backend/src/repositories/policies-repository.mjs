/** SQL access for the policies domain. Business logic should call these named operations. */
export function createPoliciesRepository({ all, get, run }) {
  return {
    findExistingPoliciesByOrgAndTools: (orgId, tools) =>
      all(
        `SELECT tool FROM policies WHERE org_id=? AND tool IN (${tools.map(() => '?').join(',')})`,
        orgId,
        ...tools,
      ),
    insertPolicy: (...params) =>
      run(
        "INSERT INTO policies(id,org_id,name,tool,effect,condition,created_at) VALUES(?,?,?,?,?,?,?)",
        ...params,
      ),
    findManyPolicyByOrgIdAndActive: (...params) =>
      all(
        "SELECT name,tool,effect,condition FROM policies WHERE org_id=? AND active=1",
        ...params,
      ),
    findManyPolicyByOrgId: (...params) =>
      all(
        "SELECT * FROM policies WHERE org_id=? ORDER BY tool,effect,name",
        ...params,
      ),
    findOnePolicyByOrgIdAndId: (...params) =>
      get(
        "SELECT * FROM policies WHERE org_id=? AND id=?",
        ...params,
      ),
    updatePolicyByIdAndOrgId: (...params) =>
      run(
        "UPDATE policies SET active=? WHERE id=? AND org_id=?",
        ...params,
      ),
    findOnePolicyByOrgId: (...params) =>
      get(
        "SELECT COUNT(*) AS count FROM policies WHERE org_id=?",
        ...params,
      ),
    findManyPolicyByOrgIdAndActiveAndTool: (...params) =>
      all(
        "SELECT * FROM policies WHERE org_id=? AND active=1 AND tool=?",
        ...params,
      ),
    findOnePolicyById: (...params) =>
      get(
        "SELECT * FROM policies WHERE id=?",
        ...params,
      ),
    findManyPolicyByOrgIdSelectIdToolEffect: (...params) =>
      all(
        "SELECT id,tool,effect,condition,active FROM policies WHERE org_id=? ORDER BY id",
        ...params,
      ),
  };
}
