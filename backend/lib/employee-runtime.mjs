import { repositories } from '../src/repositories/index.mjs';
import { registerJobHandler } from './jobs.mjs';
import { getSecret } from './secrets.mjs';
import { createHash } from 'node:crypto';
import { closeEnvironment, createSolariEnvironment, createSolariProfile, deleteSolariProfile } from './solari.mjs';
import { id, lockEmployee, now, transaction } from './db.mjs';

function profileKeyHash(apiKey) {
  return createHash('sha256').update(String(apiKey || '')).digest('hex');
}

async function runtimeSetupRow(orgId, employeeId) {
  return repositories.employees.findOneEmployeeRuntimeSetupByOrgIdAndEmployeeId(orgId, employeeId);
}

export async function getEmployeeRuntimeSetup(orgId, employeeId) {
  const row = await runtimeSetupRow(orgId, employeeId);
  if (!row) return null;
  return {
    status: row.status,
    ready: row.status === 'ready' && Boolean(row.browser_profile_id || row.desktop_environment_id),
    browserProfile: row.browser_profile_id ? { id: row.browser_profile_id, name: row.browser_profile_name || 'Employee browser profile' } : null,
    desktop: row.desktop_environment_id ? {
      environmentId: row.desktop_environment_id,
      status: row.desktop_status || 'missing',
      label: row.desktop_label || 'Employee desktop',
    } : null,
  };
}

export async function provisionEmployeeRuntimeSetup({ orgId, employeeId, employeeName, userId, apiKey, onEvent }) {
  if (!apiKey) throw Object.assign(new Error('Connect Solari in Settings before setting up this employee.'), { httpStatus: 409, code: 'solari_not_configured' });

  const reservation = await transaction(async () => {
    if (!(await lockEmployee(orgId, employeeId))) throw Object.assign(new Error('Employee not found.'), { httpStatus: 404, code: 'not_found' });
    const specRow=await repositories.employees.findOneEmployeeSpecByEmployeeIdSelectData(employeeId);
    const grants=JSON.parse(specRow?.data || '{}').tools || [];
    const needsBrowser=grants.some(tool => ['solari.browser.open','solari.browser.interact'].includes(tool));
    const needsDesktop=grants.includes('solari.desktop.exec');
    if (!needsBrowser && !needsDesktop) throw Object.assign(new Error('This employee does not need a Solari browser or desktop.'),{httpStatus:409});
    const existing = await runtimeSetupRow(orgId, employeeId);
    if (existing?.status === 'provisioning' && existing.lease_expires_at && Date.parse(existing.lease_expires_at)>Date.now()) {
      throw Object.assign(new Error('This employee’s runtime setup is already in progress.'), { httpStatus: 409, code: 'setup_in_progress' });
    }
    const desktopIsRunning = existing?.desktop_status === 'running';
    const browserProfileIsValid = existing?.browser_profile_id && existing.browser_profile_key_hash === profileKeyHash(apiKey);
    if (existing?.status === 'ready' && (!needsDesktop || desktopIsRunning) && (!needsBrowser || browserProfileIsValid)) {
      return { existing: true, row: existing };
    }
    const timestamp = now();
    await repositories.employees.insertEmployeeRuntimeSetup(employeeId, orgId, timestamp, timestamp);
    await repositories.employees.updateEmployeeRuntimeSetupByOrgIdAndEmployeeId(new Date(Date.now()+120000).toISOString(), orgId, employeeId);
    return { existing: false, row: existing || null, reservationAt:timestamp,needsBrowser,needsDesktop };
  });

  if (reservation.existing) return { setup: await getEmployeeRuntimeSetup(orgId, employeeId), created: false };

  const previous = reservation.row;
  const previousProfileValid = previous?.browser_profile_id && previous.browser_profile_key_hash === profileKeyHash(apiKey);
  const canRestorePreviousSetup = previous?.status === 'ready' && previousProfileValid && previous.desktop_status === 'running';
  let createdProfile = null;
  let createdDesktop = null;
  let browserProfileId = previous?.browser_profile_id || null;
  let desktopEnvironmentId = previous?.desktop_environment_id || null;
  try {
    if (reservation.needsBrowser && !previousProfileValid) {
      createdProfile = await createSolariProfile(orgId, userId, `${employeeName} browser`, apiKey);
      browserProfileId = createdProfile.id;
    }
    // A browser profile is tied to the Solari API key. If that key changes,
    // recreate the desktop too because the old provider resource may not be
    // reachable with the newly connected workspace credential.
    if (reservation.needsDesktop && previous?.desktop_status !== 'running') {
      createdDesktop = await createSolariEnvironment(orgId, userId, 'desktop', `${employeeName} desktop`, apiKey);
      desktopEnvironmentId = createdDesktop.id;
    }

    const saved = await repositories.employees.updateEmployeeRuntimeSetupByOrgIdAndEmployeeIdAndStatus(browserProfileId, desktopEnvironmentId, now(), orgId, employeeId, reservation.reservationAt);
    if (saved.changes !== 1) throw new Error('This runtime reservation expired; retry setup.');
  } catch (error) {
    await repositories.employees.updateEmployeeRuntimeSetupByOrgIdAndEmployeeIdAndStatusSetStatusUpdatedAt(canRestorePreviousSetup ? 'ready' : 'failed', now(), orgId, employeeId, reservation.reservationAt).catch(() => {});
    if (createdDesktop) await closeEnvironment(orgId, createdDesktop.id, apiKey).catch(() => {});
    if (createdProfile) await deleteSolariProfile(orgId, createdProfile.id, apiKey).catch(() => {});
    await Promise.resolve(onEvent?.('employee.runtime_setup.failed', { employeeId, error: String(error?.message || 'Solari setup failed.').slice(0, 240) })).catch(() => {});
    throw Object.assign(new Error(String(error?.message || 'Could not create the employee browser profile and desktop VM.').slice(0, 300)), {
      status: Number.isInteger(error?.status) ? error.status : Number.isInteger(error?.httpStatus) ? error.httpStatus : 502,
      httpStatus: Number.isInteger(error?.httpStatus) ? error.httpStatus : 502,
      code: error?.code || 'employee_setup_failed',
    });
  }

  const setup = await getEmployeeRuntimeSetup(orgId, employeeId);
  await Promise.resolve(onEvent?.('employee.runtime_setup.completed', {
    employeeId,
    browserProfileId,
    desktopEnvironmentId,
    reusedBrowserProfile: !createdProfile,
    reusedDesktop: !createdDesktop,
  })).catch(() => {});
  if (previous?.browser_profile_id && previous.browser_profile_id !== browserProfileId) {
    await deleteSolariProfile(orgId, previous.browser_profile_id, apiKey).catch(() => {});
  }
  if (previous?.desktop_environment_id && previous.desktop_environment_id !== desktopEnvironmentId) {
    await closeEnvironment(orgId, previous.desktop_environment_id, apiKey).catch(() => {});
  }
  return { setup, created: true };
}

export async function getEmployeeDesktopEnvironmentId(orgId, employeeId) {
  const row = await repositories.employees.findOneEmployeeRuntimeSetupByOrgIdAndEmployeeIdAndStatus(orgId, employeeId);
  return row?.status === 'running' ? row.environment_id : null;
}

export async function getEmployeeBrowserProfileId(orgId, employeeId) {
  const row = await repositories.employees.findOneEmployeeRuntimeSetupByOrgIdAndEmployeeIdAndStatusSelectBrowserProfileIdKeyHash(orgId, employeeId);
  return row?.browser_profile_id || null;
}

registerJobHandler('runtime.cleanup',async (payload,job) => {
  const employee=await repositories.employees.findOneEmployeeByOrgIdAndId(job.org_id, payload.employeeId);
  if (employee?.state !== 'archived') return {skipped:true};
  const setup=await runtimeSetupRow(job.org_id,String(payload.employeeId));
  if (!setup) return {skipped:true};
  const apiKey=await getSecret(job.org_id,'solari');
  if (setup.desktop_environment_id && setup.desktop_status !== 'stopped') await closeEnvironment(job.org_id,setup.desktop_environment_id,apiKey);
  if (setup.browser_profile_id) await deleteSolariProfile(job.org_id,setup.browser_profile_id,apiKey);
  await repositories.employees.deleteEmployeeRuntimeSetupByOrgIdAndEmployeeId(job.org_id, payload.employeeId);
  return {released:true};
});
