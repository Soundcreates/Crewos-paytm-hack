export const NAV_GROUPS = [
  ['CrewOS', [['voice','Voice interview','meetings'],['simulation','Workspace','overview']]],
];
export const NAV = [...NAV_GROUPS.flatMap(([,items])=>items)];
export function navigationGroupsForMode(pilotMode = false) {
  if (!pilotMode) return NAV_GROUPS;
  return NAV_GROUPS.map(([group, items]) => [group, items.filter(([key]) => key !== 'schedules')]).filter(([, items]) => items.length);
}
export const TOOL_OPTIONS = [
  ['solari.browser.open', 'Open web pages'], ['solari.browser.interact', 'Interact with web pages · workspace policy'],
  ['solari.sandbox.echo', 'Run sandbox checks'], ['solari.desktop.exec', 'Run desktop commands · workspace policy'],
  ['jira.create_issue', 'Create work items'], ['jira.delete_issue', 'Delete work items · workspace policy'],
  ['payments.refund', 'Issue refunds · policy review'], ['payments.transfer', 'Transfer funds · policy review'], ['account.delete', 'Delete accounts · always blocked'],
];

export const routeFromHash = (hash, pilotMode = false) => {
  const route = String(hash || '').replace(/^#\/?/, '').split('?')[0] || 'overview';
  const visibleRoutes = navigationGroupsForMode(pilotMode).flatMap(([, items]) => items.map(([key]) => key));
  return visibleRoutes.includes(route) ? route : 'voice';
};
export const routeNow = (pilotMode = false) => routeFromHash(location.hash, pilotMode);
let unsavedChanges=false;
export const setUnsavedChanges=value=>{unsavedChanges=Boolean(value);};
export function confirmNavigation(){if(!unsavedChanges)return true;if(!window.confirm('Discard your unsaved role changes?'))return false;unsavedChanges=false;return true;}
