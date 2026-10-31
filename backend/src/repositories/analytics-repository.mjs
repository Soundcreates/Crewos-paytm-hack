/** SQL access for the analytics domain. Business logic should call these named operations. */
export function createAnalyticsRepository({ all, get, run }) {
  return {
    insertProviderUsage: (...params) =>
      run(
        "INSERT INTO provider_usage(id,org_id,provider,model,operation,input_tokens,output_tokens,total_tokens,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        ...params,
      ),
    insertOfficeLayout: (...params) =>
      run(
        "INSERT OR IGNORE INTO office_layouts(org_id,layout,updated_at) VALUES(?,?,?)",
        ...params,
      ),
    findOneOfficeLayoutByOrgId: (...params) =>
      get(
        "SELECT layout FROM office_layouts WHERE org_id=?",
        ...params,
      ),
    insertOfficeLayoutWithOrgIdLayoutUpdatedAt: (...params) =>
      run(
        "INSERT INTO office_layouts(org_id,layout,updated_at) VALUES(?,?,?) ON CONFLICT(org_id) DO UPDATE SET layout=excluded.layout,updated_at=excluded.updated_at",
        ...params,
      ),
    findOneProviderUsageByOrgId: (...params) =>
      get(
        "SELECT COUNT(*) AS calls,COALESCE(SUM(input_tokens),0) AS inputTokens,COALESCE(SUM(output_tokens),0) AS outputTokens,COALESCE(SUM(total_tokens),0) AS totalTokens FROM provider_usage WHERE org_id=?",
        ...params,
      ),
    findManyProviderUsageByOrgId: (...params) =>
      all(
        "SELECT provider,model,operation,COUNT(*) AS calls,SUM(input_tokens) AS inputTokens,SUM(output_tokens) AS outputTokens,SUM(total_tokens) AS totalTokens FROM provider_usage WHERE org_id=? GROUP BY provider,model,operation ORDER BY totalTokens DESC",
        ...params,
      ),
  };
}
