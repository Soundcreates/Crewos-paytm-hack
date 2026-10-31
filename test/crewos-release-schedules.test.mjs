import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'crewos-release-schedules-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: '',
  NEON_AUTH_BASE_URL: '',
  DATABASE_FILE: join(directory, 'schedules.sqlite'),
  REQUEST_TRACE: 'false',
});

const { all, get, run, now, closeDatabase } = await import('../backend/lib/db.mjs');
const { normalizeSchedule, nextScheduleTime, createScheduleService } = await import('../backend/src/services/schedules.mjs');

const timestamp = now();
for (const org of ['release_org_a', 'release_org_b']) {
  await run('INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)', org, org, timestamp);
}
for (const user of ['release_manager_a', 'release_manager_b', 'release_member_a', 'release_manager_c']) {
  await run('INSERT INTO users(id,name,email,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)',
    user, user, `${user}@example.test`, 'salt', 'hash', timestamp);
}
for (const [org, user, role] of [
  ['release_org_a', 'release_manager_a', 'manager'],
  ['release_org_a', 'release_member_a', 'member'],
  ['release_org_b', 'release_manager_b', 'manager'],
]) {
  await run('INSERT INTO memberships(org_id,user_id,role,created_at) VALUES(?,?,?,?)', org, user, role, timestamp);
}
for (const org of ['release_org_a', 'release_org_b']) {
  await run('INSERT INTO employees(id,org_id,name,title,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    `employee_${org}`, org, org, 'Support', 'active', timestamp, timestamp);
}

let clock = '2026-10-25T12:00:00.000Z';
let workflowSequence = 0;
let schedulePilotMode = false;
const dispatches = [];
async function createWorkflow(orgId, employeeId, userId, goal, plan, submission) {
  const workflowId = `release_schedule_task_${++workflowSequence}`;
  await run('INSERT INTO workflows(id,org_id,employee_id,created_by,goal,status,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    workflowId, orgId, employeeId, userId, goal, 'queued', JSON.stringify(submission.origin), clock, clock);
  dispatches.push({ workflowId, orgId, employeeId, userId, goal, submission });
  return { id: workflowId };
}
async function event() {}
const service = createScheduleService({ clock: () => clock, createWorkflow, event, pilotMode: () => schedulePilotMode });
const productionDefaultService = createScheduleService({ clock: () => clock, createWorkflow, event });

const managerA = { org: { id: 'release_org_a', role: 'manager' }, user: { id: 'release_manager_a' } };
const managerB = { org: { id: 'release_org_b', role: 'manager' }, user: { id: 'release_manager_b' } };
const memberA = { org: { id: 'release_org_a', role: 'member' }, user: { id: 'release_member_a' } };
const inputA = {
  name: 'Release review', employeeId: 'employee_release_org_a', goal: 'Review the support queue',
  kind: 'interval', intervalMinutes: 15, timezone: 'UTC',
};

after(async () => {
  await closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

test('recurrences preserve local wall time across both DST changes and month ends', () => {
  const daily = normalizeSchedule({
    name: 'New York morning review', employeeId: 'employee_release_org_a', goal: 'Review support',
    kind: 'cron', cron: '0 9 * * *', timezone: 'America/New_York',
  });
  assert.equal(nextScheduleTime(daily, '2026-03-07T15:00:00.000Z'), '2026-03-08T13:00:00.000Z',
    'the spring transition keeps the 09:00 local recurrence');
  assert.equal(nextScheduleTime(daily, '2026-10-31T14:00:00.000Z'), '2026-11-01T14:00:00.000Z',
    'the fall transition keeps the 09:00 local recurrence');

  const monthEnd = normalizeSchedule({ ...daily, name: 'Month end', cron: '0 9 L * *' });
  assert.equal(nextScheduleTime(monthEnd, '2028-02-28T15:00:00.000Z'), '2028-02-29T14:00:00.000Z',
    'leap February ends on February 29');
  assert.equal(nextScheduleTime(monthEnd, '2027-02-28T15:00:00.000Z'), '2027-03-31T13:00:00.000Z',
    'a non-leap February rolls forward to the next month end');
});

test('full to pilot to full skips due work atomically and does not replay a backlog', async () => {
  const saved = await service.create(managerA, inputA);
  const before = dispatches.length;
  try {
    schedulePilotMode = true;
    clock = '2026-10-25T12:45:00.000Z';
    await service.poll();

    const history = await service.history(managerA, saved.id).catch(error => {
      assert.equal(error.code, 'feature_disabled');
      return null;
    });
    assert.equal(history, null, 'pilot mode rejects schedule history API operations');
    const skipped = await get('SELECT due_at,status,error FROM schedule_runs WHERE schedule_id=? ORDER BY due_at DESC LIMIT 1', saved.id);
    assert.equal(skipped.due_at, saved.nextRunAt);
    assert.equal(skipped.status, 'skipped');
    assert.match(skipped.error, /disabled in pilot mode/);
    const afterPilot = await get('SELECT status,next_run_at,last_error FROM work_schedules WHERE id=?', saved.id);
    assert.equal(afterPilot.status, 'active');
    assert.equal(afterPilot.next_run_at, '2026-10-25T13:00:00.000Z');
    assert.match(afterPilot.last_error, /disabled in pilot mode/);
    assert.equal(dispatches.length, before, 'pilot mode never creates a scheduled workflow');

    await service.poll();
    assert.equal((await get('SELECT COUNT(*) AS count FROM schedule_runs WHERE schedule_id=?', saved.id)).count, 1,
      'missed intervals are coalesced instead of accumulating as backlog');

    schedulePilotMode = false;
    await service.poll();
    assert.equal(dispatches.length, before, 'returning to full mode does not dispatch an occurrence skipped in pilot mode');
    clock = afterPilot.next_run_at;
    await service.poll();
    assert.equal(dispatches.length, before + 1, 'full mode resumes at the next future cursor');
    const runs = await service.history(managerA, saved.id);
    assert.deepEqual(runs.map(item => item.status), ['queued', 'skipped']);
    assert.equal(runs[0].dueAt, '2026-10-25T13:00:00.000Z');
  } finally {
    schedulePilotMode = false;
    const current = (await service.list(managerA)).find(item => item.id === saved.id);
    if (current) await service.remove(managerA, current.id, current.revision);
  }
});

test('production defaults to pilot mode for worker dispatch', async () => {
  const saved = await service.create(managerA, inputA);
  const previousNodeEnv = process.env.NODE_ENV;
  const previousPilotMode = process.env.PILOT_MODE;
  const before = dispatches.length;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.PILOT_MODE;
    clock = saved.nextRunAt;
    await productionDefaultService.poll();
    assert.equal(dispatches.length, before);
    const skipped = await get('SELECT due_at,status,error FROM schedule_runs WHERE schedule_id=?', saved.id);
    assert.equal(skipped.due_at, saved.nextRunAt);
    assert.equal(skipped.status, 'skipped');
    assert.match(skipped.error, /disabled in pilot mode/);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousPilotMode === undefined) delete process.env.PILOT_MODE;
    else process.env.PILOT_MODE = previousPilotMode;
    const current = (await service.list(managerA)).find(item => item.id === saved.id);
    if (current) await service.remove(managerA, current.id, current.revision);
  }
});

test('tenant and manager boundaries hide schedules and run history', async () => {
  const saved = await service.create(managerA, inputA);
  assert.deepEqual(await service.list(managerB), []);
  await assert.rejects(service.history(managerB, saved.id), error => error.status === 404);
  await assert.rejects(service.update(managerB, saved.id, { ...inputA, revision: saved.revision }), error => error.status === 404);
  await assert.rejects(service.setStatus(managerB, saved.id, 'paused', saved.revision), error => error.status === 404);
  await assert.rejects(service.remove(managerB, saved.id, saved.revision), error => error.status === 404);
  const ownTenantSchedule = await service.create(managerB, { ...inputA, employeeId: 'employee_release_org_b' });
  assert.equal(ownTenantSchedule.employeeId, 'employee_release_org_b');
  await service.remove(managerB, ownTenantSchedule.id, ownTenantSchedule.revision);
  await assert.rejects(service.create(managerB, { ...inputA, employeeId: 'employee_release_org_a' }), error => error.status === 404);
  await assert.rejects(service.create(memberA, inputA), error => error.status === 403);
  await assert.rejects(service.history(memberA, saved.id), error => error.status === 403);
  await service.remove(managerA, saved.id, saved.revision);
});

test('simultaneous edits with one revision allow one write and reject the stale writer', async () => {
  const saved = await service.create(managerA, inputA);
  const results = await Promise.allSettled([
    service.update(managerA, saved.id, { ...inputA, name: 'First edit', revision: saved.revision }),
    service.update(managerA, saved.id, { ...inputA, name: 'Second edit', revision: saved.revision }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.status, 409);
  assert.equal(rejected.reason.code, 'stale_schedule');
  const current = (await service.list(managerA)).find(schedule => schedule.id === saved.id);
  assert.equal(current.revision, saved.revision + 1);
  assert.ok(['First edit', 'Second edit'].includes(current.name));
  await service.remove(managerA, saved.id, current.revision);
});

test('paused employees produce a skipped occurrence and dispatch again after redeployment', async () => {
  await run("UPDATE employees SET state='active' WHERE id='employee_release_org_a'");
  const saved = await service.create(managerA, inputA);
  await run("UPDATE employees SET state='paused' WHERE id='employee_release_org_a'");
  clock = saved.nextRunAt;
  const before = dispatches.length;
  try {
    await service.poll();
    assert.equal(dispatches.length, before);
    const skipped = (await service.history(managerA, saved.id))[0];
    assert.equal(skipped.status, 'skipped');
    assert.match(skipped.error, /Deploy the employee/);
    const afterSkip = (await service.list(managerA)).find(schedule => schedule.id === saved.id);
    assert.equal(afterSkip.status, 'active');

    await run("UPDATE employees SET state='active' WHERE id='employee_release_org_a'");
    clock = afterSkip.nextRunAt;
    await service.poll();
    assert.equal(dispatches.length, before + 1);
    const history = await service.history(managerA, saved.id);
    assert.deepEqual(history.map(run => run.status), ['queued', 'skipped']);
    await service.remove(managerA, saved.id, afterSkip.revision);
  } finally {
    await run("UPDATE employees SET state='active' WHERE id='employee_release_org_a'");
  }
});

test('deleting a creator membership pauses the schedule until a current manager takes it over', async () => {
  await run("UPDATE employees SET state='active' WHERE id='employee_release_org_a'");
  const saved = await service.create(managerA, inputA);
  await run("DELETE FROM memberships WHERE org_id='release_org_a' AND user_id='release_manager_a'");
  clock = saved.nextRunAt;
  const before = dispatches.length;
  await service.poll();
  assert.equal(dispatches.length, before);
  const paused = (await get('SELECT status,last_error FROM work_schedules WHERE id=?', saved.id));
  assert.equal(paused.status, 'paused');
  assert.match(paused.last_error, /no longer has access/);
  await assert.rejects(service.history(memberA, saved.id), error => error.status === 403,
    'a non-manager cannot inspect the paused schedule');

  await run("INSERT INTO memberships(org_id,user_id,role,created_at) VALUES('release_org_a','release_manager_c','manager',?)", timestamp);
  const newManager = { org: { id: 'release_org_a', role: 'manager' }, user: { id: 'release_manager_c' } };
  const takeOver = await service.setStatus(newManager, saved.id, 'active', saved.revision);
  assert.equal(takeOver.createdBy, 'release_manager_c');
  assert.equal(takeOver.status, 'active');
  await service.remove(newManager, saved.id, takeOver.revision);
});

test('downtime coalesces missed intervals and parallel polls do not duplicate an occurrence', async () => {
  const saved = await service.create(managerB, { ...inputA, employeeId: 'employee_release_org_b' });
  const due = new Date(saved.nextRunAt).getTime();
  clock = new Date(due + 36 * 60 * 60 * 1000).toISOString();
  const before = dispatches.length;
  await Promise.all([service.poll(), service.poll(), service.poll()]);
  assert.equal(dispatches.length, before + 1);
  const firstRun = (await service.history(managerB, saved.id))[0];
  assert.equal(firstRun.status, 'queued');
  const current = (await service.list(managerB)).find(schedule => schedule.id === saved.id);
  assert.equal(current.nextRunAt, new Date(new Date(clock).getTime() + 15 * 60 * 1000).toISOString());

  await run("UPDATE workflows SET status='completed' WHERE id=?", firstRun.workflowId);
  clock = current.nextRunAt;
  await service.poll();
  assert.equal(dispatches.length, before + 2);
  assert.equal((await service.history(managerB, saved.id))[0].status, 'queued');
  const afterNextRun = (await service.list(managerB)).find(schedule => schedule.id === saved.id);
  await service.remove(managerB, saved.id, afterNextRun.revision);
});
