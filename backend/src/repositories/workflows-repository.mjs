/** SQL access for the workflows domain. Business logic should call these named operations. */
export function createWorkflowsRepository({ all, get, run }) {
  return {
    refreshWorkflowLease: (expiresAt, updatedAt, workflowId, orgId, workerId, generation) => run(
      `UPDATE workflows SET lease_expires_at=?,updated_at=? WHERE id=? AND org_id=? AND status='working' AND worker_id=?${Number.isInteger(generation) ? ' AND lease_generation=?' : ''}`,
      expiresAt, updatedAt, workflowId, orgId, workerId, ...(Number.isInteger(generation) ? [generation] : []),
    ),
    updateWorkflowRecord: ({ workflowId, orgId, updates, workerId, leaseGeneration, requireWorking }) => {
      const allowed = new Set(['status', 'plan', 'step_index', 'result', 'error', 'input_requests', 'input_responses', 'started_at', 'finished_at', 'updated_at', 'worker_id', 'lease_expires_at']);
      const keys = Object.keys(updates).filter((key) => allowed.has(key));
      if (!keys.length) return null;
      const values = keys.map((key) => ['plan', 'result', 'input_requests', 'input_responses'].includes(key) && typeof updates[key] !== 'string' ? JSON.stringify(updates[key]) : updates[key]);
      const leaseFence = Number.isInteger(leaseGeneration)
        ? requireWorking ? " AND status='working' AND worker_id=? AND lease_generation=?" : ' AND lease_generation=?'
        : '';
      const leaseValues = Number.isInteger(leaseGeneration) ? requireWorking ? [workerId, leaseGeneration] : [leaseGeneration] : [];
      return run(`UPDATE workflows SET ${keys.map((key) => `${key}=?`).join(',')} WHERE id=? AND org_id=?${leaseFence}`,
        ...values, workflowId, orgId, ...leaseValues);
    },
    insertEvent: (...params) =>
      run(
        "INSERT INTO events(id,org_id,workflow_id,employee_id,actor_id,kind,detail,created_at) VALUES(?,?,?,?,?,?,?,?)",
        ...params,
      ),
    findOneToolRunByWorkflowIdAndStepIndex: (...params) =>
      get(
        "SELECT output FROM tool_runs WHERE workflow_id=? AND step_index=?",
        ...params,
      ),
    findOneWorkflowByIdAndOrgId: (...params) =>
      get(
        "SELECT * FROM workflows WHERE id=? AND org_id=?",
        ...params,
      ),
    findManyToolRunByOrgIdAndWorkflowId: (...params) =>
      all(
        "SELECT id,tool,status,created_at FROM tool_runs WHERE org_id=? AND workflow_id=? ORDER BY created_at",
        ...params,
      ),
    findOneWorkflowByIdAndOrgIdSelectWEmployeeName: (...params) =>
      get(
        "SELECT w.*,e.name AS employee_name FROM workflows w JOIN employees e ON e.id=w.employee_id WHERE w.id=? AND w.org_id=?",
        ...params,
      ),
    findManyToolRunByOrgIdAndWorkflowIdSelectIdStepIndexTool: (...params) =>
      all(
        "SELECT id,step_index,tool,input,output,status,attempt_count,duration_ms,created_at FROM tool_runs WHERE org_id=? AND workflow_id=? ORDER BY step_index,created_at,id LIMIT 100",
        ...params,
      ),
    findManyEventByOrgIdAndWorkflowId: (...params) =>
      all(
        "SELECT id,kind,detail,created_at FROM events WHERE org_id=? AND workflow_id=? ORDER BY created_at,id LIMIT 200",
        ...params,
      ),
    findManyWorkflowByOrgIdAndEmployeeId: (...params) =>
      all(
        "SELECT id,goal,status,error,created_at,updated_at FROM workflows WHERE org_id=? AND employee_id=? ORDER BY created_at DESC LIMIT 12",
        ...params,
      ),
    updateActionItemByOrgIdAndWorkflowId: (...params) =>
      run(
        "UPDATE action_items SET status=? WHERE org_id=? AND workflow_id=?",
        ...params,
      ),
    updateApprovalByOrgIdAndWorkflowIdAndState: (...params) =>
      run(
        "UPDATE approvals SET state='expired' WHERE org_id=? AND workflow_id=? AND state='pending'",
        ...params,
      ),
    updateWorkflowByIdAndOrgIdAndStatus: (...params) =>
      run(
        "UPDATE workflows SET input_responses=?,input_requests=?,status=?,error=?,finished_at=?,worker_id=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND org_id=? AND status='input_required'",
        ...params,
      ),
    insertWorkflowByIdempotencyKey: (...params) =>
      run(
        "INSERT INTO workflows(id,org_id,employee_id,created_by,goal,status,runtime_version,plan,spec_version,deployment_id,idempotency_key,origin,created_at,updated_at)\n    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(org_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING",
        ...params,
      ),
    insertWorkflowByServicePrincipal: (...params) => run(
      `INSERT INTO workflows(id,org_id,employee_id,created_by,goal,status,runtime_version,plan,spec_version,deployment_id,idempotency_key,origin,created_by_principal_id,origin_subscription_id,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(org_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
      ...params,
    ),
    findOneWorkflowByOrgIdAndIdempotencyKey: (...params) =>
      get(
        "SELECT * FROM workflows WHERE org_id=? AND idempotency_key=?",
        ...params,
      ),
    findOneWorkflowByOrgIdAndId: (...params) =>
      get(
        "SELECT * FROM workflows WHERE org_id=? AND id=?",
        ...params,
      ),
    findOneWorkflowByOrgIdAndEmployeeIdAndId: (...params) =>
      get(
        "SELECT id FROM workflows WHERE org_id=? AND employee_id=? AND id<>? AND status='working' AND lease_expires_at>? LIMIT 1",
        ...params,
      ),
    updateWorkflowByIdAndOrgIdAndStatusSetStatusLeaseGenerationStartedAt: (...params) =>
      run(
        "UPDATE workflows SET status='working',lease_generation=lease_generation+1,started_at=COALESCE(started_at,?),worker_id=?,lease_expires_at=?,updated_at=?\n      WHERE id=? AND org_id=? AND (\n        (status='queued' AND NOT EXISTS (\n          SELECT 1 FROM tool_runs t WHERE t.workflow_id=workflows.id AND t.step_index=workflows.step_index\n          AND t.status='retry_wait' AND (t.retry_at IS NULL OR t.retry_at>?)\n        )) OR (status='working' AND (lease_expires_at IS NULL OR lease_expires_at<=?))\n      )",
        ...params,
      ),
    findOneWorkflowByIdAndOrgIdSelectStatusWorkerIdStepIndex: (...params) =>
      get(
        "SELECT status,worker_id,step_index FROM workflows WHERE id=? AND org_id=?",
        ...params,
      ),
    updateToolRunByIdAndStatusAndAttemptCount: (...params) =>
      run(
        "UPDATE tool_runs SET status='retry_wait',attempt_count=?,retry_at=?,output=?\n      WHERE id=? AND status=? AND attempt_count=?",
        ...params,
      ),
    updateWorkflowByIdAndOrgIdAndStatusSetStatusWorkerIdLeaseExpiresAt: (...params) =>
      run(
        "UPDATE workflows SET status='queued',worker_id=NULL,lease_expires_at=NULL,updated_at=?\n      WHERE id=? AND org_id=? AND status='working' AND worker_id=? AND step_index=?",
        ...params,
      ),
    findOneWorkflowByIdAndOrgIdSelectStatusWorkerIdEmployeeId: (...params) =>
      get(
        "SELECT status,worker_id,employee_id,goal FROM workflows WHERE id=? AND org_id=?",
        ...params,
      ),
    findManyToolRunByOrgIdAndWorkflowIdSelectToolStatus: (...params) =>
      all(
        "SELECT tool,status FROM tool_runs WHERE org_id=? AND workflow_id=? ORDER BY created_at,id",
        ...params,
      ),
    findManyWorkflowByStatusAndWorkflowIdAndStepIndex: (...params) =>
      all(
        "SELECT id,org_id FROM workflows WHERE\n      (status='queued' AND NOT EXISTS (\n        SELECT 1 FROM tool_runs t WHERE t.workflow_id=workflows.id AND t.step_index=workflows.step_index\n        AND t.status='retry_wait' AND (t.retry_at IS NULL OR t.retry_at>?)\n      )) OR (status='working' AND (lease_expires_at IS NULL OR lease_expires_at<=?))\n      ORDER BY created_at LIMIT ?",
        ...params,
      ),
    findOneApprovalByOrgIdAndWorkflowIdAndRequestKey: (...params) =>
      get(
        "SELECT id FROM approvals WHERE org_id=? AND workflow_id=? AND request_key=? AND fingerprint=? AND state='approved' AND expires_at>?",
        ...params,
      ),
    findOneToolRunByWorkflowIdAndStepIndexSelectAllFields: (...params) =>
      get(
        "SELECT * FROM tool_runs WHERE workflow_id=? AND step_index=?",
        ...params,
      ),
    updateToolRunByIdAndStatus: (...params) =>
      run(
        "UPDATE tool_runs SET status='started',retry_at=NULL WHERE id=? AND status=?",
        ...params,
      ),
    updateToolRunByIdAndStatusAndAttemptCountSetStatusRetryAtOutput: (...params) =>
      run(
        "UPDATE tool_runs SET status='started',retry_at=NULL,output=NULL\n        WHERE id=? AND status='retry_wait' AND attempt_count=? AND retry_at<=?",
        ...params,
      ),
    updateToolRunById: (...params) =>
      run(
        "UPDATE tool_runs SET status='failed',retry_at=NULL,output=? WHERE id=?",
        ...params,
      ),
    updateToolRunByIdSetStatusOutputVerification: (...params) =>
      run(
        "UPDATE tool_runs SET status='completed',output=?,verification=?,lease_generation=? WHERE id=?",
        ...params,
      ),
    insertToolRun: (...params) =>
      run(
        "INSERT INTO tool_runs(id,org_id,workflow_id,step_index,tool,input,status,attempt_count,operation_id,lease_generation,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        ...params,
      ),
    updateToolRunByIdSetLeaseGenerationOperationId: (...params) =>
      run(
        "UPDATE tool_runs SET lease_generation=?,operation_id=COALESCE(operation_id,id) WHERE id=?",
        ...params,
      ),
    updateToolRunByIdAndStatusSetOutput: (...params) =>
      run(
        "UPDATE tool_runs SET output=? WHERE id=? AND status=?",
        ...params,
      ),
    updateToolRunByIdAndStatusSetStatusRetryAtOutput: (...params) =>
      run(
        "UPDATE tool_runs SET status='retry_wait',retry_at=?,output=? WHERE id=? AND status='started'",
        ...params,
      ),
    updateToolRunByIdAndLeaseGenerationAndWorkerId: (...params) =>
      run(
        "UPDATE tool_runs SET status='completed',output=?,duration_ms=?,retry_at=NULL WHERE id=? AND lease_generation=? AND EXISTS(SELECT 1 FROM workflows WHERE id=? AND worker_id=? AND lease_generation=? AND status='working')",
        ...params,
      ),
    updateToolRunByIdAndLeaseGeneration: (...params) =>
      run(
        "UPDATE tool_runs SET status=?,output=?,duration_ms=?,retry_at=NULL WHERE id=? AND lease_generation=?",
        ...params,
      ),
    updateToolRunByOrgIdAndWorkflowIdAndStepIndex: (...params) =>
      run(
        "UPDATE tool_runs SET verification=? WHERE org_id=? AND workflow_id=? AND step_index=?",
        ...params,
      ),
    findOneToolRunByOrgIdAndWorkflowIdAndStepIndex: (...params) =>
      get(
        "SELECT id FROM tool_runs WHERE org_id=? AND workflow_id=? AND step_index=?",
        ...params,
      ),
    insertWorkflowArtifact: (...params) =>
      run(
        "INSERT INTO workflow_artifacts(id,org_id,workflow_id,operation_id,provider,external_id,title,url,evidence,created_at)\n      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id) DO NOTHING",
        ...params,
      ),
    findManyEventByOrgIdAndWorkflowIdAndKind: (...params) =>
      all(
        "SELECT detail FROM events WHERE org_id=? AND workflow_id=? AND kind=\"verifier.passed\" ORDER BY created_at LIMIT 100",
        ...params,
      ),
    findManyWorkflowByOrgIdAndEmployeeIdAndStatus: (...params) =>
      all(
        "SELECT id FROM workflows WHERE org_id=? AND employee_id=? AND status IN ('queued','working','input_required')",
        ...params,
      ),
    updateWorkflowByOrgIdAndEmployeeIdAndStatus: (...params) =>
      run(
        "UPDATE workflows SET status='cancelled',error='Employee archived.',finished_at=?,updated_at=?,worker_id=NULL,lease_expires_at=NULL\n        WHERE org_id=? AND employee_id=? AND status IN ('queued','working','input_required')",
        ...params,
      ),
    findManyWorkflowByOrgId: (...params) =>
      all(
        "SELECT w.*,e.name AS employee_name FROM workflows w JOIN employees e ON e.id=w.employee_id WHERE w.org_id=? ORDER BY w.created_at DESC LIMIT 100",
        ...params,
      ),
    updateToolRunByWorkflowIdAndStepIndex: (...params) =>
      run(
        "UPDATE tool_runs SET status='failed',retry_at=NULL,output=? WHERE workflow_id=? AND step_index=?",
        ...params,
      ),
    updateToolRunByWorkflowIdAndStepIndexSetStatusRetryAtOutput: (...params) =>
      run(
        "UPDATE tool_runs SET status='retry_wait',retry_at=?,output=? WHERE workflow_id=? AND step_index=?",
        ...params,
      ),
    findOneToolRunByOrgIdAndWorkflowIdAndStepIndexSelectAllFields: (...params) =>
      get(
        "SELECT * FROM tool_runs WHERE org_id=? AND workflow_id=? AND step_index=?",
        ...params,
      ),
    updateWorkflowByIdAndOrgIdAndStatusSetStatusErrorUpdatedAt: (...params) =>
      run(
        "UPDATE workflows SET status='queued',error=NULL,updated_at=? WHERE id=? AND org_id=? AND status='reconciliation_required'",
        ...params,
      ),
    updateToolRunByIdAndOrgId: (...params) =>
      run(
        "UPDATE tool_runs SET status='completed',output=?,verification=? WHERE id=? AND org_id=?",
        ...params,
      ),
    findOneToolRunByIdAndOrgId: (...params) =>
      get(
        "SELECT workflow_id,step_index,tool,input,output,status,duration_ms,created_at FROM tool_runs WHERE id=? AND org_id=?",
        ...params,
      ),
    findOneToolRunByOrgIdAndWorkflowIdAndTool: (...params) =>
      get(
        "SELECT output FROM tool_runs WHERE org_id=? AND workflow_id=? AND tool='solari.browser.open' AND status='completed' AND step_index<? AND output IS NOT NULL ORDER BY step_index DESC LIMIT 1",
        ...params,
      ),
    findManyAgentMessageByOrgIdAndMeetingId: (...params) =>
      all(
        "SELECT m.*,f.name AS from_name,t.name AS to_name FROM agent_messages m LEFT JOIN employees f ON f.id=m.from_employee_id LEFT JOIN employees t ON t.id=m.to_employee_id WHERE m.org_id=? AND m.meeting_id=? ORDER BY m.created_at",
        ...params,
      ),
    findManyAgentMessageByOrgId: (...params) =>
      all(
        "SELECT m.*,f.name AS from_name,t.name AS to_name FROM agent_messages m LEFT JOIN employees f ON f.id=m.from_employee_id LEFT JOIN employees t ON t.id=m.to_employee_id WHERE m.org_id=? ORDER BY m.created_at DESC LIMIT 100",
        ...params,
      ),
    insertAgentMessage: (...params) =>
      run(
        "INSERT INTO agent_messages(id,org_id,meeting_id,from_employee_id,to_employee_id,body,evidence_ids,kind,type,delegation_goal,delegation_status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        ...params,
      ),
    findOneAgentMessageByIdAndOrgIdAndType: (...params) =>
      get(
        "SELECT * FROM agent_messages WHERE id=? AND org_id=? AND type=?",
        ...params,
      ),
    updateAgentMessageByIdAndOrgIdAndDelegationStatus: (...params) =>
      run(
        "UPDATE agent_messages SET delegation_status='declined' WHERE id=? AND org_id=? AND delegation_status='pending'",
        ...params,
      ),
    updateAgentMessageByIdAndOrgIdAndDelegationStatusSetDelegationStatus: (...params) =>
      run(
        "UPDATE agent_messages SET delegation_status='accepted' WHERE id=? AND org_id=? AND delegation_status='pending'",
        ...params,
      ),
    updateAgentMessageByIdAndOrgIdAndDelegationStatusSetWorkflowId: (...params) =>
      run(
        "UPDATE agent_messages SET workflow_id=? WHERE id=? AND org_id=? AND delegation_status=?",
        ...params,
      ),
    findManyAgentMessageByOrgIdAndMeetingIdSelectMFromNameToName: (...params) =>
      all(
        "SELECT m.*,f.name AS from_name,t.name AS to_name FROM agent_messages m LEFT JOIN employees f ON f.id=m.from_employee_id LEFT JOIN employees t ON t.id=m.to_employee_id WHERE m.org_id=? AND m.meeting_id=? ORDER BY m.created_at,m.id",
        ...params,
      ),
    findManyActionItemByOrgIdAndMeetingId: (...params) =>
      all(
        "SELECT a.*,w.status AS workflow_status,e.state AS employee_state FROM action_items a LEFT JOIN workflows w ON w.id=a.workflow_id LEFT JOIN employees e ON e.id=a.employee_id WHERE a.org_id=? AND a.meeting_id=? ORDER BY a.created_at",
        ...params,
      ),
    insertActionItem: (...params) =>
      run(
        "INSERT INTO action_items(id,org_id,meeting_id,employee_id,workflow_id,title,status,created_at) VALUES(?,?,?,?,?,?,?,?)",
        ...params,
      ),
    findOneAgentMessageByMeetingIdAndFromEmployeeIdAndKind: (...params) =>
      get(
        "SELECT id FROM agent_messages WHERE meeting_id=? AND from_employee_id=? AND kind=?",
        ...params,
      ),
    findManyAgentMessageByOrgIdAndMeetingIdSelectFromEmployeeIdToEmployeeIdBody: (...params) =>
      all(
        "SELECT m.from_employee_id,m.to_employee_id,m.body,m.evidence_ids,m.type,m.delegation_goal,f.name AS from_name,t.name AS to_name FROM agent_messages m LEFT JOIN employees f ON f.id=m.from_employee_id LEFT JOIN employees t ON t.id=m.to_employee_id WHERE m.org_id=? AND m.meeting_id=? ORDER BY m.created_at DESC LIMIT 20",
        ...params,
      ),
    insertAgentMessageWithIdOrgIdMeetingId: (...params) =>
      run(
        "INSERT OR IGNORE INTO agent_messages(id,org_id,meeting_id,from_employee_id,to_employee_id,body,evidence_ids,kind,type,delegation_goal,delegation_status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        ...params,
      ),
    findManyAgentMessageByOrgIdAndMeetingIdAndKind: (...params) =>
      all(
        "SELECT m.*,f.name AS from_name,t.name AS to_name FROM agent_messages m LEFT JOIN employees f ON f.id=m.from_employee_id LEFT JOIN employees t ON t.id=m.to_employee_id WHERE m.org_id=? AND m.meeting_id=? AND m.kind=? ORDER BY m.created_at",
        ...params,
      ),
    findManyAgentMessageByOrgIdAndMeetingIdSelectIdFromEmployeeIdToEmployeeId: (...params) =>
      all(
        "SELECT m.id,m.from_employee_id,m.to_employee_id,m.body,m.evidence_ids,m.kind,m.type,m.delegation_goal,m.delegation_status,m.workflow_id,f.name AS from_name,t.name AS to_name\n      FROM agent_messages m\n      LEFT JOIN employees f ON f.id=m.from_employee_id AND f.org_id=m.org_id\n      LEFT JOIN employees t ON t.id=m.to_employee_id AND t.org_id=m.org_id\n      WHERE m.org_id=? AND m.meeting_id=? ORDER BY m.created_at,m.id",
        ...params,
      ),
    insertAgentMeetingTurnMessage: (...params) =>
      run(
        "INSERT INTO agent_messages(id,org_id,meeting_id,from_employee_id,body,evidence_ids,kind,created_at) VALUES(?,?,?,?,?,?,?,?)",
        ...params,
      ),
    findOneActionItemByIdAndOrgId: (...params) =>
      get(
        "SELECT * FROM action_items WHERE id=? AND org_id=?",
        ...params,
      ),
    findManyAgentMessageByOrgIdAndMeetingIdSelectBody: (...params) =>
      all(
        "SELECT body FROM agent_messages WHERE org_id=? AND meeting_id=? ORDER BY created_at DESC LIMIT 8",
        ...params,
      ),
    updateActionItemByIdAndOrgIdAndStatus: (...params) =>
      run(
        "UPDATE action_items SET status=\"in_progress\" WHERE id=? AND org_id=? AND status=\"open\" AND workflow_id IS NULL",
        ...params,
      ),
    updateActionItemByIdAndOrgIdAndWorkflowId: (...params) =>
      run(
        "UPDATE action_items SET workflow_id=? WHERE id=? AND org_id=? AND workflow_id IS NULL",
        ...params,
      ),
    updateActionItemByIdAndOrgIdAndStatusSetStatusEmployeeId: (...params) =>
      run(
        "UPDATE action_items SET status=?,employee_id=? WHERE id=? AND org_id=? AND status=\"open\" AND workflow_id IS NULL",
        ...params,
      ),
    updateActionItemByIdAndOrgId: (...params) =>
      run(
        "UPDATE action_items SET status=? WHERE id=? AND org_id=?",
        ...params,
      ),
    findManyWorkflowByOrgIdAndStatus: (...params) =>
      all(
        "SELECT employee_id,status FROM workflows WHERE org_id=? AND status IN (\"queued\",\"working\",\"input_required\")",
        ...params,
      ),
    findManyWorkflowArtifactByOrgId: (...params) =>
      all(
        "SELECT a.id,a.title,a.external_id,a.url,'verified' AS status,a.created_at,e.name AS employee_name FROM workflow_artifacts a JOIN workflows w ON w.id=a.workflow_id AND w.org_id=a.org_id JOIN employees e ON e.id=w.employee_id WHERE a.org_id=? ORDER BY a.created_at DESC LIMIT 100",
        ...params,
      ),
    findManyEventByOrgId: (...params) =>
      all(
        "SELECT e.*,u.name AS actor_name,a.name AS employee_name FROM events e LEFT JOIN users u ON u.id=e.actor_id LEFT JOIN employees a ON a.id=e.employee_id WHERE e.org_id=? ORDER BY e.created_at DESC LIMIT ?",
        ...params,
      ),
    findManyToolRunByOrgIdAndToolAndStatus: (...params) =>
      all(
        "SELECT output,created_at FROM tool_runs WHERE org_id=? AND tool='solari.browser.open' AND status='completed' ORDER BY created_at DESC LIMIT 100",
        ...params,
      ),
    findOneWorkflowByOrgId: (...params) =>
      get(
        "SELECT COUNT(*) AS total,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,SUM(CASE WHEN status='input_required' THEN 1 ELSE 0 END) AS approvals FROM workflows WHERE org_id=?",
        ...params,
      ),
    findManyToolRunByOrgId: (...params) =>
      all(
        "SELECT tool,COUNT(*) AS calls,AVG(duration_ms) AS avg_ms FROM tool_runs WHERE org_id=? GROUP BY tool ORDER BY calls DESC",
        ...params,
      ),
    findOneWorkflowByOrgIdAndStatusAndFinishedAt: (...params) =>
      get(
        "SELECT AVG((julianday(finished_at)-julianday(started_at))*86400000) AS average_ms FROM workflows WHERE org_id=? AND status=\"completed\" AND finished_at IS NOT NULL",
        ...params,
      ),
    findManyToolRunByOrgIdAndTool: (...params) =>
      all(
        "SELECT tool,COUNT(*) AS calls,AVG(duration_ms) AS averageMs FROM tool_runs WHERE org_id=? AND tool LIKE \"solari.%\" GROUP BY tool ORDER BY calls DESC",
        ...params,
      ),
    findManyEventByOrgIdAndKind: (...params) =>
      all(
        "SELECT detail FROM events WHERE org_id=? AND kind IN (\"solari.simulation.tool.completed\",\"solari.simulation.tool.failed\")",
        ...params,
      ),
    findManyToolRunByOrgIdAndToolSelectWorkflowIdToolOutput: (...params) =>
      all(
        "SELECT workflow_id,tool,output FROM tool_runs WHERE org_id=? AND tool IN (\"solari.browser.open\",\"solari.sandbox.echo\")",
        ...params,
      ),
    findManyAgentMessageByOrgIdAndMeetingIdAndKindSelectId: (...params) =>
      all(
        "SELECT id FROM agent_messages WHERE org_id=? AND meeting_id=? AND kind='pre_meeting'",
        ...params,
      ),
    findManyWorkflowByStatusAndStateAndExpiresAt: (...params) =>
      all(
        "SELECT DISTINCT w.id,w.org_id,w.employee_id FROM workflows w JOIN approvals a ON a.workflow_id=w.id AND a.org_id=w.org_id WHERE w.status='input_required' AND a.state='pending' AND a.expires_at<=? LIMIT 20",
        ...params,
      ),
    updateWorkflowByIdAndOrgIdAndStatusSetStatusErrorFinishedAt: (...params) =>
      run(
        "UPDATE workflows SET status='failed',error='Manager approval expired.',finished_at=?,updated_at=? WHERE id=? AND org_id=? AND status='input_required'",
        ...params,
      ),
    updateApprovalByWorkflowIdAndOrgIdAndState: (...params) =>
      run(
        "UPDATE approvals SET state='expired' WHERE workflow_id=? AND org_id=? AND state='pending'",
        ...params,
      ),
    insertApproval: (...params) =>
      run(
        "INSERT INTO approvals(id,org_id,workflow_id,request_key,fingerprint,request,created_at,expires_at)\n    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(workflow_id,request_key,fingerprint) DO NOTHING",
        ...params,
      ),
    findOneApprovalByOrgIdAndWorkflowIdAndRequestKeySelectIdExpiresAt: (...params) =>
      get(
        "SELECT id,expires_at FROM approvals WHERE org_id=? AND workflow_id=? AND request_key=? AND fingerprint=?",
        ...params,
      ),
    updateApprovalByIdAndOrgIdAndWorkflowId: (...params) =>
      run(
        "UPDATE approvals SET state=?,response=?,reviewed_by=? WHERE id=? AND org_id=? AND workflow_id=? AND request_key=? AND fingerprint=? AND state='pending' AND expires_at>?",
        ...params,
      ),
    findOneWorkflowByOrgIdAndIdSelectAllFields: (...params) =>
      get(
        "SELECT * FROM workflows WHERE org_id=? AND id=?",
        ...params,
      ),
    findOneWorkflowByOrgIdAndIdSelectIdStatusOrigin: (...params) =>
      get(
        "SELECT id,status,origin,step_index FROM workflows WHERE org_id=? AND id=?",
        ...params,
      ),
    findManyWorkflowArtifactByOrgIdAndWorkflowId: (...params) =>
      all(
        "SELECT external_id,url FROM workflow_artifacts WHERE org_id=? AND workflow_id=?",
        ...params,
      ),
    findOneToolRunByOrgIdAndWorkflowIdAndToolSelectOutput: (...params) =>
      get(
        "SELECT output FROM tool_runs\n    WHERE org_id=? AND workflow_id=? AND tool='solari.browser.open' AND status='completed' AND step_index<?\n    ORDER BY step_index DESC LIMIT 1",
        ...params,
      ),
    findManyWorkflowByOrgIdAndStatusSelectEmployeeIdCompletedFailed: (...params) =>
      all(
        "\n    SELECT employee_id,\n      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,\n      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed\n    FROM workflows WHERE org_id=? AND status IN ('completed','failed') GROUP BY employee_id\n  ",
        ...params,
      ),
    findOneWorkflowByEmployeeId: (...params) =>
      get(
        "SELECT id,goal,status,updated_at FROM workflows WHERE employee_id=? ORDER BY created_at DESC LIMIT 1",
        ...params,
      ),
    findOneWorkflowByOrgIdAndStatus: (...params) =>
      get(
        "SELECT COUNT(*) AS count FROM workflows WHERE org_id=? AND status=\"input_required\"",
        ...params,
      ),
    findOneWorkflowByOrgIdAndStatusSelectCount: (...params) =>
      get(
        "SELECT COUNT(*) AS count FROM workflows WHERE org_id=? AND status IN (\"working\",\"queued\")",
        ...params,
      ),
    findOneWorkflowByOrgIdSelectCompletedFailed: (...params) =>
      get(
        "SELECT SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed FROM workflows WHERE org_id=?",
        ...params,
      ),
    findManyEventByOrgIdSelectIdKindDetail: (...params) =>
      all(
        "SELECT id,kind,detail,created_at,employee_id,workflow_id FROM events WHERE org_id=? ORDER BY created_at DESC LIMIT 12",
        ...params,
      ),
    findManyWorkflowByOrgIdAndStatusSelectIdGoalEmployeeId: (...params) =>
      all(
        "SELECT id,goal,employee_id,input_requests,created_at FROM workflows WHERE org_id=? AND status=\"input_required\" ORDER BY created_at DESC LIMIT 5",
        ...params,
      ),
    findOneWorkflowByIdAndOrgIdSelectStatusErrorGoal: (...params) =>
      get(
        "SELECT status,error,goal FROM workflows WHERE id=? AND org_id=?",
        ...params,
      ),
    findOneWorkflowByIdAndOrgIdSelectStatusGoalResult: (...params) =>
      get(
        "SELECT status,goal,result FROM workflows WHERE id=? AND org_id=?",
        ...params,
      ),
    findManyAgentMessageByOrgIdAndMeetingIdSelectBodyKindType: (...params) =>
      all(
        "SELECT m.body,m.kind,m.type,m.delegation_goal,f.name AS from_name,t.name AS to_name FROM agent_messages m\n      LEFT JOIN employees f ON f.id=m.from_employee_id AND f.org_id=m.org_id\n      LEFT JOIN employees t ON t.id=m.to_employee_id AND t.org_id=m.org_id\n      WHERE m.org_id=? AND m.meeting_id=? ORDER BY m.created_at,m.id",
        ...params,
      ),
    findManyToolRunByOrgIdAndWorkflowIdSelectIdStepIndexToolOrderedByStepIndex: (...params) =>
      all(
        "SELECT id,step_index,tool,input,output,status,attempt_count,duration_ms,created_at FROM tool_runs WHERE org_id=? AND workflow_id=? ORDER BY step_index,created_at,id",
        ...params,
      ),
    findManyEventByOrgIdAndWorkflowIdSelectIdKindDetail: (...params) =>
      all(
        "SELECT id,kind,detail,created_at FROM events WHERE org_id=? AND workflow_id=? ORDER BY created_at,id",
        ...params,
      ),
    insertWorkflowSnapshot: (...params) =>
      run(
        "INSERT INTO workflow_snapshots(workflow_id,org_id,schema_version,snapshot,created_at,updated_at)\n    VALUES(?,?,?,?,?,?) ON CONFLICT(workflow_id) DO UPDATE SET schema_version=excluded.schema_version,snapshot=excluded.snapshot,updated_at=excluded.updated_at",
        ...params,
      ),
    findOneWorkflowSnapshotByOrgIdAndWorkflowId: (...params) =>
      get(
        "SELECT schema_version,snapshot,created_at,updated_at FROM workflow_snapshots WHERE org_id=? AND workflow_id=?",
        ...params,
      ),
  };
}
