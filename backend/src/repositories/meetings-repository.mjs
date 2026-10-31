/** SQL access for the meetings domain. Business logic should call these named operations. */
export function createMeetingsRepository({ all, get, run }) {
  return {
    transitionMeetingLease: (status, decisions, updatedAt, meetingId, orgId, workerId) => {
      const includeDecisions = decisions !== undefined;
      return run(`UPDATE meetings SET status=?,${includeDecisions ? 'decisions=?,' : ''}meeting_worker_id=NULL,meeting_lease_expires_at=NULL,updated_at=?
        WHERE id=? AND org_id=? AND status IN ('preparing','discussing','in_meeting') AND meeting_worker_id=?`,
      ...(includeDecisions ? [status, JSON.stringify(decisions)] : [status]), updatedAt, meetingId, orgId, workerId);
    },
    updateMeetingByIdAndOrgIdAndStatus: (...params) =>
      run(
        "UPDATE meetings SET status=CASE WHEN status='preparing' THEN 'scheduled' ELSE 'briefing' END,\n    meeting_worker_id=NULL,meeting_lease_expires_at=NULL,updated_at=?\n    WHERE id=? AND org_id=? AND status IN ('preparing','discussing','in_meeting')\n    AND ((meeting_lease_expires_at IS NOT NULL AND meeting_lease_expires_at<=?)\n      OR (meeting_lease_expires_at IS NULL AND updated_at<=?))",
        ...params,
      ),
    updateMeetingByIdAndOrgIdAndStatusSetStatusMeetingWorkerIdMeetingLeaseExpiresAt: (...params) =>
      run(
        "UPDATE meetings SET status=?,meeting_worker_id=?,meeting_lease_expires_at=?,updated_at=?\n    WHERE id=? AND org_id=? AND status=?",
        ...params,
      ),
    updateMeetingByIdAndOrgIdAndStatusSetMeetingLeaseExpiresAt: (...params) =>
      run(
        "UPDATE meetings SET meeting_lease_expires_at=? WHERE id=? AND org_id=? AND status IN (\"preparing\",\"discussing\",\"in_meeting\") AND meeting_worker_id=?",
        ...params,
      ),
    findOneMeetingByIdAndOrgId: (...params) =>
      get(
        "SELECT id FROM meetings WHERE id=? AND org_id=?",
        ...params,
      ),
    findOneMeetingByIdAndOrgIdSelectParticipantIds: (...params) =>
      get(
        "SELECT participant_ids FROM meetings WHERE id=? AND org_id=?",
        ...params,
      ),
    findManyMeetingByOrgId: (...params) =>
      all(
        "SELECT * FROM meetings WHERE org_id=? ORDER BY created_at DESC LIMIT 100",
        ...params,
      ),
    insertMeeting: (...params) =>
      run(
        "INSERT INTO meetings(id,org_id,title,agenda,participant_ids,status,created_by,starts_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ...params,
      ),
    findOneMeetingByIdAndOrgIdSelectAllFields: (...params) =>
      get(
        "SELECT * FROM meetings WHERE id=? AND org_id=?",
        ...params,
      ),
    findManyMeetingBriefByMeetingId: (...params) =>
      all(
        "SELECT b.*,e.name AS employee_name FROM meeting_briefs b JOIN employees e ON e.id=b.employee_id WHERE b.meeting_id=? ORDER BY e.name",
        ...params,
      ),
    findOneMeetingByIdAndOrgIdSelectIdStatus: (...params) =>
      get(
        "SELECT id,status FROM meetings WHERE id=? AND org_id=?",
        ...params,
      ),
    insertMeetingBrief: (...params) =>
      run(
        "INSERT INTO meeting_briefs(id,meeting_id,employee_id,brief,source_memory_ids,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(meeting_id,employee_id) DO UPDATE SET brief=excluded.brief,source_memory_ids=excluded.source_memory_ids,created_at=excluded.created_at",
        ...params,
      ),
    findManyMeetingBriefByMeetingIdSelectEmployeeIdBriefSourceMemoryIds: (...params) =>
      all(
        "SELECT employee_id,brief,source_memory_ids FROM meeting_briefs WHERE meeting_id=?",
        ...params,
      ),
    findManyMeetingBriefByMeetingIdSelectEmployeeIdNameBrief: (...params) =>
      all(
        "SELECT b.employee_id,e.name,b.brief,b.source_memory_ids FROM meeting_briefs b JOIN employees e ON e.id=b.employee_id WHERE b.meeting_id=?",
        ...params,
      ),
    updateMeetingByIdAndOrgIdAndStatusSetStatusDecisionsMeetingWorkerId: (...params) =>
      run(
        "UPDATE meetings SET status=\"completed\",decisions=?,meeting_worker_id=NULL,meeting_lease_expires_at=NULL,updated_at=? WHERE id=? AND org_id=? AND status=\"in_meeting\" AND meeting_worker_id=?",
        ...params,
      ),
    findManyMeetingByOrgIdAndStatus: (...params) =>
      all(
        "SELECT participant_ids FROM meetings WHERE org_id=? AND status IN (\"briefing\",\"in_meeting\")",
        ...params,
      ),
    findManyMeetingByOrgIdAndStatusSelectIdTitleStatus: (...params) =>
      all(
        "SELECT id,title,status,participant_ids FROM meetings WHERE org_id=? AND status IN (\"scheduled\",\"briefing\",\"in_meeting\") ORDER BY created_at DESC LIMIT 10",
        ...params,
      ),
    findOneMeetingByOrgIdAndId: (...params) =>
      get(
        "SELECT * FROM meetings WHERE org_id=? AND id=?",
        ...params,
      ),
    findManyMeetingBriefByMeetingIdSelectEmployeeidBrief: (...params) =>
      all(
        "SELECT employee_id AS employeeId,brief FROM meeting_briefs WHERE meeting_id=?",
        ...params,
      ),
    findOneMeetingByIdAndOrgIdSelectStatusTitleAgenda: (...params) =>
      get(
        "SELECT status,title,agenda,decisions FROM meetings WHERE id=? AND org_id=?",
        ...params,
      ),
  };
}
