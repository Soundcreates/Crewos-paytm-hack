import { repositories } from '../src/repositories/index.mjs';
import { canExecuteSimulationTool, validateBrowserActions, validatePublicBrowserTarget } from 'solari-crew-core';
import { createHash } from 'node:crypto';
import { id, now } from './db.mjs';
import { assertPublicHost, validateSolariBrowserSession } from './solari-network.mjs';

export { assertPublicHost, isPrivateAddress, validateSolariBrowserSession } from './solari-network.mjs';

const gateway = process.env.SOLARI_BASE_URL || 'https://api.getsolari.com';
const browserGateway = process.env.SOLARI_BROWSER_BASE_URL || 'https://api.getsolari.com';
const workflowBrowsers = new Map();
function requireKey(key = process.env.SOLARI_API_KEY) {
  if (!key) throw new Error('Connect a Solari key in Integrations or set SOLARI_API_KEY on the server.');
  return key;
}
async function solariBrowser(key) {
  const { Solari } = await import('@solarisdk/browser');
  return new Solari({ apiKey: requireKey(key), baseUrl: browserGateway });
}
function keyHash(key) { return createHash('sha256').update(requireKey(key)).digest('hex'); }
async function profileForOrg(orgId, profileId, apiKey) {
  if (!profileId) return null;
  const profile = (await repositories.integrations.findOneSolariProfileByIdAndOrgIdSelectIdProviderIdKeyHash(profileId, orgId));
  if (!profile) throw new Error('Solari profile not found in this workspace.');
  if (profile.key_hash !== keyHash(apiKey)) throw new Error('This profile belongs to a different Solari key. Reconnect the workspace key and choose one of its profiles.');
  return profile;
}

export async function listSolariProfiles(orgId, apiKey) {
  const client = await solariBrowser(apiKey);
  let remote;
  try { remote = await client.profiles.list(); }
  finally { await client.close(); }
  const visible = [];
  const ownerId = (await repositories.auth.findOneMembershipByOrgId(orgId))?.user_id;
  const hash = keyHash(apiKey);
  for (const profile of remote) {
    const name = String(profile.name || 'Browser profile').slice(0, 100);
    const saved = await repositories.integrations.findOneSolariProfile(id('profile'), orgId, profile.id, hash, name, ownerId, now());
    visible.push({ id: saved.id, name });
  }
  return visible.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createSolariProfile(orgId, userId, name, apiKey) {
  const profileName = String(name || '').trim().slice(0, 100);
  if (profileName.length < 1) throw new Error('Enter a profile name.');
  const client = await solariBrowser(apiKey);
  let remote;
  try { remote = await client.profiles.create({ name: profileName }); }
  finally { await client.close(); }
  const profileId = id('profile');
  (await repositories.integrations.insertSolariProfile(profileId, orgId, remote.id, keyHash(apiKey), profileName, userId, now()));
  return { id: profileId, name: profileName };
}

export async function deleteSolariProfile(orgId, profileId, apiKey) {
  const profile = (await profileForOrg(orgId, profileId, apiKey));
  const assigned = (await repositories.employees.findOneEmployeeByOrgIdAndProfileId(orgId, profileId));
  if (assigned) throw new Error('Remove this profile from employee specs before deleting it.');
  const client = await solariBrowser(apiKey);
  try { await client.profiles.delete(profile.provider_id); }
  finally { await client.close(); }
  (await repositories.integrations.deleteSolariProfileByIdAndOrgId(profileId, orgId));
}

export async function readSolariUsageResponse(response) {
  if (!response?.ok) {
    await response?.body?.cancel().catch(() => {});
    throw new Error(`Solari usage request failed (HTTP ${Number(response?.status) || 0}).`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Solari usage endpoint returned an empty response.');
  const chunks = [];
  let responseBytes = 0;
  const readDeadline = Date.now() + 20_000;
  try {
    while (true) {
      const remainingMs = readDeadline - Date.now();
      if (remainingMs <= 0) throw new Error('usage_timeout');
      let timer;
      const next = await Promise.race([
        reader.read(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('usage_timeout')), remainingMs); }),
      ]).finally(() => clearTimeout(timer));
      if (next.done) break;
      responseBytes += next.value.byteLength;
      if (responseBytes > 512 * 1024) throw new Error('usage_response_too_large');
      chunks.push(Buffer.from(next.value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error?.message === 'usage_timeout') throw new Error('Solari usage response timed out.');
    if (error?.message === 'usage_response_too_large') throw new Error('Solari usage response exceeded 512 KiB.');
    throw new Error('Solari usage response could not be read.');
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(Buffer.concat(chunks, responseBytes).toString('utf8')); }
  catch { throw new Error('Solari usage endpoint returned invalid JSON.'); }
}

async function fetchSolariUsage(client, sessionId) {
  let response;
  try {
    response = await client.request('GET', `/api/v1/usage/sessions/${encodeURIComponent(sessionId)}`);
  } catch (error) {
    const cause = error?.cause;
    const status = error?.status ?? cause?.status;
    if (status) throw new Error(`Solari usage request failed (HTTP ${status}).`);
    if ([error, cause].some((item) => item?.name === 'AbortError' || /timeout|timed out/i.test(String(item?.message || '')))) {
      throw new Error('Solari usage request timed out.');
    }
    throw new Error('Solari usage request failed before receiving a response.');
  }
  return readSolariUsageResponse(response);
}

export async function getSolariUsageSessions(apiKey, sessionIds = []) {
  const uniqueIds = [...new Set((Array.isArray(sessionIds) ? sessionIds : [])
    .filter((sessionId) => typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 2048))];
  const limit = 25;
  const requestedIds = uniqueIds.slice(0, limit);
  if (!requestedIds.length) return { sessions: [], truncated: false };
  const client = await solariBrowser(apiKey);
  try {
    const sessions = [];
    for (let index = 0; index < requestedIds.length; index += 4) {
      const batch = await Promise.all(requestedIds.slice(index, index + 4).map(async (sessionId) => ({
        sessionId,
        usage: await fetchSolariUsage(client, sessionId),
      })));
      sessions.push(...batch);
    }
    return { sessions, truncated: uniqueIds.length > limit };
  } finally {
    await client.close();
  }
}

export async function createSolariEnvironment(orgId, userId, kind, label, apiKey, profileId = null) {
  const launchStartedAt = Date.now();
  const key = requireKey(apiKey);
  let handle;
  let providerId;
  let launchMs;
  if (kind === 'browser') {
    const profile = (await profileForOrg(orgId, profileId, key));
    const client = await solariBrowser(key);
    try {
      handle = await client.sessions.create({ stealth: false, recording: true, ...(profile ? { profileId: profile.provider_id } : {}) });
      launchMs = Date.now() - launchStartedAt;
      providerId = handle.id;
    } finally { await client.close(); }
  } else if (kind === 'sandbox') {
    const { SandboxClient } = await import('@solarisdk/sandbox');
    const client = new SandboxClient({ apiKey: key, baseUrl: gateway });
    handle = await client.create({ template: 'base' });
    launchMs = Date.now() - launchStartedAt;
    providerId = handle.id ?? handle.sandboxId ?? null;
  } else if (kind === 'desktop') {
    const { DesktopClient } = await import('@solarisdk/desktop');
    const client = new DesktopClient({ apiKey: key, baseUrl: gateway });
    handle = await client.create({ template: 'workstation', resolution: '1280x720', record: true });
    launchMs = Date.now() - launchStartedAt;
    providerId = handle.sessionId ?? handle.id ?? null;
  } else {
    throw new Error('Environment type must be browser, sandbox, or desktop.');
  }
  const environmentId = id('env');
  const displayLabel = String(label || `${kind} session`).slice(0, 100);
  (await repositories.integrations.insertEnvironment(environmentId, orgId, kind, providerId, profileId, 'running', displayLabel, JSON.stringify({ expiresAt: handle.expiresAt || null, launchMs, ...(kind === 'desktop' && typeof handle.recordingUrl === 'string' ? { recordingUrl: handle.recordingUrl } : {}) }), userId, now()));
  return { id: environmentId, kind, providerId, profileId, status: 'running', label: displayLabel };
}

async function routePublicRequests(context, { readOnly = false } = {}) {
  await context.route('**/*', async (route) => {
    try {
      const requestUrl = new URL(route.request().url());
      if (!['http:', 'https:'].includes(requestUrl.protocol) || requestUrl.username || requestUrl.password) return await route.abort('blockedbyclient');
      if (readOnly && !['GET', 'HEAD'].includes(route.request().method().toUpperCase())) return await route.abort('blockedbyclient');
      // ponytail: DNS is checked before remote Chromium resolves again; pin provider egress when Solari exposes that control.
      await assertPublicHost(requestUrl.hostname);
      await route.continue();
    } catch { await route.abort('blockedbyclient'); }
  });
}

async function navigatePublicPage(page, target) {
  const response = await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (!response || !response.ok()) {
    const status = response?.status();
    const error = new Error(`Browser navigation failed${response ? ` (HTTP ${status})` : ' without an HTTP response'}.`);
    if (Number.isInteger(status)) error.httpStatus = status;
    throw error;
  }
  return response.status();
}

async function publicPageLinks(page) {
  const anchors = await page.locator('a[href]').evaluateAll((nodes) => nodes.map((node) => ({
    text: String(node.innerText || node.getAttribute('aria-label') || '').trim().slice(0, 160),
    href: node.href,
  }))).catch(() => []);
  const seen = new Set();
  const links = [];
  for (const anchor of anchors) {
    let url;
    try {
      url = new URL(anchor.href, page.url());
      if (['www.google.com', 'google.com'].includes(url.hostname.toLowerCase()) && url.pathname === '/url') {
        const destination = url.searchParams.get('q') || url.searchParams.get('url');
        if (destination) url = new URL(destination);
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
      url.hash = '';
    } catch { continue; }
    const normalized = url.toString();
    if (seen.has(normalized) || normalized === page.url()) continue;
    seen.add(normalized);
    links.push({ text: anchor.text, url: normalized });
    if (links.length >= 40) break;
  }
  return links;
}

async function previousBrowserSessionId(orgId, workflowId, stepIndex) {
  if (!Number.isInteger(stepIndex) || stepIndex < 0) return null;
  const previous = await repositories.workflows.findOneToolRunByOrgIdAndWorkflowIdAndToolSelectOutput(orgId, workflowId, stepIndex);
  try {
    const sessionId = JSON.parse(previous?.output || '{}')?.sessionId;
    return typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 2048 ? sessionId : null;
  } catch { return null; }
}

export function selectSolariBrowserContext(browser) {
  // The SDK's BrowserSession.context is the context it seeded from profile
  // storageState. A raw Browser after a process restart has no such property,
  // so recover the context that owns this workflow's already-open page.
  if (browser?.context) return browser.context;
  for (const context of browser?.contexts?.() ?? []) {
    if (context.pages().some((page) => page.url() !== 'about:blank')) return context;
  }
  throw new Error('Solari browser session did not expose its primary context.');
}

async function reattachWorkflowBrowser(orgId, workflowId, sessionId, apiKey, readOnly = false) {
  const runtimeKey = `${orgId}:${workflowId}`;
  const client = await solariBrowser(apiKey);
  let browser;
  let activeSessionConfirmed = false;
  try {
    const response = await client.request('GET', `/sessions/${encodeURIComponent(sessionId)}`);
    if (!response.ok) throw new Error(`Solari session lookup failed (HTTP ${response.status}).`);
    const session = await response.json();
    activeSessionConfirmed = session?.id === sessionId && session?.status === 'active' && session?.org === sessionId.split(':')[2];
    const wsEndpoint = validateSolariBrowserSession(sessionId, session);
    const { chromium } = await import('patchright-core');
    browser = await chromium.connect(wsEndpoint);
    const context = selectSolariBrowserContext(browser);
    await routePublicRequests(context, { readOnly });
    const page = context.pages().find((candidate) => candidate.url() !== 'about:blank');
    if (!page) throw new Error('The prior Solari browser session has no active workflow page.');
    const runtime = { client, browser, page, sessionId, launchMsPending: null, releaseSession: true };
    workflowBrowsers.set(runtimeKey, runtime);
    return runtime;
  } catch (error) {
    await browser?.close().catch(() => {});
    if (activeSessionConfirmed) await client.sessions.releaseAndWait(sessionId).catch(() => {});
    await client.close().catch(() => {});
    if (/^Solari session lookup failed|^The prior Solari browser session/.test(String(error?.message || ''))) throw error;
    throw new Error('The prior Solari browser session could not be reattached.');
  }
}

async function workflowBrowserRuntime(orgId, workflowId, stepIndex, apiKey, readOnly = false) {
  const runtimeKey = `${orgId}:${workflowId}`;
  let runtime = workflowBrowsers.get(runtimeKey);
  if (runtime?.browser.isConnected()) return runtime;
  if (runtime) {
    workflowBrowsers.delete(runtimeKey);
    await runtime.client.close().catch(() => {});
  }
  const sessionId = await previousBrowserSessionId(orgId, workflowId, stepIndex);
  return sessionId ? reattachWorkflowBrowser(orgId, workflowId, sessionId, apiKey, readOnly) : null;
}

export async function runSolariTool(orgId, tool, input, apiKey, profileId = null, workflowId = null, stepIndex = null, { readOnly = false } = {}) {
  const key = requireKey(apiKey);
  if (readOnly && !canExecuteSimulationTool(tool, input)) throw new Error('This Solari tool is not permitted during a read-only simulation.');
  if (tool === 'solari.browser.open') {
    const target = validatePublicBrowserTarget(input.url);
    await assertPublicHost(target.hostname);
    const profile = (await profileForOrg(orgId, profileId, key));
    if (workflowId) {
      const runtimeKey = `${orgId}:${workflowId}`;
      let runtime;
      try { runtime = await workflowBrowserRuntime(orgId, workflowId, stepIndex, key, readOnly); }
      catch (error) {
        if (error?.code !== 'solari_session_ended') throw error;
      }
      if (!runtime?.browser.isConnected()) {
        const client = await solariBrowser(key);
        let browser;
        const launchStartedAt = Date.now();
        try {
          browser = await client.launch({ stealth: false, recording: true, ...(profile ? { profileId: profile.provider_id } : {}) });
          const launchMs = Date.now() - launchStartedAt;
          const context = selectSolariBrowserContext(browser);
          await routePublicRequests(context, { readOnly });
          const page = await context.newPage();
          runtime = { client, browser, page, sessionId: browser.id, launchMsPending: launchMs };
          workflowBrowsers.set(runtimeKey, runtime);
        } catch (error) {
          try { await browser?.close(); } finally { await client.close(); }
          throw error;
        }
      }
      const httpStatus = await navigatePublicPage(runtime.page, target);
      const launchMs = runtime.launchMsPending;
      runtime.launchMsPending = null;
      return { ok: true, httpStatus, url: runtime.page.url(), title: await runtime.page.title(), text: (await runtime.page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).slice(0, 1600), links: await publicPageLinks(runtime.page), sessionId: runtime.sessionId, ...(Number.isFinite(launchMs) ? { launchMs } : {}) };
    }
    const client = await solariBrowser(key);
    const launchStartedAt = Date.now();
    let browser;
    let launchMs;
    let output;
    try {
      browser = await client.launch({ stealth: false, recording: true, ...(profile ? { profileId: profile.provider_id } : {}) });
      launchMs = Date.now() - launchStartedAt;
      const context = selectSolariBrowserContext(browser);
      await routePublicRequests(context, { readOnly });
      const page = await context.newPage();
      const httpStatus = await navigatePublicPage(page, target);
      output = { ok: true, httpStatus, url: page.url(), title: await page.title(), text: (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).slice(0, 1600), links: await publicPageLinks(page), sessionId: browser.id, launchMs };
    } finally {
      try { await browser?.close(); }
      finally { await client.close(); }
    }
    return output;
  }
  if (tool === 'solari.browser.interact') {
    const actions = validateBrowserActions(input?.actions);
    if (readOnly && !actions.every((action) => action.action === 'assertText' || action.action === 'wait')) throw new Error('Read-only simulations allow only browser waits and visible-text assertions.');
    if (!workflowId) throw new Error('Browser interactions require an existing browser opened earlier in the same workflow.');
    const runtime = await workflowBrowserRuntime(orgId, workflowId, stepIndex, key, readOnly);
    if (!runtime?.browser.isConnected()) throw new Error('This workflow has no connected browser session. Open a page earlier in the same task, then retry.');
    const assertions = [];
    for (const [index, action] of actions.entries()) {
      const timeout = action.timeoutMs ?? 3500;
      if (action.action === 'assertText') {
        await runtime.page.getByText(action.text, { exact: false }).filter({ visible: true }).first().waitFor({ state: 'visible', timeout });
        assertions.push({ index: index + 1, text: action.text, visible: true });
        continue;
      }
      const locator = runtime.page.locator(action.selector);
      if (action.action === 'click') await locator.click({ timeout });
      else if (action.action === 'fill') await locator.fill(action.value, { timeout });
      else if (action.action === 'select') await locator.selectOption(action.value, { timeout });
      else if (action.action === 'press') await locator.press(action.key, { timeout });
      else await locator.waitFor({ state: action.state ?? 'visible', timeout });
    }
    const lastMutationIndex = actions.reduce((last, action, index) => ['click', 'fill', 'select', 'press'].includes(action.action) ? index + 1 : last, 0);
    return {
      ok: true,
      url: runtime.page.url(),
      title: await runtime.page.title(),
      text: (await runtime.page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).slice(0, 2000),
      assertions,
      lastMutationIndex,
      sessionId: runtime.sessionId,
    };
  }
  if (tool === 'solari.sandbox.echo') {
    const { SandboxClient } = await import('@solarisdk/sandbox');
    const client = new SandboxClient({ apiKey: key, baseUrl: gateway });
    const launchStartedAt = Date.now();
    const sandbox = await client.create({ template: 'base' });
    const launchMs = Date.now() - launchStartedAt;
    try {
      const result = await sandbox.commands.run('echo', { args: [String(input.message || 'hello').slice(0, 500)] });
      return { ok: result.exitCode === 0, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, sandboxId: sandbox.id ?? null, launchMs };
    } finally { await sandbox.kill(); }
  }
  if (tool === 'solari.desktop.exec') {
    const environmentId = String(input.environmentId || '');
    const command = String(input.command || '');
    const args = input.args;
    if (!/^[A-Za-z0-9._+-]{1,120}$/.test(command) || !Array.isArray(args) || args.length > 40 || args.some((arg) => typeof arg !== 'string' || arg.length > 1000 || arg.includes('\0'))) throw new Error('Desktop commands need a valid executable and up to 40 text arguments.');
    const env = (await repositories.integrations.findOneEnvironmentByIdAndOrgIdAndKind(environmentId, orgId));
    if (!env?.provider_id) throw new Error('Choose a running desktop environment in this workspace.');
    const { DesktopClient } = await import('@solarisdk/desktop');
    const desktop = await new DesktopClient({ apiKey: key, baseUrl: gateway }).connect(env.provider_id);
    try {
      await desktop.connect();
      const result = await desktop.exec(command, { args, timeoutMs: 30000 });
      return { ok: result.exitCode === 0, exitCode: result.exitCode, stdout: String(result.stdout || '').slice(0, 4000), stderr: String(result.stderr || '').slice(0, 1000), environmentId };
    } finally { await desktop.close(); }
  }
  throw new Error(`Unsupported Solari tool: ${tool}`);
}

export async function getWorkflowBrowserFrame(orgId, workflowId) {
  const runtime = workflowBrowsers.get(`${orgId}:${workflowId}`);
  if (!runtime?.browser.isConnected()) return null;
  return runtime.page.screenshot({ type: 'jpeg', quality: 65 });
}

export async function closeWorkflowBrowserSession(orgId, workflowId) {
  const runtimeKey = `${orgId}:${workflowId}`;
  const runtime = workflowBrowsers.get(runtimeKey);
  if (!runtime) return;
  workflowBrowsers.delete(runtimeKey);
  try { await runtime.browser.close(); }
  finally {
    try {
      if (runtime.releaseSession) await runtime.client.sessions.releaseAndWait(runtime.sessionId);
    } finally { await runtime.client.close(); }
  }
}

export async function getSolariReplayUrl(apiKey, providerId) {
  const client = await solariBrowser(apiKey);
  try { return await client.sessions.getReplayUrl(providerId); }
  finally { await client.close(); }
}

export async function getSolariDesktopStream(apiKey, providerId) {
  const { DesktopClient } = await import('@solarisdk/desktop');
  const desktop = await new DesktopClient({ apiKey: requireKey(apiKey), baseUrl: gateway }).connect(providerId);
  try {
    const { streamUrl } = await desktop.stream.start();
    return { streamUrl };
  }
  finally { await desktop.close(); }
}

async function managedEnvironment(orgId, environmentId, apiKey) {
  const env = await repositories.integrations.findOneEnvironmentByIdAndOrgIdSelectAllFields(environmentId, orgId);
  if (!env) throw new Error('Environment not found.');
  if (!['sandbox', 'desktop'].includes(env.kind) || !env.provider_id) throw new Error('Snapshots and pause/resume are available for sandbox and desktop environments.');
  return { env, key: requireKey(apiKey) };
}

async function environmentApi(env, apiKey, action, body) {
  const Client = env.kind === 'desktop'
    ? (await import('@solarisdk/desktop')).DesktopClient
    : (await import('@solarisdk/sandbox')).SandboxClient;
  const client = new Client({ apiKey, baseUrl: gateway });
  return client.http.request('POST', `/sandboxes/${encodeURIComponent(env.provider_id)}/${action}`, body);
}

export async function createEnvironmentSnapshot(orgId, environmentId, apiKey, name) {
  const { env, key } = await managedEnvironment(orgId, environmentId, apiKey);
  if (env.status !== 'running') throw new Error('Resume the environment before creating a snapshot.');
  const { snapshotId } = await environmentApi(env, key, 'snapshots', { name });
  return { snapshotId, name, createdAt: now() };
}

export async function pauseEnvironment(orgId, environmentId, apiKey) {
  const { env, key } = await managedEnvironment(orgId, environmentId, apiKey);
  if (env.status !== 'running') throw new Error('Only running environments can be paused.');
  await environmentApi(env, key, 'pause');
  const updated = await repositories.integrations.updateEnvironmentByIdAndOrgIdAndStatus(environmentId, orgId);
  if (updated.changes !== 1) throw new Error('The environment status changed while it was being paused.');
  return { ...env, status: 'paused' };
}

export async function resumeEnvironment(orgId, environmentId, apiKey) {
  const { env, key } = await managedEnvironment(orgId, environmentId, apiKey);
  if (env.status !== 'paused') throw new Error('Only paused environments can be resumed.');
  await environmentApi(env, key, 'resume');
  const updated = await repositories.integrations.updateEnvironmentByIdAndOrgIdAndStatusSetStatus(environmentId, orgId);
  if (updated.changes !== 1) throw new Error('The environment status changed while it was being resumed.');
  return { ...env, status: 'running' };
}

export async function revertEnvironmentSnapshot(orgId, environmentId, apiKey, snapshotId) {
  const { env, key } = await managedEnvironment(orgId, environmentId, apiKey);
  if (env.status !== 'running') throw new Error('Resume the environment before restoring a snapshot.');
  await environmentApi(env, key, 'revert', { snapshotId });
}

export async function closeEnvironment(orgId, environmentId, apiKey) {
  const env = (await repositories.integrations.findOneEnvironmentByIdAndOrgIdSelectAllFields(environmentId, orgId));
  if (!env) throw new Error('Environment not found.');
  if (env.status === 'stopped') return env;
  if (!env.provider_id || !(apiKey || process.env.SOLARI_API_KEY)) {
    (await repositories.integrations.updateEnvironmentByIdAndOrgIdSetStatus(env.id, orgId));
    return { ...env, status: 'stopped' };
  }
  const key = requireKey(apiKey);
  if (env.kind === 'browser') {
    const client = await solariBrowser(key);
    await client.sessions.releaseAndWait(env.provider_id);
    await client.close();
  } else if (env.kind === 'desktop') {
    const { DesktopClient } = await import('@solarisdk/desktop');
    await new DesktopClient({ apiKey: key, baseUrl: gateway }).destroy(env.provider_id);
  } else {
    const { SandboxClient } = await import('@solarisdk/sandbox');
    const client = new SandboxClient({ apiKey: key, baseUrl: gateway });
    const handle = await client.connect(env.provider_id);
    await handle.kill();
  }
  (await repositories.integrations.updateEnvironmentByIdAndOrgIdSetStatus(env.id, orgId));
  return { ...env, status: 'stopped' };
}
