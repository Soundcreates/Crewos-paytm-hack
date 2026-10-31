import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { provenanceForEditedFields } from 'solari-crew-core';
import { confirmNavigation, NAV, routeNow } from '../config/navigation.js';
import { api, loadRouteData, neonAuth } from '../lib/api.js';
import { capabilityRows, formObject, isManager, jsonField, lines, pretty } from '../lib/format.js';
import { AppShell } from '../components/AppShell.jsx';
import { Dialog } from '../components/Dialog.jsx';
import { Button, Empty, Toast } from '../components/ui.jsx';
import { AuthView } from '../pages/AuthPage.jsx';
import { LandingPage } from '../pages/LandingPage.jsx';
import { isAppHash, navigatePublic, PUBLIC_PATHS, usePublicPage } from '../config/public-routes.jsx';
const loadPage=(path,name)=>lazy(()=>path().then(module=>({default:module[name]})));
export function routeLoadingLabel(route) {
  const title = route === 'hire' ? 'Hire employee' : route === 'setup' ? 'Setup'
    : route.endsWith('/edit') ? 'Employee editor' : route.startsWith('employee/') ? 'Employee details'
      : route.startsWith('meeting/') ? 'Meeting details' : NAV.find(([key]) => key === route)?.[1] || 'Overview';
  return `Loading ${title}…`;
}
const Overview=loadPage(()=>import('../pages/OperationsPages.jsx'),'Overview');
const EmployeesPage=loadPage(()=>import('../pages/OperationsPages.jsx'),'EmployeesPage');
const EmployeeDetail=loadPage(()=>import('../pages/OperationsPages.jsx'),'EmployeeDetail');
const ProbationPage=loadPage(()=>import('../pages/OperationsPages.jsx'),'ProbationPage');
const TasksPage=loadPage(()=>import('../pages/OperationsPages.jsx'),'TasksPage');
const MemoryPage=loadPage(()=>import('../pages/CollaborationPages.jsx'),'MemoryPage');
const CoworkersPage=loadPage(()=>import('../pages/CollaborationPages.jsx'),'CoworkersPage');
const MeetingsPage=loadPage(()=>import('../pages/CollaborationPages.jsx'),'MeetingsPage');
const MeetingDetail=loadPage(()=>import('../pages/CollaborationPages.jsx'),'MeetingDetail');
const OfficePage=loadPage(()=>import('../pages/OfficePages.jsx'),'OfficePage');
const ReportsPage=loadPage(()=>import('../pages/AdminPages.jsx'),'ReportsPage');
const SettingsPage=loadPage(()=>import('../pages/AdminPages.jsx'),'SettingsPage');
const IntegrationsPage=loadPage(()=>import('../pages/IntegrationsPage.jsx'),'IntegrationsPage');
const CommerceStudioPage=loadPage(()=>import('../pages/CommerceStudioPage.jsx'),'CommerceStudioPage');
const VoicePage=loadPage(()=>import('../pages/VoicePage.jsx'),'VoicePage');
const EmployeeEditor=loadPage(()=>import('../components/forms/EmployeeEditor.jsx'),'EmployeeEditor');
const ChiefPage=loadPage(()=>import('../pages/ChiefPage.jsx'),'ChiefPage');
const SetupPage=loadPage(()=>import('../pages/SetupPage.jsx'),'SetupPage');
import {LiveViewer} from '../components/LiveViewer.jsx';
import {OperationsTray} from '../components/OperationsTray.jsx';
import {useAppearance} from '../lib/appearance.jsx';
import {scheduleFormValues} from '../components/forms/ScheduleEditor.jsx';
import {ViewBoundary} from '../components/ViewBoundary.jsx';
const SchedulesPage=loadPage(()=>import('../pages/SchedulesPage.jsx'),'SchedulesPage');

export function App() {
  const {theme, toggleTheme} = useAppearance();
  const [session, setSession] = useState(null), [authProvider, setAuthProvider] = useState('local'), [pilotMode, setPilotMode] = useState(false), [chiefEnabled,setChiefEnabled]=useState(false), [sessionLoading, setSessionLoading] = useState(true), [bootstrapAttempt, setBootstrapAttempt] = useState(0), [route, setRoute] = useState(routeNow()), [data, setData] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState(''), [dialog, setDialog] = useState(null), [dialogBusy, setDialogBusy] = useState(false), [toast, setToast] = useState(null), [liveState, setLiveState] = useState('Live · changes sync'), [clock, setClock] = useState(''), [taskToOpen, setTaskToOpen] = useState(() => new URLSearchParams(location.hash.split('?')[1]||location.search).get('task'));
  const officeLayout = useRef(null), lastHash = useRef(location.hash), loadedRoute=useRef(null);
  const [viewer,setViewer]=useState(null),[invite,setInvite]=useState(()=>new URLSearchParams(location.search).get('invite'));
  const [chiefPrefill,setChiefPrefill]=useState(null);
  const publicPage = usePublicPage();
  const [, setHashTick] = useState(0); // re-render when the hash flips between landing and workspace
  useEffect(() => { const tick = () => setHashTick((value) => value + 1); window.addEventListener('hashchange', tick); return () => window.removeEventListener('hashchange', tick); }, []);
  const [revision, setRevision] = useState(0), socket = useRef(null), timer = useRef(null), reconnectTimer = useRef(null), toastTimeout = useRef(null), routeRef = useRef(route);
  const notify = useCallback((message, isError = false) => { setToast({ message, error: isError }); clearTimeout(toastTimeout.current); if(!isError) toastTimeout.current = setTimeout(() => setToast(null), 4000); }, []);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const syncWorkflowSnapshot = useCallback((workflow) => setData((current) => {
    if (!current?.workflows || !workflow?.id) return current;
    const index = current.workflows.findIndex((item) => item.id === workflow.id);
    const workflows = [...current.workflows];
    if (workflow.removed) workflows.splice(index, index < 0 ? 0 : 1);
    else if (index >= 0) workflows[index] = { ...workflows[index], ...workflow, id: workflows[index].id, goal: workflows[index].goal };
    else if (!workflows.some((item) => item.id === workflow.id)) workflows.unshift(workflow);
    return { ...current, workflows };
  }), []);
  const consumeTaskToOpen = useCallback(() => setTaskToOpen(null), []);
  const go = useCallback((next) => { const target = String(next || 'overview'); if(target.split('?')[0]!==routeRef.current && !confirmNavigation())return false; location.hash = target || 'overview'; lastHash.current=location.hash; setRoute(routeNow(pilotMode)); return true; }, [pilotMode]);
  const updateSession = useCallback(async (nextRoute) => { const current = await api('/api/auth/me'); if(nextRoute==='chief'&&chiefEnabled){location.hash='chief';lastHash.current=location.hash;setRoute('chief');}setSession(current);setInvite(new URLSearchParams(location.search).get('invite'));return current; }, [chiefEnabled]);

  useEffect(() => { routeRef.current = route; }, [route]);
  // Signed-in visitors on /login or /register go straight into the workspace, keeping any hash route.
  // After signing in from /login or /register, move into the workspace (keeping any deep link).
  useEffect(() => { if (session?.user && !invite && (publicPage === 'login' || publicPage === 'register')) { if (!isAppHash(location.hash)) history.replaceState(null, '', '/#overview'); navigatePublic('/', { replace: true, keepLocation: true }); setRoute(routeNow(pilotMode)); } }, [session?.user, invite, publicPage, pilotMode]);
  useEffect(() => { const handler = () => {const next=routeNow(pilotMode);if(next!==routeRef.current&&!confirmNavigation()){history.replaceState(null,'',location.pathname+location.search+lastHash.current);return;}lastHash.current=location.hash;setRoute(next);const task=new URLSearchParams(location.hash.split('?')[1]).get('task');if(task)setTaskToOpen(task);}; window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler); }, [pilotMode]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      if (!active) return;
      active = false;
      controller.abort();
      setError('The backend did not respond within 12 seconds. Start the workspace services, then retry.');
      setSessionLoading(false);
    }, 12000);
    Promise.all([
      api('/api/config', { signal: controller.signal }),
      api('/api/auth/me', { signal: controller.signal }),
    ]).then(([config, current]) => {
      if (!active) return;
      setAuthProvider(config.authProvider || 'local');
      setChiefEnabled(Boolean(config.chiefEnabled));
      const restricted = Boolean(config.pilotMode);
      setPilotMode(restricted);
      setRoute(routeNow(restricted));
      setSession(current);
    }).catch((reason) => {
      if (active) {
        controller.abort();
        setError(reason?.message || 'Could not connect to the backend.');
      }
    }).finally(() => {
      clearTimeout(timeout);
      if (active) setSessionLoading(false);
    });
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [bootstrapAttempt]);
  useEffect(() => { if (!session?.user) return; let active = true; if(loadedRoute.current!==route+'|'+session.organization.id)setLoading(true); setError(''); loadRouteData(route, session).then((value) => { if (active) { setData(value); loadedRoute.current=route+'|'+session.organization.id;setLoading(false); } }).catch((err) => { if (active) { setError(err.message);setData(null);loadedRoute.current=route+'|'+session.organization.id;setLoading(false); } }); return () => { active = false; }; }, [route, session?.organization?.id, session?.organization?.role, revision]);
  useEffect(() => { if (!session?.user) { socket.current?.close(); socket.current = null; return; } let active = true; const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; const connect = () => { if (!active) return; setLiveState('Connecting…'); const ws = new WebSocket(protocol + '//' + location.host + '/api/live'); socket.current = ws; ws.addEventListener('open', () => { if (active) { setLiveState('Live · changes sync'); if (routeRef.current !== 'tasks') refresh(); } }); ws.addEventListener('message', (event) => { let message = null; try { message = JSON.parse(event.data); } catch {} if (routeRef.current === 'tasks' && message?.workflowId) return; clearTimeout(timer.current); timer.current = setTimeout(refresh, 500); }); ws.addEventListener('close', () => { if (active) { setLiveState('Reconnecting…'); reconnectTimer.current = setTimeout(connect, 1800); } }); }; connect(); return () => { active = false; clearTimeout(timer.current); clearTimeout(reconnectTimer.current); socket.current?.close(); socket.current = null; }; }, [session?.user?.id, refresh]);
  useEffect(() => { const tick = () => setClock(new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })); tick(); const id = setInterval(tick, 30000); return () => clearInterval(id); }, []);

  const act = useCallback(async (action, id, extra) => {
    try {
      if (pilotMode && ['new-schedule','edit-schedule','pause-schedule','resume-schedule','delete-schedule'].includes(action)) return notify('Recurring schedules are unavailable in pilot mode.', true);
      if (action === 'navigate') return go(id);
      if (action === 'chief-hire') { setChiefPrefill({ specDraft:id.draft, chiefProposalId:id.proposalId }); return go('hire'); }
      if (action === 'hire' || action === 'compile-spec') return go('hire');
      if (action === 'edit-employee') return go('employee/'+id+'/edit');
      if (action === 'open-task') {setTaskToOpen(id);return go('tasks?task='+encodeURIComponent(id));}
      if (action === 'view-environment' || action === 'view-browser') return setViewer(action === 'view-environment'?{environmentId:id}:{workflowId:id});
      if (action === 'setup-employee') { const result = await api('/api/employees/' + encodeURIComponent(id) + '/setup', { method: 'POST', body: '{}' }); notify(result.created ? 'Browser profile and employee desktop VM are ready. Sign in to sites through the Solari profile editor before authenticated tasks.' : 'This employee already has an active browser profile and desktop VM.'); refresh(); return; }
      if (action === 'new-task' || action === 'task-for-employee') { const employees = await api('/api/employees'); if (!employees.some((item) => item.state === 'active')) return notify('Deploy an employee before assigning a live task.', true); setDialog({ type: 'task', data: { employees, employeeId: action === 'task-for-employee' ? id : '' } }); return; }
      if (action === 'new-simulation') { const [employees, catalog] = await Promise.all([api('/api/employees'), api('/api/policies')]); setDialog({ type: 'simulation', data: { employees, tools: catalog.tools } }); return; }
      if (action === 'edit-simulation') { const [simulations, catalog] = await Promise.all([api('/api/simulations'), api('/api/policies')]); setDialog({ type: 'simulation', data: { simulation: simulations.find((item) => item.id === id), tools: catalog.tools } }); return; }
      if (action === 'generate-simulation') { const [suiteDraft, catalog] = await Promise.all([api('/api/simulations/generate', { method: 'POST', body: JSON.stringify({ employeeId: id }) }), api('/api/policies')]); setDialog({ type: 'simulation', data: { suiteDraft, tools: catalog.tools } }); return; }
      if (action === 'run-simulation' || action === 'run-employee-simulation') { const [simulations, employees] = await Promise.all([api('/api/simulations'), api('/api/employees')]); if (!simulations.length) return notify('Add a simulation and an employee spec first.', true); setDialog({ type: 'run', data: { simulations, employees, simulationId: action === 'run-simulation' ? id : '', employeeId: action === 'run-employee-simulation' ? id : '' } }); return; }
      if (action === 'approval') { const workflow = await api('/api/workflows/' + encodeURIComponent(id)); setDialog({ type: 'approval', data: { workflow } }); return; }
      if (action === 'new-memory') return setDialog({ type: 'memory' });
      if (action === 'new-schedule' || action === 'edit-schedule') { const employees = await api('/api/employees'); setDialog({type:'schedule',data:{employees,schedule:action === 'edit-schedule' ? id : null}}); return; }
      if (['pause-schedule','resume-schedule','delete-schedule'].includes(action)) {
        if (action === 'delete-schedule' && !window.confirm('Delete this schedule? Existing tasks and recorded history are kept.')) return;
        const suffix = action === 'delete-schedule' ? '' : action === 'pause-schedule' ? '/pause' : '/resume';
        await api('/api/schedules/'+encodeURIComponent(id.id)+suffix,{method:action === 'delete-schedule' ? 'DELETE' : 'POST',body:JSON.stringify({revision:id.revision})});
        notify(action === 'delete-schedule' ? 'Schedule deleted.' : action === 'pause-schedule' ? 'Schedule paused.' : 'Schedule resumed.'); refresh(); return;
      }
      if (action === 'upload-document') return setDialog({ type: 'document' });
      if (action === 'new-coworker') return setDialog({ type: 'coworker' });
      if (action === 'edit-coworker') return setDialog({ type: 'coworker', data: { coworker: id } });
      if (action === 'new-meeting') { const employees = await api('/api/employees'); setDialog({ type: 'meeting', data: { employees } }); return; }
      if (action === 'new-meeting-action') return setDialog({ type: 'meeting-action', data: { meetingId: id, employees: extra || [] } });
      if (action === 'new-message' || action === 'meeting-message') { const employees = await api('/api/employees'); setDialog({ type: 'message', data: { employees, meetingId: action === 'meeting-message' ? id : '' } }); return; }
      if (action === 'invite') return setDialog({ type: 'invite' });
      if (action === 'integration') return setDialog({ type: 'integration', data: { provider: id } });
      if (action === 'new-policy') { const policies = await api('/api/policies'); setDialog({ type: 'policy', data: { tools: policies.tools } }); return; }
      if (action === 'add-room' || action === 'add-desk') return setDialog({ type: action === 'add-room' ? 'room' : 'desk' });
      if (action === 'edit-office-item') return setDialog({ type: extra.kind, data: { item: extra.item } });
      if (action === 'new-environment') { const profiles = await api('/api/solari/profiles').catch(() => []); setDialog({ type: 'environment', data: { profiles } }); return; }
      if (action === 'new-profile') return setDialog({ type: 'profile' });
      if (action === 'approve') { const pending = await api('/api/workflows/' + encodeURIComponent(id)); const approvalId = Object.values(pending.input_requests || {})[0]?.approvalId; await api('/api/workflows/' + encodeURIComponent(id) + '/approve', { method: 'POST', body: JSON.stringify({ approved: Boolean(extra), approvalId }) }); notify(extra ? 'Action approved and resumed.' : 'Action rejected and stopped.'); refresh(); return; }
      if (action === 'cancel-task') { if(!window.confirm('Cancel this task? Completed external actions will remain.'))return; await api('/api/workflows/' + encodeURIComponent(id) + '/cancel', { method: 'POST', body: '{}' }); notify('Task cancelled.'); refresh(); return; }
      if (['deploy-employee', 'archive-employee', 'restore-employee', 'pause-employee'].includes(action)) { if (action === 'archive-employee' && !window.confirm('Archive this employee? Their history stays available, and queued work will be cancelled.')) return; const suffix = action.replace('-employee', ''); await api('/api/employees/' + encodeURIComponent(id) + '/' + suffix, { method: 'POST', body: '{}' }); notify(({ deploy: 'Employee deployed.', archive: 'Employee archived.', restore: 'Employee restored as a draft.', pause: 'Employee paused.' })[suffix]); refresh(); return; }
      if (action === 'preview-document') {const document=await api('/api/documents/'+encodeURIComponent(id));return setDialog({type:'document-preview',data:{document}});}
      if (action === 'delete-document') { if (!window.confirm('Remove this document and its indexed passages?')) return; await api('/api/documents/' + encodeURIComponent(id), { method: 'DELETE', body: '{}' }); notify('Document removed.'); refresh(); return; }
      if (action === 'prepare-meeting' || action === 'discuss-meeting' || action === 'run-meeting') { const endpoint = ({ 'prepare-meeting': 'prepare', 'discuss-meeting': 'discuss', 'run-meeting': 'run' })[action]; const result = await api('/api/meetings/' + encodeURIComponent(id) + '/' + endpoint, { method: 'POST', body: '{}' }); notify(action === 'prepare-meeting' ? result.briefs.length + ' private brief(s) prepared.' : action === 'discuss-meeting' ? result.generated + ' agent update(s) added.' : result.decisions.length + ' decision(s) recorded.'); refresh(); return; }
      if (action === 'respond-delegation') { const result = await api('/api/messages/' + encodeURIComponent(id) + '/respond', { method: 'POST', body: JSON.stringify({ decision: extra }) }); notify(extra === 'accept' ? 'Delegated task approved and queued.' : 'Delegation declined.'); refresh(); return result; }
      if (action === 'complete-action') { await api('/api/action-items/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ status: 'done' }) }); notify('Action marked done.'); refresh(); return; }
      if (action === 'reassign-action') { await api('/api/action-items/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ employeeId: extra || null }) }); notify('Meeting action reassigned.'); refresh(); return; }
      if (action === 'start-action') { await api('/api/action-items/' + encodeURIComponent(id) + '/start', { method: 'POST', body: '{}' }); notify('Meeting action started as a task.'); refresh(); return; }
      if (action === 'toggle-policy') { await api('/api/policies/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ active: Boolean(extra) }) }); notify('Policy updated.'); refresh(); return; }
      if (action === 'refresh-mcp') { await api('/api/mcp-connections/' + encodeURIComponent(id) + '/refresh', { method: 'POST', body: '{}' }); notify('MCP tools refreshed.'); refresh(); return; }
      if (action === 'disconnect-mcp') { if (!window.confirm('Disconnect this MCP server? Its token will be removed and employee grants will stop working.')) return; await api('/api/mcp-connections/' + encodeURIComponent(id), { method: 'DELETE', body: '{}' }); notify('MCP server disconnected.'); refresh(); return; }
      if (action === 'delete-coworker') { if (!window.confirm('Delete this coworker profile? Related context may no longer be available.')) return; await api('/api/coworkers/' + encodeURIComponent(id), { method: 'DELETE', body: '{}' }); notify('Coworker profile deleted.'); refresh(); return; }
      if (action === 'delete-relationship') { if (!window.confirm('Remove this coworker relationship?')) return; await api('/api/coworker-relationships/' + encodeURIComponent(id), { method: 'DELETE', body: '{}' }); notify('Coworker relationship removed.'); refresh(); return; }
      if (action === 'new-relationship') { const people = (await api('/api/coworkers')).filter((item) => !item.isMember); if (people.length < 2) return notify('Add at least two coworker profiles first.', true); setDialog({ type: 'relationship', data: { people } }); return; }
      if (action === 'new-mcp') { setDialog({ type: 'mcp' }); return; }
      if (action === 'export-events') { const events = await api('/api/events?limit=200'); const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' })); link.download = 'crewos-audit-' + new Date().toISOString().slice(0, 10) + '.json'; link.click(); URL.revokeObjectURL(link.href); return; }
      if (action === 'retry-job') { await api('/api/jobs/'+encodeURIComponent(id)+'/retry',{method:'POST',body:'{}'}); notify('The operation was queued again.'); refresh(); return; }
      if (action === 'connect-slack') { location.assign('/api/slack/connect'); return; }
      if (action === 'configure-slack') { setDialog({type:'slack-channels',data:{channels:id || []}}); return; }
      if (action === 'link-slack') { await api('/api/slack/link',{method:'POST',body:JSON.stringify({token:id})}); const url=new URL(location.href); url.searchParams.delete('slack_link'); history.replaceState(null,'',url); notify('Slack account linked.'); refresh(); return; }
      if (action === 'required-probation') { const result=await api('/api/employees/'+encodeURIComponent(id)+'/probation',{method:'POST',body:'{}'}); notify(result.passed ? 'Required probation passed.' : 'Required probation needs review.',!result.passed); refresh(); return; }
      if (action === 'reconcile-task') { await api('/api/workflows/'+encodeURIComponent(id)+'/reconcile',{method:'POST',body:'{}'}); notify('The Jira operation was verified and the task resumed.'); refresh(); return; }
      if (action === 'connect-jira') { location.assign('/api/integrations/jira/connect'); return; }
      if (action === 'configure-jira-project') { const sites = await api('/api/integrations/jira/sites'); setDialog({ type: 'jira', data: sites }); return; }
      if (action === 'create-app-profile') { setDialog({ type: 'profile', description: 'This creates a persistent Solari browser profile for ' + id + '. After it is created, sign in to ' + id + ' through the Solari profile editor, then select the profile on the employee and grant browser access.', data: { profileName: id, returnToOffice: true } }); return; }
      if (action === 'new-solari-profile') return setDialog({ type: 'profile' });
      if (action === 'delete-profile') { if (!window.confirm('Delete this saved login from Solari?')) return; await api('/api/solari/profiles/' + encodeURIComponent(id), { method: 'DELETE', body: '{}' }); notify('Browser profile deleted.'); refresh(); return; }
      if (action === 'stop-environment') { if(!window.confirm('Stop this session? Unsaved session changes may be lost.'))return; await api('/api/environments/' + encodeURIComponent(id), { method: 'DELETE', body: '{}' }); notify('Solari environment stopped.'); refresh(); return; }
      if (action === 'pause-environment' || action === 'resume-environment') { const verb = action === 'pause-environment' ? 'pause' : 'resume'; await api('/api/environments/' + encodeURIComponent(id) + '/' + verb, { method: 'POST', body: '{}' }); notify('Solari environment ' + (verb === 'pause' ? 'paused.' : 'resumed.')); refresh(); return; }
      if (action === 'snapshot-environment') { const name = window.prompt('Snapshot name (optional):'); if (name === null) return; await api('/api/environments/' + encodeURIComponent(id) + '/snapshots', { method: 'POST', body: JSON.stringify(name.trim() ? { name: name.trim() } : {}) }); notify('Environment snapshot saved.'); refresh(); return; }
      if (action === 'revert-environment') { const snapshot = extra; if (!window.confirm('Revert this environment to “' + (snapshot.name || 'Snapshot') + '”? Current state will be replaced.')) return; await api('/api/environments/' + encodeURIComponent(id) + '/revert', { method: 'POST', body: JSON.stringify({ snapshotId: snapshot.snapshotId }) }); notify('Environment reverted to snapshot.'); refresh(); return; }
      if (action === 'save-layout') { const office = officeLayout.current || await api('/api/office'); await api('/api/office/layout', { method: 'PUT', body: JSON.stringify({ rooms: office.rooms || [], desks: office.desks || [] }) }); notify('Office layout saved.'); refresh(); return; }
      if (action === 'compile-spec') { const [documents, catalog] = await Promise.all([api('/api/documents'), api('/api/policies')]); setDialog({ type: 'compile', data: { documents, tools: catalog.tools } }); return; }
      if (action === 'simulation-evidence') { const run = await api('/api/simulation-runs/' + encodeURIComponent(id)); setDialog({ type: 'evidence', data: { run } }); return; }
    } catch (error) { notify(error.message, true); }
  }, [go, notify, pilotMode, refresh]);

  const onEditOffice = useCallback((kind, item) => act('edit-office-item', '', { kind, item }), [act]);
  const onCanvasError = useCallback((error) => notify(error.message || String(error), true), [notify]);
  const setOfficeLayout = useCallback((value) => { officeLayout.current = value; }, []);
  async function submitDialog(type, form, activeDialog) {
    setDialogBusy(true);
    let refreshAfterSubmit = true;
    try {
      const values = formObject(form), data = activeDialog.data || {};
      if (type === 'employee') {
        const current = data.employee?.spec || data.specDraft || {}, selectedTools = new FormData(form).getAll('tools');
        const metrics = lines(values.successMetrics).map((line) => line.split('|').map((part) => part.trim())).filter(([name]) => name).map(([name, target]) => ({ name, target: Number(target) }));
        const payload = { name: values.name, title: values.title, department: values.department, avatar: values.avatar || '◉', profileId: values.profileId || null, identity: { name: values.name, title: values.title, departmentId: values.department, managerId: current.identity?.managerId, avatarId: values.avatar || '◉' }, mission: values.mission, responsibilities: lines(values.responsibilities), successMetrics: metrics, capabilities: capabilityRows(values.capabilities), tools: selectedTools, policies: lines(values.policies), coworkers: lines(values.coworkers), evaluationPolicy: values.evaluationPolicy };
        payload.provenance = provenanceForEditedFields(current, payload, current.provenance || [{ source: 'Manager input', confidence: 1 }]);
        await api(data.employee ? '/api/employees/' + encodeURIComponent(data.employee.id) + '/spec' : '/api/employees', { method: data.employee ? 'PUT' : 'POST', body: JSON.stringify(payload) }); notify(data.employee ? 'New spec version saved. Run probation again.' : 'Employee draft created. Run probation next.');
      } else if (type === 'task') { const created = await api('/api/workflows', { method: 'POST', body: JSON.stringify({ employeeId: values.employeeId, goal: values.goal }) }); setTaskToOpen(created.taskId||created.id); go('tasks'); refreshAfterSubmit = route === 'tasks'; notify('Task queued. Its activity is streaming live.'); }
      else if (type === 'schedule') { const schedule = data.schedule; const payload = {...scheduleFormValues(values),...(schedule ? {revision:schedule.revision} : {})}; await api('/api/schedules'+(schedule ? '/'+encodeURIComponent(schedule.id) : ''),{method:schedule ? 'PATCH' : 'POST',body:JSON.stringify(payload)}); notify(schedule ? 'Schedule updated.' : 'Schedule created.'); }
      else if (type === 'slack-channels') { await api('/api/slack',{method:'PATCH',body:JSON.stringify({channels:lines(values.channels)})}); notify('Approved Slack channels updated. Invite the bot to these channels.'); }
      else if (type === 'run') { const result = await api('/api/simulations/' + encodeURIComponent(values.simulationId) + '/run', { method: 'POST', body: JSON.stringify({ employeeId: values.employeeId }) }); notify('Simulation ' + (result.passed ? 'passed' : 'needs review') + ' · ' + Math.round(result.score * 100) + '%'); }
      else if (type === 'simulation') {
        const actions = jsonField(values.actionsJson, 'Policy actions', []), rubric = jsonField(values.rubricJson, 'Scoring rubric', []);
        if (!Array.isArray(actions) || !actions.length || actions.length > 20) throw new Error('Policy actions must be a JSON array with 1–20 actions.');
        if (!Array.isArray(rubric) || rubric.length !== actions.length) throw new Error('Scoring rubric must be a JSON array with one criterion per action.');
        const suite = { name: values.name, description: values.description, threshold: Number(values.threshold || 1), scenario: { objective: values.objective || values.description, initialState: jsonField(values.initialStateJson, 'Initial state', {}), events: jsonField(values.eventsJson, 'Events', []), actions }, rubric };
        await api(data.simulation ? '/api/simulations/' + encodeURIComponent(data.simulation.id) : '/api/simulations', { method: data.simulation ? 'PATCH' : 'POST', body: JSON.stringify(suite) }); notify(data.simulation ? 'Evaluation suite updated.' : 'Simulation suite saved.');
      } else if (type === 'meeting') { const local = values.startsAt ? new Date(values.startsAt).toISOString() : null; await api('/api/meetings', { method: 'POST', body: JSON.stringify({ title: values.title, agenda: lines(values.agenda), participantIds: new FormData(form).getAll('participantIds'), startsAt: local }) }); notify('Meeting scheduled.'); }
      else if (type === 'meeting-action') { await api('/api/meetings/' + encodeURIComponent(data.meetingId) + '/actions', { method: 'POST', body: JSON.stringify({ title: values.title, employeeId: values.employeeId || null }) }); notify('Follow-up action added.'); }
      else if (type === 'memory') { await api('/api/memories', { method: 'POST', body: JSON.stringify(values) }); notify('Memory saved. Search indexing is queued.'); }
      else if (type === 'document') { const file = form.querySelector('input[type=file]').files?.[0]; if (!file) throw new Error('Choose a document first.'); if (file.size > 7.5 * 1024 * 1024) throw new Error('Document must be 7.5 MB or smaller.'); const contentBase64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Could not read the document.')); reader.readAsDataURL(file); }); const result = await api('/api/documents', { method: 'POST', body: JSON.stringify({ filename: file.name, contentBase64 }) }); notify(result.passages + ' passages saved. Search indexing is queued.'); }
      else if (type === 'coworker') { const coworker = data.coworker; await api(coworker ? '/api/coworkers/' + encodeURIComponent(coworker.id) : '/api/coworkers', { method: coworker ? 'PATCH' : 'POST', body: JSON.stringify({ name: values.name, role: values.role, expertise: lines(values.expertise), summary: values.summary }) }); notify(coworker ? 'Coworker profile updated.' : 'Coworker profile added.'); }
      else if (type === 'invite') { const result = await api('/api/members/invite', { method: 'POST', body: JSON.stringify({ email: values.email, role: values.role }) }); setDialog({type:'invite-result',data:{inviteUrl:result.inviteUrl,email:values.email}});notify('Invitation created.');refresh();return; }
      else if (type === 'integration') { await api('/api/integrations/' + encodeURIComponent(data.provider), { method: 'PUT', body: JSON.stringify({ secret: values.secret }) }); notify(pretty(data.provider) + ' connected.'); }
      else if (type === 'policy') { await api('/api/policies', { method: 'POST', body: JSON.stringify({ name: values.name, tool: values.tool, effect: values.effect, condition: jsonField(values.condition, 'Condition', {}) }) }); notify('Policy rule saved.'); }
      else if (type === 'room' || type === 'desk') {
        const office = await api('/api/office'); const items = type === 'room' ? office.rooms || [] : office.desks || [], item = { ...values, x: Number(values.x), y: Number(values.y) }; if (type === 'room') { item.w = Number(values.w); item.h = Number(values.h); }
        const index = items.findIndex((entry) => entry.id === item.id); if (index < 0) items.push(item); else items[index] = item;
        await api('/api/office/layout', { method: 'PUT', body: JSON.stringify({ rooms: type === 'room' ? items : office.rooms, desks: type === 'desk' ? items : office.desks }) }); notify('Office ' + type + ' saved.');
      } else if (type === 'environment') { await api('/api/environments', { method: 'POST', body: JSON.stringify({ kind: values.kind, label: values.label, profileId: values.profileId || null }) }); notify('Solari environment started.'); }
      else if (type === 'profile') { const result = await api('/api/solari/profiles', { method: 'POST', body: JSON.stringify({ name: values.name }) }); notify(data.returnToOffice ? result.name + ' profile created. Sign in through the Solari profile editor, then select it on an employee.' : result.name + ' created.'); if (data.returnToOffice) go('office'); }
      else if (type === 'message') { const messageType = values.messageType || 'message'; await api('/api/messages', { method: 'POST', body: JSON.stringify({ type: messageType, fromEmployeeId: values.fromEmployeeId || null, toEmployeeId: values.toEmployeeId || null, meetingId: data.meetingId || null, body: values.body, requestedGoal: values.requestedGoal || undefined, evidenceIds: String(values.evidenceIds || '').split(',').map((item) => item.trim()).filter(Boolean) }) }); notify(messageType === 'delegation_request' ? 'Delegation request added for manager review.' : 'Message recorded.'); }
      else if (type === 'approval') { const approved = values.approved === 'true', requests = data.workflow?.input_requests || {}, request = Object.values(requests).find((item) => item?.method === 'mcp.tasks/update'), mcpResponses = {}; if (approved && request) { for (const key of Object.keys(request.params?.inputRequests || {})) { const response = jsonField(values['mcpResponse_' + key], 'MCP response for ' + key, null); if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('MCP response for ' + key + ' must be a JSON object.'); mcpResponses[key] = response; } } await api('/api/workflows/' + encodeURIComponent(data.workflow.id) + '/approve', { method: 'POST', body: JSON.stringify({ approved, approvalId:Object.values(requests)[0]?.approvalId, note: values.note, ...(request && approved ? { mcpResponses } : {}) }) }); notify(approved ? 'Action approved and resumed.' : 'Action rejected and stopped.'); }
      else if (type === 'org') { await api('/api/org', { method: 'PATCH', body: JSON.stringify({ name: values.name }) }); await updateSession(); notify('Workspace settings saved.'); }
      else if (type === 'mcp') { await api('/api/mcp-connections', { method: 'POST', body: JSON.stringify({ name: values.name, endpoint: values.endpoint, token: values.token || undefined }) }); notify('MCP server connected.'); }
      else if (type === 'relationship') { const local = values.lastInteractionAt ? new Date(values.lastInteractionAt).toISOString() : null; await api('/api/coworker-relationships', { method: 'POST', body: JSON.stringify({ fromCoworkerId: values.fromCoworkerId, toCoworkerId: values.toCoworkerId, lastInteractionSummary: values.lastInteractionSummary, lastInteractionAt: local }) }); notify('Coworker relationship added.'); }
      else if (type === 'compile') { const result = await api('/api/specs/compile', { method: 'POST', body: JSON.stringify({ title: values.title, department: values.department, name: values.name, notes: values.notes, documentIds: new FormData(form).getAll('documentIds') }) }); const [catalog, profiles] = await Promise.all([api('/api/policies'), api('/api/solari/profiles').catch(() => [])]); setDialog({ type: 'employee', description: 'Documents are evidence. Review the draft, choose tool grants, and save the EmployeeSpec.', data: { specDraft: result.draft, toolSuggestions: result.toolSuggestions, tools: catalog.tools, profiles } }); setDialogBusy(false); return; }
      else if (type === 'jira') { if (!values.cloudId || !values.projectKey) throw new Error('Choose an authorized Jira site and project.'); await api('/api/integrations/jira/config', { method: 'PUT', body: JSON.stringify({ cloudId: values.cloudId, projectKey: values.projectKey, issueType: values.issueType || 'Task' }) }); notify('Jira project selected.'); }
      setDialog(current=>current===activeDialog?null:current); if (refreshAfterSubmit) refresh();
    } catch (error) { throw error; }
    finally { setDialogBusy(false); }
  }

  async function changeOrganization(organizationId) { if(!confirmNavigation())return;try { await api('/api/org/switch', { method: 'POST', body: JSON.stringify({ organizationId }) }); await updateSession(); notify('Workspace switched.'); } catch (error) { notify(error.message, true); } }
  async function logout() { if(!confirmNavigation())return;if (authProvider === 'neon') await neonAuth('sign-out').catch(() => {}); await api('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {}); socket.current?.close(); setSession(null); setData(null); lastHash.current=''; navigatePublic(PUBLIC_PATHS.landing, { replace: true }); setRoute(routeNow(pilotMode)); }
  function retryStartup() { setError(''); setSessionLoading(true); setBootstrapAttempt((attempt) => attempt + 1); }

  const signedIn = Boolean(session?.user);
  // "/" is the public landing page unless the visitor is signed in or following a workspace deep link.
  // "/" and "/landing" are public for everyone; a workspace hash ("/#tasks") opens the app or sign-in.
  const showLanding = !invite && publicPage === 'landing' && !isAppHash(location.hash);
  useEffect(() => {
    document.title = showLanding ? 'CrewOS · AI employees for founders'
      : !signedIn || invite ? (publicPage === 'register' && !invite ? 'Create your workspace · CrewOS' : 'Sign in · CrewOS')
        : 'CrewOS · AI employee workspace';
  }, [showLanding, signedIn, invite, publicPage]);
  let page = null;
  if (data) {
    if (route === 'overview') page = <Overview data={data} session={session} actions={act} refresh={refresh}/>;
    else if (route === 'employees') page = <EmployeesPage employees={data} session={session} actions={act}/>;
    else if (route === 'setup') page = isManager(session)?<SetupPage data={data} session={session} actions={act}/>:<Empty title="Manager access required">A manager can complete workspace setup.</Empty>;
    else if (route === 'chief') page = isManager(session)?<ChiefPage data={data} actions={act} refresh={refresh}/>:<Empty title="Manager access required">A workspace manager can work with Chief.</Empty>;
    else if (route === 'hire' || route.endsWith('/edit')) page = isManager(session)?<EmployeeEditor key={route} data={{...data,...(route==='hire'?chiefPrefill||{}:{})}} actions={act} notify={notify} onSaved={id=>{setChiefPrefill(null);go('employee/'+id);refresh();}}/>:<Empty title="Manager access required">Ask a workspace manager to edit employee roles.</Empty>;
    else if (route.startsWith('employee/')) page = <EmployeeDetail employee={data} session={session} actions={act}/>;
    else if (route === 'tasks') page = <TasksPage data={data} session={session} actions={act} initialTaskId={taskToOpen} onInitialTaskOpened={consumeTaskToOpen} onWorkflowUpdate={syncWorkflowSnapshot}/>;
    else if (route === 'probation') page = <ProbationPage data={data} session={session} actions={act}/>;
    else if (route === 'schedules' && !pilotMode) page = <SchedulesPage data={data} session={session} actions={act}/>;
    else if (route === 'memory') page = <MemoryPage data={data} session={session} actions={act} notify={notify}/>;
    else if (route === 'coworkers') page = <CoworkersPage data={data} session={session} actions={act}/>;
    else if (route === 'meetings') page = <MeetingsPage meetings={data} session={session} actions={act}/>;
    else if (route.startsWith('meeting/')) page = <MeetingDetail meeting={data} session={session} actions={act}/>;
    else if (route === 'office') page = <OfficePage data={data} session={session} actions={act} notify={notify} onEdit={onEditOffice} onError={onCanvasError} onOfficeModel={setOfficeLayout}/>;
    else if (route === 'integrations') page = <IntegrationsPage data={data} session={session} actions={act}/>;
    else if (route === 'commerce') page = isManager(session)?<CommerceStudioPage data={data} refresh={refresh}/>:<Empty title="Manager access required">Ask a workspace manager to review Commerce Studio setup.</Empty>;
    else if (route === 'voice') page = isManager(session)?<VoicePage data={data} user={session.user}/>:<Empty title="Manager access required">A workspace manager can configure Sarvam voice sessions.</Empty>;
    else if (route === 'reports') page = <ReportsPage data={data} session={session} actions={act}/>;
    else if (route === 'settings') page = <SettingsPage data={data} session={session} actions={act} notify={notify} refresh={refresh} updateSession={updateSession}/>;
  }
  if (showLanding) return <><LandingPage signedIn={signedIn}/><Toast toast={toast} onClose={()=>setToast(null)}/></>;
  if (sessionLoading) return <main className="boot-screen" role="status" aria-live="polite"><div className="boot-mark" aria-hidden="true">C<span>•</span></div><p>Connecting to your workspace…</p><div className="boot-progress" aria-hidden="true"/></main>;
  if (error && !session) return <main className="boot-failure"><section className="boot-failure-card" role="alert"><div className="boot-mark" aria-hidden="true">C<span>•</span></div><h1>Couldn’t reach CrewOS</h1><p>{error}</p><Button kind="btn-primary" onClick={retryStartup}>Retry connection</Button></section></main>;
  if (!session?.user || invite) return <><AuthView invite={invite} page={publicPage} signedIn={session?.user} authProvider={authProvider} onComplete={updateSession} notify={notify}/><Toast toast={toast} onClose={()=>setToast(null)}/></>;
  return <><AppShell session={session} route={route} go={go} actions={act} clock={clock} refresh={refresh} theme={theme} onToggleTheme={toggleTheme} onOrgChange={changeOrganization} onLogout={logout} liveState={liveState} pilotMode={pilotMode}>{loading || loadedRoute.current!==route+'|'+session.organization.id ? <div className="loading-line" role="status" aria-label={routeLoadingLabel(route)}/> : error ? <div className="panel"><Empty icon="!" title="Could not load this view">{error} <Button onClick={() => { setError(''); refresh(); }}>Try again</Button></Empty></div> : <ViewBoundary key={route+session.organization.id}><Suspense fallback={<div className="loading-line" role="status" aria-label={routeLoadingLabel(route)}/>}>{page}</Suspense></ViewBoundary>}</AppShell><LiveViewer viewer={viewer} onClose={()=>setViewer(null)}/><OperationsTray/><Dialog dialog={dialog} session={session} onClose={() => setDialog(null)} onSubmit={submitDialog} busy={dialogBusy}/><Toast toast={toast} onClose={()=>setToast(null)}/></>;
}
