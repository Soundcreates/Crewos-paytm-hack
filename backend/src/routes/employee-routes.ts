import { repositories } from '../../src/repositories/index.mjs';
type EmployeeRow = Record<string, unknown> & { id: string };

interface EmployeeSpecRow {
  id: string;
  version: number;
  data: string;
  provenance: string;
  created_by: string;
  created_at: string;
}

interface ProbationRow {
  spec_version: number;
  score: number;
  passed: number | boolean;
  created_at: string;
}

interface LatestTaskRow {
  id: string;
  goal: string;
  status: string;
  updated_at: string;
}

interface TaskOutcomeRow {
  employee_id: string;
  completed: number | string | null;
  failed: number | string | null;
}

export async function listEmployees(
  orgId: string,
  toPublicSpec: (row: EmployeeSpecRow | undefined) => unknown,
) {
  const rows = await repositories.employees.findManyEmployeeByOrgIdSelectAllFields(orgId) as EmployeeRow[];
  const taskOutcomes = new Map<string, { completedTasks: number; failedTasks: number }>(
    (await repositories.workflows.findManyWorkflowByOrgIdAndStatusSelectEmployeeIdCompletedFailed(orgId) as TaskOutcomeRow[])
      .map((item) => [item.employee_id, { completedTasks: Number(item.completed || 0), failedTasks: Number(item.failed || 0) }]),
  );

  return Promise.all(rows.map(async (row) => {
    const specRow = await repositories.employees.findOneEmployeeSpecByEmployeeId(row.id);
    const probation = await repositories.simulations.findOneSimulationRunByEmployeeIdAndSpecVersion(row.id, specRow?.version || 0);
    const latestTask = await repositories.workflows.findOneWorkflowByEmployeeId(row.id);
    const { completedTasks = 0, failedTasks = 0 } = taskOutcomes.get(row.id) || {};
    const resolvedTasks = completedTasks + failedTasks;
    return {
      ...row,
      spec: toPublicSpec(specRow),
      probation: probation ?? null,
      latestTask: latestTask ?? null,
      completedTasks,
      failedTasks,
      resolvedTasks,
      taskSuccessRate: resolvedTasks ? Math.round(completedTasks * 100 / resolvedTasks) : null,
    };
  }));
}
