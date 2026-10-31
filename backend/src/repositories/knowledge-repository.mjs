/** SQL access for the knowledge domain. Business logic should call these named operations. */
export function createKnowledgeRepository({ all, get, run }) {
  return {
    findRecentMemoryCandidates: (orgId, employeeId) => {
      const scope = employeeId ? 'org_id=? AND (employee_id=? OR employee_id IS NULL)' : 'org_id=?';
      const params = employeeId ? [orgId, employeeId] : [orgId];
      return all(`SELECT * FROM memories WHERE ${scope} ORDER BY created_at DESC LIMIT 100`, ...params);
    },
    findMemoryCandidatesByTerms: (orgId, employeeId, terms) => {
      const scope = employeeId ? 'org_id=? AND (employee_id=? OR employee_id IS NULL)' : 'org_id=?';
      const params = employeeId ? [orgId, employeeId] : [orgId];
      const relevance = terms.map(() => "CASE WHEN LOWER(title || ' ' || body) LIKE ? THEN 1 ELSE 0 END").join('+');
      const matches = terms.map(() => "LOWER(title || ' ' || body) LIKE ?").join(' OR ');
      const termParams = terms.map((term) => `%${term}%`);
      return all(`SELECT * FROM memories WHERE ${scope} AND (${matches}) ORDER BY (${relevance}) DESC,created_at DESC LIMIT 700`,
        ...params, ...termParams, ...termParams);
    },
    findMemoriesByIds: (orgId, ids) =>
      all(
        `SELECT * FROM memories WHERE org_id=? AND id IN (${ids.map(() => '?').join(',')})`,
        orgId,
        ...ids,
      ),
    findMemoryAclByOrgIdAndIds: (orgId, ids) => ids.length ? all(
      `SELECT memory_id,visibility,team_ids,task_ids,source_type,source_id,owner_user_id,owner_employee_id,expires_at FROM memory_acl_metadata WHERE org_id=? AND memory_id IN (${ids.map(() => '?').join(',')})`,
      orgId, ...ids,
    ) : Promise.resolve([]),
    insertMemoryAclMetadata: (...p) => run('INSERT INTO memory_acl_metadata(memory_id,org_id,visibility,team_ids,task_ids,source_type,source_id,owner_user_id,owner_employee_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(memory_id) DO NOTHING',...p),
    findManyMemoryIndexTargetsAfterId: (...params) =>
      all(
        'SELECT id,org_id FROM memories WHERE id>? ORDER BY id LIMIT ?',
        ...params,
      ),
    findDocumentsByOrgAndFilenames: (orgId, filenames) =>
      all(
        `SELECT filename,extracted_text FROM documents WHERE org_id=? AND filename IN (${filenames.map(() => '?').join(',')})`,
        orgId,
        ...filenames,
      ),
    findOneDocumentByOrgIdAndId: (...params) =>
      get(
        "SELECT id,filename,extracted_text FROM documents WHERE org_id=? AND id=?",
        ...params,
      ),
    findManyDocumentByOrgId: (...params) =>
      all(
        "SELECT id,filename,mime_type,created_at FROM documents WHERE org_id=? ORDER BY created_at DESC",
        ...params,
      ),
    insertDocument: (...params) =>
      run(
        "INSERT INTO documents(id,org_id,filename,mime_type,extracted_text,created_by,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
        ...params,
      ),
    findOneDocumentByIdAndOrgId: (...params) =>
      get(
        "SELECT id,filename,mime_type,extracted_text,created_at FROM documents WHERE id=? AND org_id=?",
        ...params,
      ),
    findOneDocumentByIdAndOrgIdSelectIdFilename: (...params) =>
      get(
        "SELECT id,filename FROM documents WHERE id=? AND org_id=?",
        ...params,
      ),
    findManyMemoryByOrgIdAndSource: (...params) =>
      all(
        "SELECT id FROM memories WHERE org_id=? AND source=?",
        ...params,
      ),
    deleteMemoryByOrgIdAndSource: (...params) =>
      run(
        "DELETE FROM memories WHERE org_id=? AND source=?",
        ...params,
      ),
    deleteDocumentByIdAndOrgId: (...params) =>
      run(
        "DELETE FROM documents WHERE id=? AND org_id=?",
        ...params,
      ),
    findManyMemoryByOrgId: (...params) =>
      all(
        "SELECT * FROM memories WHERE org_id=? ORDER BY created_at DESC LIMIT 100",
        ...params,
      ),
    findOneMemoryByIdAndOrgId: (...params) =>
      get(
        "SELECT id FROM memories WHERE id=? AND org_id=?",
        ...params,
      ),
    findOneDocumentByIdAndOrgIdSelectExtractedText: (...params) =>
      get(
        "SELECT extracted_text FROM documents WHERE id=? AND org_id=?",
        ...params,
      ),
    insertMemory: (...params) =>
      run(
        "INSERT INTO memories(id,org_id,employee_id,kind,title,body,source,confidence,embedding,created_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
        ...params,
      ),
    updateMemoryByIdAndOrgId: (...params) =>
      run(
        "UPDATE memories SET embedding=? WHERE id=? AND org_id=?",
        ...params,
      ),
    updateMemoryByIdAndOrgIdSetIndexStatusEmbeddingModelEmbeddingDimensions: (...params) =>
      run(
        "UPDATE memories SET index_status=?,embedding_model=?,embedding_dimensions=? WHERE id=? AND org_id=?",
        ...params,
      ),
    findOneMemoryById: (...params) =>
      get(
        "SELECT id,employee_id,kind,title,body,source,confidence,created_at,index_status FROM memories WHERE id=?",
        ...params,
      ),
    insertMemoryWithIdOrgIdEmployeeId: (...params) =>
      run(
        "INSERT OR IGNORE INTO memories(id,org_id,employee_id,kind,title,body,source,confidence,embedding,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ...params,
      ),
    findOneMemoryByIdSelectIdOrgIdKind: (...params) =>
      get(
        "SELECT id,org_id,kind,title,body,source FROM memories WHERE id=?",
        ...params,
      ),
    findOneMemoryByIdAndOrgIdSelectAllFields: (...params) =>
      get(
        "SELECT * FROM memories WHERE id=? AND org_id=?",
        ...params,
      ),
    updateMemoryByIdAndOrgIdSetIndexStatus: (...params) =>
      run(
        "UPDATE memories SET index_status='lexical' WHERE id=? AND org_id=?",
        ...params,
      ),
    updateMemoryByIdAndOrgIdSetEmbeddingModelEmbeddingDimensions: (...params) =>
      run(
        "UPDATE memories SET embedding_model=?,embedding_dimensions=? WHERE id=? AND org_id=?",
        ...params,
      ),
    updateMemoryByIdAndOrgIdSetEmbeddingIndexStatus: (...params) =>
      run(
        "UPDATE memories SET embedding=?,index_status='indexed' WHERE id=? AND org_id=?",
        ...params,
      ),
    updateMemoryByIdAndOrgIdSetEmbeddingRetryStatus: (...params) =>
      run(
        "UPDATE memories SET embedding=?,index_status='retry' WHERE id=? AND org_id=?",
        ...params,
      ),
    setMemoryIndexState: (...params) =>
      run(
        'UPDATE memories SET index_status=?,embedding=COALESCE(?,embedding),embedding_model=COALESCE(?,embedding_model),embedding_dimensions=COALESCE(?,embedding_dimensions) WHERE id=? AND org_id=?',
        ...params,
      ),
    findManyMemoryByEmbedding: (...params) =>
      all(
        "SELECT id,org_id,employee_id,kind,title,source,confidence,created_at,embedding FROM memories WHERE embedding IS NOT NULL ORDER BY org_id,created_at",
        ...params,
      ),
    updateMemoryByIdAndOrgIdSetEmbedding: (...params) =>
      run(
        "UPDATE memories SET embedding=NULL WHERE id=? AND org_id=?",
        ...params,
      ),
  };
}
