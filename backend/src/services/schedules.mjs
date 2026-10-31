import { CronExpressionParser } from 'cron-parser';
import { all, get, run, id, now, transaction } from '../../lib/db.mjs';
import { createSchedulesRepository } from '../repositories/schedules-repository.mjs';
import { HttpError } from '../utils/errors.mjs';
import { pilotMode as runtimePilotMode } from '../../workflows/probation.mjs';

const ranks = { member: 0, manager: 1, admin: 2, owner: 3 };
const terminal = new Set(['completed', 'failed', 'cancelled']);

function requiredText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new HttpError(400, `${label} must contain 1 to ${max} characters.`);
  return value.trim();
}

export function normalizeSchedule(input) {
  const name = requiredText(input.name, 'Schedule name', 160);
  const employeeId = requiredText(input.employeeId, 'Employee', 200);
  const goal = requiredText(input.goal, 'Task instructions', 2000);
  const timezone = requiredText(input.timezone, 'Schedule timezone', 100);
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); }
  catch { throw new HttpError(400, 'Choose a valid IANA timezone, such as Asia/Kolkata.'); }
  if (!['cron', 'interval'].includes(input.kind)) throw new HttpError(400, 'Choose a supported schedule type.');
  const schedule = { name, employeeId, goal, timezone, kind: input.kind, cron: null, intervalMinutes: null };
  if (input.kind === 'interval') {
    if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 1 || input.intervalMinutes > 525600) throw new HttpError(400, 'Interval minutes must be a whole number between 1 and 525600.');
    schedule.intervalMinutes = input.intervalMinutes;
  } else {
    schedule.cron = requiredText(input.cron, 'Calendar rule', 200);
    if (schedule.cron.split(/\s+/).length !== 5 || /[@?]|\bH(?:\(|(?=[\s,\/]|$))/i.test(schedule.cron)) throw new HttpError(400, 'Use a deterministic five-field calendar rule with minute precision.');
    try { nextScheduleTime(schedule, now()); }
    catch { throw new HttpError(400, 'The calendar rule must have a valid future occurrence.'); }
  }
  return schedule;
}

export function nextScheduleTime(schedule, after) {
  const date = new Date(after);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid schedule cursor.');
  if (schedule.kind === 'interval') return new Date(date.getTime() + schedule.intervalMinutes * 60000).toISOString();
  return CronExpressionParser.parse(schedule.cron, { currentDate: date, tz: schedule.timezone }).next().toDate().toISOString();
}

function view(row) {
  return {
    id: row.id, name: row.name, employeeId: row.employee_id, employeeName: row.employee_name,
    createdBy: row.created_by, creatorName: row.creator_name, goal: row.goal, kind: row.kind,
    cron: row.cron, intervalMinutes: row.interval_minutes, timezone: row.timezone,
    status: row.status, nextRunAt: row.next_run_at, lastRunAt: row.last_run_at,
    lastWorkflowId: row.last_workflow_id, lastError: row.last_error, revision: row.revision,
  };
}

function authorize(context) {
  if (!context?.user || !context?.org) throw new HttpError(401, 'Sign in to continue.');
  if ((ranks[context.org.role] ?? -1) < ranks.manager) throw new HttpError(403, 'Schedules require manager access.');
}

export function createScheduleService({ createWorkflow, event, clock = now, pilotMode = runtimePilotMode }) {
  const repository = createSchedulesRepository({ all, get, run });
  function authorizeManagement(context) {
    authorize(context);
    if (pilotMode()) throw new HttpError(403, 'Recurring schedules are unavailable in pilot mode.', 'feature_disabled');
  }
  async function find(context, scheduleId, includeArchived = false) {
    authorize(context);
    const row = await repository.find(context.org.id, scheduleId);
    if (!row || (!includeArchived && row.status === 'archived')) throw new HttpError(404, 'Schedule not found.');
    return row;
  }
  async function activeEmployee(orgId, employeeId) {
    const employee = await repository.employee(orgId, employeeId);
    if (!employee) throw new HttpError(404, 'Employee not found in this workspace.');
    if (employee.state !== 'active') throw new HttpError(409, 'Deploy the employee before scheduling work.');
  }
  function expectedRevision(row, revision) {
    if (!Number.isInteger(revision) || row.revision !== revision) throw new HttpError(409, 'This schedule changed. Refresh it before saving.', 'stale_schedule');
  }
  async function list(context) {
    authorizeManagement(context);
    return (await repository.list(context.org.id)).map(view);
  }
  async function create(context, input) {
    authorizeManagement(context);
    const schedule = normalizeSchedule(input);
    return transaction(async () => {
      await activeEmployee(context.org.id, schedule.employeeId);
      const scheduleId = id('schedule'), timestamp = clock();
      await repository.insert(scheduleId, context.org.id, schedule.employeeId, context.user.id, schedule.name, schedule.goal, schedule.kind,
        schedule.cron, schedule.intervalMinutes, schedule.timezone, nextScheduleTime(schedule, timestamp), timestamp, timestamp);
      await event(context.org.id, 'schedule.created', { scheduleId, name: schedule.name }, context);
      return view(await repository.find(context.org.id, scheduleId));
    });
  }
  async function update(context, scheduleId, input) {
    authorizeManagement(context);
    const schedule = normalizeSchedule(input);
    return transaction(async () => {
      const row = await find(context, scheduleId);
      expectedRevision(row, input.revision);
      await activeEmployee(context.org.id, schedule.employeeId);
      const timestamp = clock();
      const changed = await repository.update(schedule.employeeId, context.user.id, schedule.name, schedule.goal, schedule.kind, schedule.cron,
        schedule.intervalMinutes, schedule.timezone, nextScheduleTime(schedule, timestamp), timestamp, context.org.id, scheduleId, input.revision);
      if (changed.changes !== 1) throw new HttpError(409, 'This schedule changed. Refresh it before saving.', 'stale_schedule');
      await event(context.org.id, 'schedule.updated', { scheduleId }, context);
      return view(await repository.find(context.org.id, scheduleId));
    });
  }
  async function setStatus(context, scheduleId, status, revision) {
    authorizeManagement(context);
    if (!['active', 'paused', 'archived'].includes(status)) throw new HttpError(400, 'Invalid schedule status.');
    return transaction(async () => {
      const row = await find(context, scheduleId);
      expectedRevision(row, revision);
      if (status === 'active') await activeEmployee(context.org.id, row.employee_id);
      const nextRunAt = status === 'active' ? nextScheduleTime(view(row), clock()) : row.next_run_at;
      const changed = await repository.setStatus(status, context.user.id, nextRunAt, clock(), context.org.id, scheduleId, revision);
      if (changed.changes !== 1) throw new HttpError(409, 'This schedule changed. Refresh it before saving.', 'stale_schedule');
      await event(context.org.id, `schedule.${status === 'active' ? 'resumed' : status}`, { scheduleId }, context);
      return view(await repository.find(context.org.id, scheduleId));
    });
  }
  async function history(context, scheduleId) {
    authorizeManagement(context);
    await find(context, scheduleId, true);
    return (await repository.history(context.org.id, scheduleId)).map(row => ({
      id: row.id, dueAt: row.due_at, createdAt: row.created_at, workflowId: row.workflow_id, status: row.status, error: row.error,
    }));
  }
  async function poll() {
    const schedulesDisabled = pilotMode();
    const timestamp = clock();
    for (const candidate of await repository.due(timestamp)) {
      await transaction(async () => {
        // Advancing the cursor and inserting the task are one commit. Competing workers
        // must win this compare-and-swap before they may dispatch an occurrence.
        const changed = await repository.advance(nextScheduleTime(view(candidate), timestamp), timestamp, timestamp,
          candidate.id, candidate.org_id, candidate.next_run_at, candidate.revision);
        if (changed.changes !== 1) return;
        let workflowId = null, error = null, revoked = false, eventContext = {};
        if (schedulesDisabled) error = 'Recurring schedules are disabled in pilot mode. This due occurrence was skipped.';
        else {
          const role = await repository.role(candidate.org_id, candidate.created_by);
          revoked = (ranks[role?.role] ?? -1) < ranks.manager;
          const context = { org: { id: candidate.org_id, role: role?.role }, user: { id: candidate.created_by } };
          if (revoked) error = 'The manager who saved this schedule no longer has access. A manager must resume it.';
          else {
            eventContext = context;
            const prior = candidate.last_workflow_id && await repository.workflowStatus(candidate.org_id, candidate.last_workflow_id);
            if (prior && !terminal.has(prior.status)) error = 'The previous scheduled task is still unfinished. This occurrence was skipped.';
            else {
              try {
                await activeEmployee(candidate.org_id, candidate.employee_id);
                // createWorkflow performs current spec/deployment checks. Actual execution
                // still goes through the existing policy, approval and verification gates.
                const workflow = await createWorkflow(candidate.org_id, candidate.employee_id, candidate.created_by, candidate.goal, null, {
                  idempotencyKey: `schedule:${candidate.id}:${candidate.next_run_at}`,
                  origin: { type: 'schedule', scheduleId: candidate.id, dueAt: candidate.next_run_at },
                });
                workflowId = workflow.id;
              } catch (cause) {
                if (!Number.isInteger(cause?.status) || cause.status >= 500) throw cause;
                error = String(cause.message || 'Current employee deployment cannot accept this task.').slice(0, 500);
              }
            }
          }
        }
        await repository.recordRun(id('schedule-run'), candidate.org_id, candidate.id, candidate.next_run_at,
          workflowId ? 'queued' : 'skipped', workflowId, error, timestamp);
        await repository.recordResult(error, workflowId, revoked ? 1 : 0, candidate.id, candidate.org_id);
        // If authority was revoked there is no valid actor to attribute; retain the
        // schedule's creator in its own record, without claiming a current membership.
        await event(candidate.org_id, workflowId ? 'schedule.dispatched' : 'schedule.skipped',
          { scheduleId: candidate.id, dueAt: candidate.next_run_at, workflowId, reason: error }, revoked ? {} : eventContext);
      });
    }
  }
  return { list, create, update, setStatus, history, poll, remove: (context, scheduleId, revision) => setStatus(context, scheduleId, 'archived', revision) };
}
