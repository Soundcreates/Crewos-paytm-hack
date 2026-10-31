import { Fragment, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { isManager } from '../lib/format.js';
import { Badge, Button, Empty, Heading, Panel, Table } from '../components/ui.jsx';

function dateInZone(value, timezone) {
  if (!value) return 'No runs yet';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(new Date(value));
}

function cadence(schedule) {
  if (schedule.kind === 'interval') return `Every ${schedule.intervalMinutes} minute${schedule.intervalMinutes === 1 ? '' : 's'}`;
  const [minute,hour,day,month,weekday] = schedule.cron.split(/\s+/);
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour) || month !== '*') return 'Custom calendar';
  const at = `${hour.padStart(2,'0')}:${minute.padStart(2,'0')}`;
  if (weekday === '*' && day === '*') return `Every day at ${at}`;
  if (weekday === '1-5' && day === '*') return `Weekdays at ${at}`;
  if (day === '*' && /^[0-6]$/.test(weekday)) return `Every ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][Number(weekday)]} at ${at}`;
  if (weekday === '*' && day === 'L') return `Last day of each month at ${at}`;
  if (weekday === '*' && /^\d+$/.test(day)) return `Day ${day} of each month at ${at}`;
  return 'Custom calendar';
}

export function SchedulesPage({ data, session, actions }) {
  const [expanded, setExpanded] = useState(null), [history, setHistory] = useState({}), [error, setError] = useState(''), [busy, setBusy] = useState(null);
  useEffect(() => {
    if (!expanded) return;
    let active = true;
    const controller = new AbortController();
    setBusy(expanded); setError('');
    api('/api/schedules/'+encodeURIComponent(expanded)+'/runs',{signal:controller.signal}).then(runs => {
      if (active) setHistory(current => ({...current,[expanded]:runs}));
    }).catch(reason => { if (active) setError(reason.message); }).finally(() => { if (active) setBusy(null); });
    return () => { active = false; controller.abort(); };
  },[expanded,data]);
  if (!isManager(session)) return <Empty title="Manager access required">Ask a workspace manager to manage recurring work.</Empty>;
  const schedules = data.schedules || [], hasEmployees = data.employees.some(employee => employee.state === 'active');
  function showHistory(schedule) { setExpanded(current => current === schedule.id ? null : schedule.id); }
  return <>
    <Heading title="Schedules" subtitle="Give employees recurring work and review every run."><Button kind="btn-primary" disabled={!hasEmployees} onClick={() => actions('new-schedule')}>Create schedule</Button></Heading>
    {!hasEmployees && <p className="inline-note">Deploy an employee before creating a schedule. <Button kind="btn-link" onClick={() => actions('navigate','employees')}>Open employees</Button></p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    <Panel>{schedules.length ? <Table headers={['Schedule','Employee','Next run','Status','Actions']}>{schedules.map(schedule => <Fragment key={schedule.id}>
      <tr><td><b>{schedule.name}</b><p className="field-hint" title={schedule.cron || undefined}>{cadence(schedule)}<br/>{schedule.timezone}</p>{schedule.lastError && <p className="field-hint" role="status">{schedule.lastError}</p>}</td>
        <td>{schedule.employeeName}<p className="field-hint">Saved by {schedule.creatorName}</p></td>
        <td>{schedule.status === 'active' ? <time dateTime={schedule.nextRunAt}>{dateInZone(schedule.nextRunAt,schedule.timezone)}</time> : 'Paused'}</td>
        <td><Badge value={schedule.status}>{schedule.status === 'active' ? 'Enabled' : 'Paused'}</Badge></td>
        <td><div className="section-actions schedule-actions"><Button kind="btn-small" onClick={() => actions('edit-schedule',schedule)}>Edit</Button><Button kind="btn-small" onClick={() => actions(schedule.status === 'active' ? 'pause-schedule' : 'resume-schedule',schedule)}>{schedule.status === 'active' ? 'Pause' : 'Resume'}</Button><Button kind="btn-small" onClick={() => showHistory(schedule)} aria-expanded={expanded === schedule.id}>Run history</Button><Button kind="btn-small btn-danger" onClick={() => actions('delete-schedule',schedule)}>Delete</Button></div></td></tr>
      {expanded === schedule.id && <tr><td colSpan={5}><div className="detail-section"><h3>{schedule.name} · Recent runs</h3><p className="muted">{schedule.goal}</p>{busy === schedule.id ? <p role="status">Loading run history…</p> : history[schedule.id]?.length ? <Table headers={['Scheduled for','Result','Details']}>{history[schedule.id].map(run => <tr key={run.id}><td><time dateTime={run.dueAt}>{dateInZone(run.dueAt,schedule.timezone)}</time></td><td><Badge value={run.status}/></td><td>{run.workflowId ? <Button kind="btn-small" onClick={() => actions('open-task',run.workflowId)}>Open task</Button> : run.error}</td></tr>)}</Table> : <p className="muted">No runs recorded yet.</p>}</div></td></tr>}
    </Fragment>)}</Table> : <Empty title="No recurring work yet" action={<Button disabled={!hasEmployees} onClick={() => actions('new-schedule')}>Create schedule</Button>}>Schedule a daily review, a weekly report, or a regular check. Every task follows the same approval and verification rules.</Empty>}</Panel>
    <p className="field-hint">Calendar times use each schedule’s timezone. After downtime, one run replaces missed occurrences. Unfinished work prevents overlapping runs.</p>
  </>;
}
