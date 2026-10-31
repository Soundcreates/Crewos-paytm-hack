/** Schedule claims, cursor advances and task creation share a database transaction. */
export function createSchedulesRepository({ all, get, run }) {
  return {
    list: (orgId) => all(`SELECT s.*,e.name AS employee_name,u.name AS creator_name FROM work_schedules s
      JOIN employees e ON e.id=s.employee_id JOIN users u ON u.id=s.created_by
      WHERE s.org_id=? AND s.status<>'archived' ORDER BY s.created_at DESC,s.id`, orgId),
    find: (orgId, scheduleId) => get('SELECT * FROM work_schedules WHERE org_id=? AND id=?', orgId, scheduleId),
    employee: (orgId, employeeId) => get('SELECT state FROM employees WHERE org_id=? AND id=?', orgId, employeeId),
    role: (orgId, userId) => get('SELECT role FROM memberships WHERE org_id=? AND user_id=?', orgId, userId),
    insert: (...params) => run(`INSERT INTO work_schedules
      (id,org_id,employee_id,created_by,name,goal,kind,cron,interval_minutes,timezone,next_run_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, ...params),
    update: (...params) => run(`UPDATE work_schedules SET employee_id=?,created_by=?,name=?,goal=?,kind=?,cron=?,interval_minutes=?,timezone=?,next_run_at=?,last_error=NULL,revision=revision+1,updated_at=?
      WHERE org_id=? AND id=? AND revision=? AND status<>'archived'`, ...params),
    setStatus: (...params) => run(`UPDATE work_schedules SET status=?,created_by=?,next_run_at=?,last_error=NULL,revision=revision+1,updated_at=?
      WHERE org_id=? AND id=? AND revision=? AND status<>'archived'`, ...params),
    history: (orgId, scheduleId) => all(`SELECT r.id,r.due_at,r.created_at,r.workflow_id,r.error,
      COALESCE(w.status,r.status) AS status FROM schedule_runs r LEFT JOIN workflows w ON w.id=r.workflow_id AND w.org_id=r.org_id
      WHERE r.org_id=? AND r.schedule_id=? ORDER BY r.created_at DESC,r.due_at DESC LIMIT 50`, orgId, scheduleId),
    due: (timestamp) => all("SELECT * FROM work_schedules WHERE status='active' AND next_run_at<=? ORDER BY next_run_at,id LIMIT 25", timestamp),
    advance: (...params) => run(`UPDATE work_schedules SET next_run_at=?,last_run_at=?,updated_at=?
      WHERE id=? AND org_id=? AND status='active' AND next_run_at=? AND revision=?`, ...params),
    workflowStatus: (orgId, workflowId) => get('SELECT status FROM workflows WHERE org_id=? AND id=?', orgId, workflowId),
    recordRun: (...params) => run('INSERT INTO schedule_runs(id,org_id,schedule_id,due_at,status,workflow_id,error,created_at) VALUES(?,?,?,?,?,?,?,?)', ...params),
    recordResult: (...params) => run(`UPDATE work_schedules SET last_error=?,last_workflow_id=COALESCE(?,last_workflow_id),
      status=CASE WHEN ?=1 THEN 'paused' ELSE status END WHERE id=? AND org_id=?`, ...params),
  };
}
