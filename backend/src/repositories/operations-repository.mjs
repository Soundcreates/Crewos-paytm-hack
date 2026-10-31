/** SQL access for the operations domain. Business logic should call these named operations. */
export function createOperationsRepository({ all, get, run }) {
  return {
    findBackgroundJobSummaryByOrgAndId: (orgId, jobId) =>
      get(
        'SELECT id,kind,status,attempts,error,result,created_at,updated_at FROM background_jobs WHERE org_id=? AND id=?',
        orgId,
        jobId,
      ),
    listBackgroundJobSummariesByOrg: (orgId) =>
      all(
        'SELECT id,kind,status,attempts,error,result,created_at,updated_at FROM background_jobs WHERE org_id=? ORDER BY created_at DESC LIMIT 50',
        orgId,
      ),
    findOneServiceLeaseByNameAndExpiresAt: (...params) =>
      get(
        "SELECT name FROM service_leases WHERE name LIKE 'worker:%' AND expires_at>? LIMIT 1",
        ...params,
      ),
    updateBackgroundJobByIdAndOrgIdAndStatus: (...params) =>
      run(
        "UPDATE background_jobs SET status='queued',attempts=0,error=NULL,available_at=?,updated_at=? WHERE id=? AND org_id=? AND status='failed'",
        ...params,
      ),
    insertServiceLease: (...params) =>
      run(
        "INSERT INTO service_leases(name,owner,expires_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET expires_at=excluded.expires_at",
        ...params,
      ),
    deleteServiceLeaseByNameAndOwner: (...params) =>
      run(
        "DELETE FROM service_leases WHERE name=? AND owner=?",
        ...params,
      ),
    insertBackgroundJob: (...params) =>
      run(
        "INSERT INTO background_jobs(id,org_id,kind,payload,dedupe_key,input_hash,status,available_at,created_at,updated_at)\n    VALUES(?,?,?,?,?,?,'queued',?,?,?) ON CONFLICT(dedupe_key) DO NOTHING",
        ...params,
      ),
    findOneBackgroundJobByOrgIdAndDedupeKey: (...params) =>
      get(
        "SELECT id,status,result,error,input_hash FROM background_jobs WHERE org_id=? AND dedupe_key=?",
        ...params,
      ),
    findManyBackgroundJobByStatusAndAvailableAtAndLeaseExpiresAt: (...params) =>
      all(
        "SELECT id FROM background_jobs WHERE\n    (status='queued' AND available_at<=?) OR (status='working' AND lease_expires_at<=?) ORDER BY created_at LIMIT ?",
        ...params,
      ),
    updateBackgroundJobByIdAndStatusAndAvailableAt: (...params) =>
      run(
        "UPDATE background_jobs SET status='working',lease_owner=?,lease_expires_at=?,attempts=attempts+1,updated_at=?\n      WHERE id=? AND ((status='queued' AND available_at<=?) OR (status='working' AND lease_expires_at<=?))",
        ...params,
      ),
    findOneBackgroundJobByIdAndLeaseOwner: (...params) =>
      get(
        "SELECT * FROM background_jobs WHERE id=? AND lease_owner=?",
        ...params,
      ),
    updateBackgroundJobByIdAndLeaseOwnerAndStatus: (...params) =>
      run(
        "UPDATE background_jobs SET lease_expires_at=? WHERE id=? AND lease_owner=? AND status='working'",
        ...params,
      ),
    updateBackgroundJobByIdAndLeaseOwnerAndStatusSetStatusPayloadResult: (...params) =>
      run(
        "UPDATE background_jobs SET status='completed',payload='{}',result=?,error=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_owner=? AND status='working'",
        ...params,
      ),
    updateBackgroundJobByIdAndLeaseOwnerAndStatusSetStatusErrorAvailableAt: (...params) =>
      run(
        "UPDATE background_jobs SET status=?,error=?,available_at=?,lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_owner=? AND status='working'",
        ...params,
      ),
    insertServiceLeaseByExpiresAt: (...params) =>
      run(
        "INSERT INTO service_leases(name,owner,expires_at) VALUES(?,?,?)\n        ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE service_leases.expires_at<=?",
        ...params,
      ),
  };
}
