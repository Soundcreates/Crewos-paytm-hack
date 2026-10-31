export const DEFAULT_SCHEDULE_CRON = '0 9 * * 1-5';

function cronFields(cron) {
  const fields = String(cron || '').trim().split(/\s+/);
  return fields.length === 5 ? fields : null;
}

function isClock(fields) {
  return fields && /^\d{1,2}$/.test(fields[0]) && Number(fields[0]) <= 59
    && /^\d{1,2}$/.test(fields[1]) && Number(fields[1]) <= 23;
}

function supportedRepeat(fields) {
  if (!fields || fields[3] !== '*' || !isClock(fields)) return null;
  const [, , day, , weekday] = fields;
  if (day === '*' && weekday === '1-5') return 'weekdays';
  if (day === '*' && weekday === '*') return 'daily';
  if (day === '*' && /^[0-6]$/.test(weekday)) return 'weekly';
  if (weekday === '*' && (day === 'L' || (/^\d{1,2}$/.test(day) && Number(day) >= 1 && Number(day) <= 31))) return 'monthly';
  return null;
}

export function scheduleEditorDefaults(schedule, fallbackTimezone = 'UTC') {
  const cron = schedule?.cron || DEFAULT_SCHEDULE_CRON;
  const fields = cronFields(cron);
  const time = isClock(fields)
    ? `${String(Number(fields[1])).padStart(2, '0')}:${String(Number(fields[0])).padStart(2, '0')}`
    : '09:00';
  const parsedDay = fields?.[2];
  const parsedWeekday = fields?.[4];

  return {
    repeat: schedule?.kind === 'interval' ? 'interval' : schedule ? supportedRepeat(fields) || 'custom' : 'weekdays',
    time,
    weekday: /^[0-6]$/.test(parsedWeekday || '') ? parsedWeekday : '1',
    monthday: parsedDay === 'L' || (/^\d{1,2}$/.test(parsedDay || '') && Number(parsedDay) >= 1 && Number(parsedDay) <= 31) ? parsedDay : '1',
    intervalMinutes: schedule?.intervalMinutes ?? 60,
    timezone: schedule?.timezone || fallbackTimezone || 'UTC',
    cron: schedule?.cron || DEFAULT_SCHEDULE_CRON,
  };
}

export function scheduleFormValues(values) {
  const base = { name: values.name, employeeId: values.employeeId, goal: values.goal, timezone: values.timezone };
  if (values.repeat === 'interval') return { ...base, kind: 'interval', intervalMinutes: Number(values.intervalMinutes) };
  const [hour, minute] = String(values.time || '09:00').split(':').map(Number);
  const cron = values.repeat === 'custom' ? values.cron
    : `${minute} ${hour} ${values.repeat === 'monthly' ? values.monthday : '*'} * ${values.repeat === 'weekdays' ? '1-5' : values.repeat === 'weekly' ? values.weekday : '*'}`;
  return { ...base, kind: 'cron', cron };
}
