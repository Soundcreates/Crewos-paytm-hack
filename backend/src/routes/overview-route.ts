import { repositories } from '../../src/repositories/index.mjs';
interface CountRow {
  count: number | string;
}

interface OutcomeRow {
  completed: number | string | null;
  failed: number | string | null;
}

interface RecentEventRow {
  id: string;
  kind: string;
  detail: string;
  created_at: string;
  employee_id: string | null;
  workflow_id: string | null;
}

interface ApprovalRow {
  id: string;
  goal: string;
  employee_id: string;
  input_requests: string;
  created_at: string;
}

function parseJson(value: string, fallback: unknown) {
  try { return JSON.parse(value) as unknown; }
  catch { return fallback; }
}

export async function getOrganizationOverview(orgId: string) {
  const employees = (await repositories.employees.findOneEmployeeByOrgId(orgId))?.count ?? 0;
  const active = (await repositories.employees.findOneEmployeeByOrgIdAndState(orgId))?.count ?? 0;
  const pending = (await repositories.workflows.findOneWorkflowByOrgIdAndStatus(orgId))?.count ?? 0;
  const running = (await repositories.workflows.findOneWorkflowByOrgIdAndStatusSelectCount(orgId))?.count ?? 0;
  const outcomes = await repositories.workflows.findOneWorkflowByOrgIdSelectCompletedFailed(orgId) as OutcomeRow | undefined;
  const completedTasks = Number(outcomes?.completed || 0);
  const failedTasks = Number(outcomes?.failed || 0);
  const resolvedTasks = completedTasks + failedTasks;
  const recent = (await repositories.workflows.findManyEventByOrgIdSelectIdKindDetail(orgId) as RecentEventRow[])
    .map((row) => ({ ...row, detail: parseJson(row.detail, {}) }));
  const approvals = (await repositories.workflows.findManyWorkflowByOrgIdAndStatusSelectIdGoalEmployeeId(orgId) as ApprovalRow[])
    .map((row) => ({ ...row, input_requests: parseJson(row.input_requests, {}) }));
  return {
    employees,
    active,
    pending,
    running,
    completedTasks,
    failedTasks,
    resolvedTasks,
    taskSuccessRate: resolvedTasks ? Math.round(completedTasks * 100 / resolvedTasks) : null,
    recent,
    approvals,
  };
}
