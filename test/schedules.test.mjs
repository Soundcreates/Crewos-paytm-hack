import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'crewos-schedules-'));
Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: '', NEON_AUTH_BASE_URL: '', DATABASE_FILE: join(directory, 'schedules.sqlite'), REQUEST_TRACE: 'false' });
const { all, get, run, now, closeDatabase } = await import('../backend/lib/db.mjs');
const { normalizeSchedule, nextScheduleTime, createScheduleService } = await import('../backend/src/services/schedules.mjs');

test('calendar schedules honor timezone, DST, and exact monthly rules', () => {
  const base = { name: 'Morning review', employeeId: 'emp_a', goal: 'Review the support queue', kind: 'cron', timezone: 'Asia/Kolkata', cron: '0 9 * * 1-5' };
  const schedule = normalizeSchedule(base);
  assert.equal(nextScheduleTime(schedule, '2026-10-23T04:00:00.000Z'), '2026-10-26T03:30:00.000Z');
  assert.equal(nextScheduleTime({ ...schedule, timezone: 'America/New_York', cron: '0 9 * * *' }, '2026-10-31T14:00:00.000Z'), '2026-11-01T14:00:00.000Z');
  assert.equal(nextScheduleTime({ ...schedule, cron: '0 9 L * *' }, '2026-10-25T00:00:00.000Z'), '2026-10-31T03:30:00.000Z');
  assert.equal(nextScheduleTime({ ...schedule, cron: '0 9 * * 1#2' }, '2026-10-25T00:00:00.000Z'), '2026-11-09T03:30:00.000Z');
});

test('interval schedules use elapsed time and reject ambiguous or unbounded input', () => {
  const input = { name: 'Review', employeeId: 'emp_a', goal: 'Review support', kind: 'interval', intervalMinutes: 15, timezone: 'UTC' };
  assert.equal(nextScheduleTime(normalizeSchedule(input), '2026-10-25T12:00:00.000Z'), '2026-10-25T12:15:00.000Z');
  for (const intervalMinutes of [0, -1, 1.5, '1', 525601, Infinity]) assert.throws(() => normalizeSchedule({ ...input, intervalMinutes }), /whole number/);
  for (const timezone of ['Not/AZone', '', 'Mars/Olympus']) assert.throws(() => normalizeSchedule({ ...input, timezone }), /timezone/);
  for (const cron of ['* * * * * *', '@daily', 'H * * * *', 'garbage', '0 0 31 2 *']) assert.throws(() => normalizeSchedule({ ...input, kind: 'cron', cron }), /calendar rule/);
  assert.throws(() => normalizeSchedule({ ...input, kind: 'unknown' }), /schedule type/);
});

const timestamp = now();
for (const org of ['org_a', 'org_b']) await run('INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)', org, org, timestamp);
for (const user of ['manager_a', 'manager_b', 'member_a']) await run('INSERT INTO users(id,name,email,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)', user, user, `${user}@example.test`, 'salt', 'hash', timestamp);
for (const [org, user, role] of [['org_a', 'manager_a', 'manager'], ['org_b', 'manager_b', 'manager'], ['org_a', 'member_a', 'member']]) await run('INSERT INTO memberships(org_id,user_id,role,created_at) VALUES(?,?,?,?)', org, user, role, timestamp);
for (const org of ['org_a', 'org_b']) await run('INSERT INTO employees(id,org_id,name,title,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', `emp_${org}`, org, org, 'Support', 'active', timestamp, timestamp);

let clock = '2026-10-25T12:00:00.000Z';
let effects = 0;
let failure = null;
const service = createScheduleService({
  clock: () => clock,
  async createWorkflow(orgId, employeeId, userId, goal, plan, submission) {
    if (failure) throw failure;
    const id = `task_schedule_${++effects}`;
    await run('INSERT INTO workflows(id,org_id,employee_id,created_by,goal,status,origin,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', id, orgId, employeeId, userId, goal, 'queued', JSON.stringify(submission.origin), clock, clock);
    return { id };
  },
  async event() {},
});
const manager = { org: { id: 'org_a', role: 'manager' }, user: { id: 'manager_a' } };
const other = { org: { id: 'org_b', role: 'manager' }, user: { id: 'manager_b' } };
const input = { name: 'Support review', employeeId: 'emp_org_a', goal: 'Review the support queue', kind: 'interval', intervalMinutes: 15, timezone: 'UTC' };
after(async () => { await closeDatabase(); rmSync(directory, { recursive: true, force: true }); });

test('schedules enforce workspace ownership, current manager authority, and deployed employees', async () => {
  await assert.rejects(service.create(null, input), error => error.status === 401);
  await assert.rejects(service.create({ ...manager, org: { ...manager.org, role: 'member' } }, input), error => error.status === 403);
  await assert.rejects(service.create(other, input), error => error.status === 404);
  const saved = await service.create(manager, input);
  assert.equal(saved.nextRunAt, '2026-10-25T12:15:00.000Z');
  assert.equal(saved.status, 'active');
  await assert.rejects(service.update(other, saved.id, { ...input, revision: saved.revision }), error => error.status === 404);
  await assert.rejects(service.update(manager, saved.id, { ...input, revision: 0 }), error => error.status === 409);
  await service.remove(manager, saved.id, saved.revision);
  assert.ok(!(await service.list(manager)).some(item => item.id === saved.id));
});

test('competing scheduler polls queue one task and never overlap unfinished work', async () => {
  const saved = await service.create(manager, input);
  clock = saved.nextRunAt;
  const before = effects;
  await Promise.all([service.poll(), service.poll(), service.poll()]);
  assert.equal(effects - before, 1);
  const history = await service.history(manager, saved.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].status, 'queued');
  const workflow = await get('SELECT origin FROM workflows WHERE id=?', history[0].workflowId);
  assert.deepEqual(JSON.parse(workflow.origin), { type: 'schedule', scheduleId: saved.id, dueAt: clock });
  clock = '2026-10-26T12:00:00.000Z';
  await service.poll();
  assert.equal(effects - before, 1, 'unfinished work prevents overlapping scheduled tasks');
  const updated = (await service.list(manager)).find(item => item.id === saved.id);
  assert.equal(updated.nextRunAt, '2026-10-26T12:15:00.000Z', 'downtime coalesces to one occurrence and skips the backlog');
  assert.equal((await service.history(manager, saved.id))[0].status, 'skipped');
  await service.setStatus(manager, saved.id, 'paused', updated.revision);
});

test('pause, resume, edit and delete are revision-checked and persist audit history', async () => {
  const saved = await service.create(manager, input);
  const paused = await service.setStatus(manager, saved.id, 'paused', saved.revision);
  clock = '2026-10-27T12:00:00.000Z';
  const before = effects;
  await service.poll();
  assert.equal(effects, before);
  const resumed = await service.setStatus(manager, saved.id, 'active', paused.revision);
  assert.equal(resumed.nextRunAt, '2026-10-27T12:15:00.000Z');
  const edited = await service.update(manager, saved.id, { ...input, name: 'Revised review', revision: resumed.revision });
  await assert.rejects(service.remove(manager, saved.id, resumed.revision), error => error.status === 409);
  await service.remove(manager, saved.id, edited.revision);
  assert.deepEqual(await service.history(manager, saved.id), []);
});

test('revocation pauses schedules without dispatching tasks and a manager can take responsibility', async () => {
  const saved = await service.create(manager, input);
  await run("UPDATE memberships SET role='member' WHERE org_id='org_a' AND user_id='manager_a'");
  clock = saved.nextRunAt;
  const before = effects;
  await service.poll();
  assert.equal(effects, before);
  assert.equal((await get('SELECT status FROM work_schedules WHERE id=?', saved.id)).status, 'paused');
  await run("UPDATE memberships SET role='manager' WHERE org_id='org_a' AND user_id='member_a'");
  const newManager = { ...manager, user: { id: 'member_a' } };
  const record = (await service.list(newManager)).find(item => item.id === saved.id);
  const resumed = await service.setStatus(newManager, saved.id, 'active', record.revision);
  assert.equal(resumed.createdBy, 'member_a');
  await service.remove(newManager, saved.id, resumed.revision);
  await run("UPDATE memberships SET role='manager' WHERE org_id='org_a' AND user_id='manager_a'");
});

test('failed schedule dispatch records a bounded error and does not loop over missed occurrences', async () => {
  const saved = await service.create(manager, input);
  failure = Object.assign(new Error('Current deployment requires probation.'), { status: 409 });
  clock = saved.nextRunAt;
  await service.poll();
  failure = null;
  const history = await service.history(manager, saved.id);
  assert.equal(history[0].status, 'skipped');
  assert.match(history[0].error, /probation/);
  const record = (await service.list(manager)).find(item => item.id === saved.id);
  assert.ok(record.nextRunAt > clock);
  await service.remove(manager, saved.id, record.revision);
});

test('transient dispatch failures roll back the cursor and recover without losing the occurrence', async () => {
  const saved = await service.create(manager, input);
  clock = saved.nextRunAt;
  failure = new Error('Temporary database failure');
  await assert.rejects(service.poll(), /Temporary database failure/);
  failure = null;
  assert.equal((await get('SELECT next_run_at FROM work_schedules WHERE id=?', saved.id)).next_run_at, clock);
  assert.deepEqual(await service.history(manager, saved.id), []);
  const before = effects;
  await service.poll();
  assert.equal(effects, before + 1);
  const record = (await service.list(manager)).find(item => item.id === saved.id);
  await service.remove(manager, saved.id, record.revision);
});
