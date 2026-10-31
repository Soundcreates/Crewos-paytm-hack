import { useState } from 'react';
import { Field } from '../ui.jsx';
import { scheduleEditorDefaults } from './schedule-values.js';
export { scheduleFormValues } from './schedule-values.js';

export function ScheduleEditor({ schedule, employees }) {
  const defaults = scheduleEditorDefaults(schedule, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [repeat, setRepeat] = useState(defaults.repeat);
  const options = [
    { value: 'weekdays', label: 'Every weekday' }, { value: 'daily', label: 'Every day' },
    { value: 'weekly', label: 'Every week' }, { value: 'monthly', label: 'Every month' },
    { value: 'interval', label: 'At a regular interval' }, { value: 'custom', label: 'Custom calendar rule' },
  ];
  const available = employees.filter(employee => employee.state === 'active' || employee.id === schedule?.employeeId);
  return <>
    <Field label="Schedule name" name="name" value={schedule?.name} maxLength={160} full placeholder="Morning support review"/>
    <Field label="Employee" name="employeeId" value={schedule?.employeeId || available[0]?.id} options={available.map(employee => ({ value: employee.id, label: employee.name + (employee.state !== 'active' ? ' · Deployment needed' : '') }))}/>
    <Field label="Repeats" name="repeat" value={repeat} onChange={event => setRepeat(event.target.value)} options={options}/>
    <Field label="Task instructions" name="goal" value={schedule?.goal} rows={4} maxLength={2000} full hint="Each occurrence becomes a normal task with the employee’s current permissions and approval rules."/>
    {repeat === 'interval' ? <Field label="Every how many minutes?" name="intervalMinutes" type="number" value={defaults.intervalMinutes} min="1" max="525600" step="1" hint="Uses elapsed time, including across clock changes."/> : <>
      {repeat !== 'custom' && <Field label="Time" name="time" type="time" value={defaults.time}/>}
      {repeat === 'weekly' && <Field label="Day" name="weekday" value={defaults.weekday} options={[['1','Monday'],['2','Tuesday'],['3','Wednesday'],['4','Thursday'],['5','Friday'],['6','Saturday'],['0','Sunday']].map(([value,label]) => ({ value,label }))}/>}
      {repeat === 'monthly' && <Field label="Day of month" name="monthday" value={defaults.monthday} options={[...Array.from({length:31},(_,i)=>({value:String(i+1),label:String(i+1)})),{value:'L',label:'Last day'}]}/>}
      {repeat === 'custom' && <Field label="Calendar rule" name="cron" value={defaults.cron} full hint="Five fields: minute, hour, day of month, month, weekday. Example: 0 9 L * * runs at 9 AM on the last day of each month."/>}
    </>}
    <Field label="Timezone" name="timezone" value={defaults.timezone} full list="crewos-timezones" hint="Calendar times follow this timezone. Next-run dates on the list include the timezone."/>
    <datalist id="crewos-timezones">{['UTC',...(Intl.supportedValuesOf?.('timeZone') || ['Asia/Kolkata','America/New_York','Europe/London'])].map(zone => <option key={zone} value={zone}/>)}</datalist>
    <p className="field-hint full">Missed occurrences combine into one run after downtime. If the previous task is unfinished, the next occurrence is skipped and recorded in run history. Pausing stops future runs; it does not cancel an existing task.</p>
  </>;
}
