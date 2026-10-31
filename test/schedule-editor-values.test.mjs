import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleEditorDefaults, scheduleFormValues } from '../frontend/src/components/forms/schedule-values.js';

const form = defaults => ({ name: 'Daily review', employeeId: 'employee-1', goal: 'Review the queue', ...defaults });

test('weekday cron opens as its exact 14:30 preset and carries time and timezone into a cadence change', () => {
  const defaults = scheduleEditorDefaults({ kind: 'cron', cron: '30 14 * * 1-5', timezone: 'Asia/Kolkata' });
  assert.equal(defaults.repeat, 'weekdays');
  assert.equal(defaults.time, '14:30');
  assert.equal(scheduleFormValues(form(defaults)).cron, '30 14 * * 1-5');

  const changed = scheduleFormValues(form({ ...defaults, repeat: 'weekly', weekday: '3' }));
  assert.equal(changed.cron, '30 14 * * 3');
  assert.equal(changed.timezone, 'Asia/Kolkata');
});

test('last-day cron reopens as monthly and serializes without changing its meaning', () => {
  const defaults = scheduleEditorDefaults({ kind: 'cron', cron: '30 14 L * *', timezone: 'Europe/London' });
  assert.equal(defaults.repeat, 'monthly');
  assert.equal(defaults.time, '14:30');
  assert.equal(defaults.monthday, 'L');
  assert.deepEqual(scheduleFormValues(form(defaults)), {
    name: 'Daily review', employeeId: 'employee-1', goal: 'Review the queue', timezone: 'Europe/London',
    kind: 'cron', cron: '30 14 L * *',
  });
});

test('unmappable cron stays custom and unchanged, while a chosen preset keeps its parsed clock and timezone', () => {
  const customCron = '15 8 1,15 * 1';
  const defaults = scheduleEditorDefaults({ kind: 'cron', cron: customCron, timezone: 'America/New_York' });
  assert.equal(defaults.repeat, 'custom');
  assert.equal(scheduleFormValues(form(defaults)).cron, customCron);

  const changed = scheduleFormValues(form({ ...defaults, repeat: 'daily' }));
  assert.equal(changed.cron, '15 8 * * *');
  assert.equal(changed.timezone, 'America/New_York');
});

test('interval schedules preserve their elapsed duration and timezone', () => {
  const defaults = scheduleEditorDefaults({ kind: 'interval', intervalMinutes: 45, timezone: 'Asia/Kolkata' });
  assert.equal(defaults.repeat, 'interval');
  assert.deepEqual(scheduleFormValues(form(defaults)), {
    name: 'Daily review', employeeId: 'employee-1', goal: 'Review the queue', timezone: 'Asia/Kolkata',
    kind: 'interval', intervalMinutes: 45,
  });
});
