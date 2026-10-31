/** SQL access for the simulations domain. Business logic should call these named operations. */
export function createSimulationsRepository({ all, get, run }) {
  return {
    findManySimulationRunByOrgIdAndEmployeeId: (...params) =>
      all(
        "SELECT id,simulation_id,spec_version,status,score,passed,created_at FROM simulation_runs WHERE org_id=? AND employee_id=? ORDER BY created_at DESC LIMIT 12",
        ...params,
      ),
    findOneSimulationByOrgId: (...params) =>
      get(
        "SELECT id FROM simulations WHERE org_id=? LIMIT 1",
        ...params,
      ),
    insertSimulation: (...params) =>
      run(
        "INSERT INTO simulations(id,org_id,name,description,scenario,rubric,threshold,version,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        ...params,
      ),
    insertSimulationVersion: (...params) =>
      run(
        "INSERT INTO simulation_versions(id,org_id,simulation_id,version,name,description,scenario,rubric,threshold,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        ...params,
      ),
    insertSimulatedRefund: (...params) =>
      run(
        "INSERT INTO simulated_refunds(id,org_id,workflow_id,step_index,employee_id,case_id,amount,currency,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ...params,
      ),
    findOneSimulatedRefundByIdAndOrgId: (...params) =>
      get(
        "SELECT id,case_id,amount,currency,status FROM simulated_refunds WHERE id=? AND org_id=?",
        ...params,
      ),
    findOneSimulationRunByIdAndOrgId: (...params) =>
      get(
        "SELECT * FROM simulation_runs WHERE id=? AND org_id=?",
        ...params,
      ),
    insertSimulationRun: (...params) =>
      run(
        "INSERT INTO simulation_runs(id,org_id,simulation_id,suite_version,suite_snapshot,employee_id,spec_version,status,score,passed,evidence,created_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ...params,
      ),
    findOneSimulationRunByOrgIdAndEmployeeIdAndSpecVersion: (...params) =>
      get(
        "SELECT id FROM simulation_runs WHERE org_id=? AND employee_id=? AND spec_version=? AND passed=1 ORDER BY created_at DESC LIMIT 1",
        ...params,
      ),
    findManySimulationByOrgId: (...params) =>
      all(
        "SELECT * FROM simulations WHERE org_id=? ORDER BY created_at DESC",
        ...params,
      ),
    findOneSimulationRunByOrgIdAndSimulationId: (...params) =>
      get(
        "SELECT r.id,r.score,r.passed,r.status,r.suite_version,r.created_at,e.name AS employee_name FROM simulation_runs r JOIN employees e ON e.id=r.employee_id WHERE r.org_id=? AND r.simulation_id=? ORDER BY r.created_at DESC LIMIT 1",
        ...params,
      ),
    findOneSimulationByIdAndOrgId: (...params) =>
      get(
        "SELECT id FROM simulations WHERE id=? AND org_id=?",
        ...params,
      ),
    findManySimulationVersionByOrgIdAndSimulationId: (...params) =>
      all(
        "SELECT * FROM simulation_versions WHERE org_id=? AND simulation_id=? ORDER BY version DESC",
        ...params,
      ),
    findOneProbationRequirementByOrgIdAndSimulationId: (...params) =>
      get(
        "SELECT simulation_id FROM probation_requirements WHERE org_id=? AND simulation_id=?",
        ...params,
      ),
    findOneSimulationByIdAndOrgIdSelectIdVersion: (...params) =>
      get(
        "SELECT id,version FROM simulations WHERE id=? AND org_id=?",
        ...params,
      ),
    updateSimulationByIdAndOrgId: (...params) =>
      run(
        "UPDATE simulations SET name=?,description=?,scenario=?,rubric=?,threshold=?,version=?,updated_at=? WHERE id=? AND org_id=?",
        ...params,
      ),
    findOneSimulationByIdAndOrgIdSelectAllFields: (...params) =>
      get(
        "SELECT * FROM simulations WHERE id=? AND org_id=?",
        ...params,
      ),
    findManySimulationRunByOrgIdAndSimulationId: (...params) =>
      all(
        "SELECT r.*,e.name AS employee_name FROM simulation_runs r JOIN employees e ON e.id=r.employee_id WHERE r.org_id=? AND r.simulation_id=? ORDER BY r.created_at DESC LIMIT 100",
        ...params,
      ),
    findOneSimulationRunByIdAndOrgIdSelectEvidence: (...params) =>
      get(
        "SELECT evidence FROM simulation_runs WHERE id=? AND org_id=?",
        ...params,
      ),
    findManySimulationRunByOrgId: (...params) =>
      all(
        "SELECT evidence,created_at FROM simulation_runs WHERE org_id=? ORDER BY created_at DESC LIMIT 100",
        ...params,
      ),
    findOneSimulationRunByOrgId: (...params) =>
      get(
        "SELECT COUNT(*) AS total,SUM(passed) AS passed,AVG(score) AS average_score FROM simulation_runs WHERE org_id=?",
        ...params,
      ),
    findOneSimulationRunByEmployeeIdAndSpecVersion: (...params) =>
      get(
        "SELECT spec_version,score,passed,created_at FROM simulation_runs WHERE employee_id=? AND spec_version=? ORDER BY created_at DESC LIMIT 1",
        ...params,
      ),
    findManySimulatedRefundByOrgId: (...params) =>
      all(
        "SELECT r.id,r.workflow_id,r.employee_id,r.case_id,r.amount,r.currency,r.status,r.created_at,e.name AS employee_name FROM simulated_refunds r JOIN employees e ON e.id=r.employee_id WHERE r.org_id=? ORDER BY r.created_at DESC LIMIT 100",
        ...params,
      ),
    insertSimulationWithIdOrgIdName: (...params) =>
      run(
        "INSERT INTO simulations(id,org_id,name,description,scenario,rubric,threshold,version,created_by,created_at,updated_at)\n      VALUES(?,?,?,?,?,?,1,1,?,?,?) ON CONFLICT(id) DO NOTHING",
        ...params,
      ),
    insertProbationRequirement: (...params) =>
      run(
        "INSERT INTO probation_requirements(org_id,employee_id,spec_version,simulation_id) VALUES(?,?,?,?) ON CONFLICT(employee_id,spec_version,simulation_id) DO NOTHING",
        ...params,
      ),
    insertSimulationRunWithIdOrgIdSimulationId: (...params) =>
      run(
        "INSERT INTO simulation_runs(id,org_id,simulation_id,suite_version,suite_snapshot,employee_id,spec_version,status,score,passed,evidence,created_at,finished_at) VALUES(?,?,?,1,?,?,?,'completed',?,?,?,?,?)",
        ...params,
      ),
    findManyProbationRequirementByOrgIdAndEmployeeIdAndSpecVersion: (...params) =>
      all(
        "SELECT r.simulation_id,s.version FROM probation_requirements r JOIN simulations s ON s.id=r.simulation_id AND s.org_id=r.org_id WHERE r.org_id=? AND r.employee_id=? AND r.spec_version=?",
        ...params,
      ),
    findOneSimulationRunByOrgIdAndEmployeeIdAndSpecVersionSelectIdPassedSuiteSnapshot: (...params) =>
      get(
        "SELECT id,passed,suite_snapshot FROM simulation_runs WHERE org_id=? AND employee_id=? AND spec_version=? AND simulation_id=? AND suite_version=? ORDER BY created_at DESC LIMIT 1",
        ...params,
      ),
    findOneSimulationRunByOrgIdAndEmployeeIdAndPassed: (...params) =>
      get(
        "SELECT spec_version FROM simulation_runs WHERE org_id=? AND employee_id=? AND passed=1 ORDER BY created_at DESC LIMIT 1",
        ...params,
      ),
  };
}
