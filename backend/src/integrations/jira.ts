import { repositories } from '../../src/repositories/index.mjs';
import { id, now } from '../../lib/db.mjs';
import { getSecret, replaceSecret } from '../../lib/secrets.mjs';

const OAUTH = 'https://auth.atlassian.com';
const API = 'https://api.atlassian.com';
const refreshes = new Map<string, Promise<JiraTokens>>();

type JsonRecord = Record<string, unknown>;

interface JiraTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface JiraSite {
  id: string;
  name: string;
  url: string;
}

interface JiraConfig {
  cloudId?: string;
  projectKey?: string;
  issueType?: string;
  sites?: JiraSite[];
}

interface JiraResponse {
  status: number;
  data: unknown;
}

function env(): Record<string, string | undefined> {
  return (globalThis as typeof globalThis & { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function oauthConfig() {
  const { ATLASSIAN_OAUTH_CLIENT_ID: clientId, ATLASSIAN_OAUTH_CLIENT_SECRET: clientSecret, ATLASSIAN_OAUTH_REDIRECT_URI: redirectUri } = env();
  if (!clientId || !clientSecret || !redirectUri) throw new Error('Set ATLASSIAN_OAUTH_CLIENT_ID, ATLASSIAN_OAUTH_CLIENT_SECRET, and ATLASSIAN_OAUTH_REDIRECT_URI on the server.');
  const redirect = new URL(redirectUri);
  if (redirect.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(redirect.hostname)) throw new Error('The Atlassian OAuth callback must use HTTPS outside localhost.');
  if (redirect.pathname !== '/oauth/jira/callback' || redirect.username || redirect.password || redirect.search || redirect.hash) throw new Error('Set the Atlassian OAuth callback URL to /oauth/jira/callback.');
  return { clientId, clientSecret, redirectUri: redirect.toString() };
}

export function jiraAuthorizationUrl(state: string): string {
  const { clientId, redirectUri } = oauthConfig();
  const url = new URL('/authorize', OAUTH);
  url.searchParams.set('audience', 'api.atlassian.com');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', 'read:jira-work write:jira-work offline_access');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

async function tokenRequest(payload: Record<string, string>): Promise<JiraTokens> {
  const { clientId, clientSecret } = oauthConfig();
  const response = await fetch(`${OAUTH}/oauth/token`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ ...payload, client_id: clientId, client_secret: clientSecret }),
  });
  const result = record(await response.json().catch(() => null));
  if (!response.ok || typeof result?.access_token !== 'string' || typeof result.refresh_token !== 'string') throw new Error(`Atlassian OAuth token request failed (${response.status}).`);
  return { accessToken: result.access_token, refreshToken: result.refresh_token, expiresAt: Date.now() + Math.max(1, Number(result.expires_in) || 3600) * 1000 };
}

export async function exchangeJiraAuthorizationCode(code: string): Promise<{ tokens: JiraTokens; sites: JiraSite[] }> {
  const { redirectUri } = oauthConfig();
  const tokens = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
  const response = await fetch(`${API}/oauth/token/accessible-resources`, {
    redirect: 'error', signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json' },
  });
  const resources: unknown = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(resources)) throw new Error(`Could not list Jira sites granted to this connection (${response.status}).`);
  const sites = resources.flatMap((value): JiraSite[] => {
    const site = record(value);
    const scopes = Array.isArray(site?.scopes) ? site.scopes : [];
    if (!site || typeof site.id !== 'string' || !/^[A-Za-z0-9-]{8,80}$/.test(site.id)
      || !scopes.includes('read:jira-work') || !scopes.includes('write:jira-work')
      || typeof site.url !== 'string' || !/^https:\/\/[a-z0-9][a-z0-9-]*\.atlassian\.net\/?$/i.test(site.url)) return [];
    return [{ id: site.id, name: String(site.name || 'Jira site').slice(0, 100), url: site.url }];
  });
  if (!sites.length) throw new Error('No Jira Cloud site has both read:jira-work and write:jira-work access.');
  return { tokens, sites };
}

async function connectionConfig(orgId: string): Promise<JiraConfig> {
  const row = await repositories.integrations.findOneIntegrationByOrgIdAndProviderSelectConfig(orgId, 'jira');
  if (!row) throw new Error('Connect Jira Cloud in workspace Settings before using Jira tools.');
  try { return JSON.parse(String(row.config || '{}')) as JiraConfig; }
  catch { throw new Error('Jira connection settings are invalid. Reconnect Jira Cloud.'); }
}

async function storedTokens(orgId: string): Promise<JiraTokens> {
  const value = await getSecret(orgId, 'jira');
  if (!value) throw new Error('Connect Jira Cloud in workspace Settings before using Jira tools.');
  try {
    const tokens = record(JSON.parse(value));
    if (typeof tokens?.accessToken === 'string' && typeof tokens.refreshToken === 'string' && typeof tokens.expiresAt === 'number' && Number.isFinite(tokens.expiresAt)) {
      return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt };
    }
  } catch { /* An old API-token connection must be replaced with OAuth. */ }
  throw new Error('This Jira connection must be replaced with Atlassian OAuth. Reconnect Jira Cloud in Settings.');
}

async function validTokens(orgId: string): Promise<JiraTokens> {
  const tokens = await storedTokens(orgId);
  if (tokens.expiresAt > Date.now() + 60000) return tokens;
  const priorRefresh = refreshes.get(orgId);
  if (priorRefresh) return priorRefresh;
  const refreshing = (async () => {
    const owner = id('jira-refresh');
    const name = `jira-refresh:${orgId}`;
    const deadline = Date.now()+20000;
    while (Date.now()<deadline) {
      const acquired = await repositories.operations.insertServiceLeaseByExpiresAt(name, owner, new Date(Date.now()+60000).toISOString(), now());
      if (acquired.changes === 1) {
        try {
          const latest = await storedTokens(orgId);
          if (latest.expiresAt > Date.now()+60000) return latest;
          const next = await tokenRequest({ grant_type: 'refresh_token', refresh_token: latest.refreshToken });
          await replaceSecret(orgId, 'jira', JSON.stringify(next));
          return next;
        } finally { await repositories.operations.deleteServiceLeaseByNameAndOwner(name, owner); }
      }
      await new Promise(resolve => setTimeout(resolve,100));
      const latest = await storedTokens(orgId);
      if (latest.expiresAt > Date.now()+60000) return latest;
    }
    throw new Error('Jira credential refresh is busy; retry shortly.');
  })();
  refreshes.set(orgId, refreshing);
  try { return await refreshing; }
  finally { refreshes.delete(orgId); }
}

export async function jiraSites(orgId: string): Promise<JiraSite[]> {
  return (await connectionConfig(orgId)).sites || [];
}

async function requireSite(orgId: string, cloudId: string): Promise<JiraSite> {
  const site = (await jiraSites(orgId)).find((item) => item.id === cloudId);
  if (!site) throw new Error('Choose a Jira site authorized for this workspace.');
  return site;
}

async function jiraRequest(orgId: string, cloudId: string, method: string, path: string, body?: unknown): Promise<JiraResponse> {
  await requireSite(orgId, cloudId);
  const tokens = await validTokens(orgId);
  const response = await fetch(`${API}/ex/jira/${encodeURIComponent(cloudId)}${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${tokens.accessToken}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data: unknown = await response.json().catch(() => null);
  return { status: response.status, data };
}

function requireSuccess(result: JiraResponse): unknown {
  if (result.status >= 200 && result.status < 300) return result.data;
  const data = record(result.data);
  const errors = record(data?.errors);
  const messages = [
    ...(Array.isArray(data?.errorMessages) ? data.errorMessages : []),
    ...Object.values(errors || {}),
  ].filter((item): item is string => typeof item === 'string').join(' ').slice(0, 300);
  throw new Error(`Jira request failed (${result.status})${messages ? `: ${messages}` : '.'}`);
}

export async function listJiraProjects(orgId: string, cloudId: string): Promise<Array<{ key: string; name: string }>> {
  const result = record(requireSuccess(await jiraRequest(orgId, cloudId, 'GET', '/rest/api/3/project/search?maxResults=100')));
  const values = Array.isArray(result?.values) ? result.values : [];
  return values.flatMap((value): Array<{ key: string; name: string }> => {
    const project = record(value);
    return typeof project?.key === 'string' && typeof project.name === 'string' ? [{ key: project.key, name: project.name }] : [];
  });
}

export async function validateJiraProject(orgId: string, cloudId: string, projectKey: string): Promise<{ key: string; name: string } | null> {
  const result = await jiraRequest(orgId, cloudId, 'GET', `/rest/api/3/project/${encodeURIComponent(projectKey)}`);
  if (result.status === 404) return null;
  const project = record(requireSuccess(result));
  return project?.key === projectKey && typeof project.name === 'string' ? { key: projectKey, name: project.name } : null;
}

export async function createJiraIssue(orgId: string, { title, description, operationId }: { title: string; description: string; operationId?: string }): Promise<{ ok: true; issueId: string; issueKey: string; projectKey: string; operationId?: string; url?: string }> {
  const config = await connectionConfig(orgId);
  if (!config.cloudId || !config.projectKey) throw new Error('Choose a Jira project in workspace Settings before using Jira tools.');
  const issue = record(requireSuccess(await jiraRequest(orgId, config.cloudId, 'POST', '/rest/api/3/issue', {
    fields: {
      project: { key: config.projectKey }, summary: title, issuetype: { name: config.issueType || 'Task' },
      ...(operationId ? { labels: [operationLabel(operationId)] } : {}),
      description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }] },
    },
  })));
  if (typeof issue?.key !== 'string' || !/^[A-Z][A-Z0-9_]*-\d+$/.test(issue.key)) throw new Error('Jira created an issue but returned an invalid issue key.');
  const site = await requireSite(orgId, config.cloudId);
  return { ok: true, issueId: issue.key, issueKey: issue.key, projectKey: config.projectKey, ...(operationId ? {operationId} : {}), url: `${site.url.replace(/\/$/,'')}/browse/${issue.key}` };
}

async function issuePath(orgId: string, issueKey: string): Promise<{ cloudId: string; path: string }> {
  const config = await connectionConfig(orgId);
  const prefix = `${config.projectKey}-`;
  if (!config.cloudId || !config.projectKey) throw new Error('Choose a Jira project in workspace Settings before using Jira tools.');
  if (!issueKey.startsWith(prefix) || !/^\d+$/.test(issueKey.slice(prefix.length))) throw new Error('Jira tools can only access issues in the configured project.');
  return { cloudId: config.cloudId, path: `/rest/api/3/issue/${encodeURIComponent(issueKey)}` };
}

export async function deleteJiraIssue(orgId: string, issueKey: string): Promise<{ ok: true; deletedId: string }> {
  const target = await issuePath(orgId, issueKey);
  requireSuccess(await jiraRequest(orgId, target.cloudId, 'DELETE', target.path));
  return { ok: true, deletedId: issueKey };
}

export async function jiraIssueExists(orgId: string, issueKey: string): Promise<boolean> {
  const target = await issuePath(orgId, issueKey);
  const result = await jiraRequest(orgId, target.cloudId, 'GET', `${target.path}?fields=summary,project`);
  if (result.status === 404) return false;
  const issue = record(requireSuccess(result));
  return issue?.key === issueKey;
}

export async function jiraIssueCreatedAfter(orgId: string, issueKey: string, startedAt: string | null | undefined): Promise<{ createdAt: string; createdDuringWorkflow: boolean } | null> {
  const startedAtMs = Date.parse(startedAt || '');
  if (!Number.isFinite(startedAtMs)) return null;
  const target = await issuePath(orgId, issueKey);
  const result = await jiraRequest(orgId, target.cloudId, 'GET', `${target.path}?fields=created,project`);
  if (result.status === 404) return null;
  const issue = record(requireSuccess(result));
  const fields = record(issue?.fields);
  const project = record(fields?.project);
  const createdAt = fields?.created;
  const createdAtMs = Date.parse(typeof createdAt === 'string' ? createdAt : '');
  if (issue?.key !== issueKey || project?.key !== (await connectionConfig(orgId)).projectKey || !Number.isFinite(createdAtMs) || typeof createdAt !== 'string') return null;
  return { createdAt, createdDuringWorkflow: createdAtMs >= startedAtMs };
}

function operationLabel(operationId: string): string {
  if (!/^[A-Za-z0-9_-]{1,150}$/.test(operationId)) throw new Error('Invalid Jira operation ID.');
  return `crewos-${operationId}`;
}

function adfText(value: unknown): string {
  const node = record(value);
  if (!node) return '';
  if (typeof node.text === 'string') return node.text;
  return (Array.isArray(node.content) ? node.content : []).map(adfText).join('');
}

export async function verifyJiraIssue(orgId: string, issueKey: string, input: {title?: unknown; description?: unknown}, operationId?: string): Promise<{verified:boolean; evidence:unknown}> {
  const target = await issuePath(orgId, issueKey);
  const result = await jiraRequest(orgId, target.cloudId, 'GET', `${target.path}?fields=summary,description,project,labels`);
  if (result.status === 404) return {verified:false,evidence:{issueKey,missing:true}};
  const issue = record(requireSuccess(result));
  const fields = record(issue?.fields);
  const project = record(fields?.project);
  const config = await connectionConfig(orgId);
  const labels = Array.isArray(fields?.labels) ? fields.labels : [];
  const verified = issue?.key === issueKey && project?.key === config.projectKey
    && fields?.summary === input.title && adfText(fields?.description) === (input.description || input.title)
    && (!operationId || labels.includes(operationLabel(operationId)));
  const site=await requireSite(orgId,target.cloudId);
  return {verified,evidence:{issueKey,projectKey:project?.key,summary:fields?.summary,operationId,matched:verified,url:`${site.url.replace(/\/$/,'')}/browse/${issueKey}`}};
}

export async function findJiraOperation(orgId: string, operationId: string): Promise<string | null> {
  const config = await connectionConfig(orgId);
  if (!config.cloudId || !config.projectKey) throw new Error('Configure a Jira project first.');
  const label = operationLabel(operationId);
  const jql = `project = "${config.projectKey}" AND labels = "${label}"`;
  const data = record(requireSuccess(await jiraRequest(orgId, config.cloudId, 'GET', `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=2&fields=key`)));
  const issues = Array.isArray(data?.issues) ? data.issues : [];
  if (issues.length > 1) throw new Error('Multiple Jira issues match this operation; manual investigation is required.');
  const issue = record(issues[0]);
  return typeof issue?.key === 'string' ? issue.key : null;
}
