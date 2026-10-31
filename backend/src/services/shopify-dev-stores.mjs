import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);
const plans = new Set(['basic', 'grow', 'advanced', 'plus']);
const truthy = value => ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
const error = (status, code, message) => Object.assign(new Error(message), { status, code });

export function createShopifyDevStoreService({ get, run, newId, timestamp, env = process.env, execute = execFile }) {
  const find = (orgId, sessionId) => get('SELECT id,org_id,voice_session_id,manager_user_id,store_name,status,store_domain,error_code,created_at,updated_at FROM shopify_dev_store_requests WHERE org_id=? AND voice_session_id=?', orgId, sessionId);
  function view(row) {
    return row ? { id: row.id, voiceSessionId: row.voice_session_id, name: row.store_name, status: row.status, storeDomain: row.store_domain || null, storeUrl: row.store_domain ? `https://${row.store_domain}` : null, errorCode: row.error_code || null } : null;
  }
  async function read(orgId, sessionId) {
    const row = await find(orgId, sessionId);
    if (row?.status === 'creating' && Date.now() - Date.parse(row.updated_at) > 180_000) {
      await run("UPDATE shopify_dev_store_requests SET status='uncertain',error_code='creation_outcome_unknown',updated_at=? WHERE org_id=? AND id=? AND status='creating' AND updated_at=?", timestamp(), orgId, row.id, row.updated_at);
      return view(await find(orgId, sessionId));
    }
    return view(row);
  }
  async function create({ orgId, userId, voiceSessionId, name }) {
    if (!truthy(env.SHOPIFY_DEV_STORE_ENABLED)) throw error(503, 'dev_store_disabled', 'Development store creation is not enabled on this server.');
    const organizationId = String(env.SHOPIFY_DEV_ORGANIZATION_ID || '').trim();
    const plan = String(env.SHOPIFY_DEV_STORE_PLAN || 'basic').trim();
    if (!/^\d+$/.test(organizationId) || !plans.has(plan)) throw error(503, 'dev_store_config_invalid', 'Set a numeric Shopify development organization ID and supported plan.');
    if (typeof voiceSessionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(voiceSessionId)) throw error(400, 'voice_session_invalid', 'A completed voice session is required.');
    const storeName = String(name || '').trim();
    if (!storeName || storeName.length > 80 || /[\u0000-\u001f\u007f]/.test(storeName)) throw error(400, 'dev_store_name_invalid', 'Enter a store name of up to 80 characters.');
    const session = await get('SELECT id,org_id,user_id,state FROM sarvam_voice_sessions WHERE org_id=? AND id=? AND user_id=? AND session_type=?', orgId, voiceSessionId, userId, 'browser');
    if (!session || session.state !== 'ended') throw error(403, 'dev_store_session_invalid', 'The completed voice session does not belong to this manager and workspace.');
    const prior = await find(orgId, voiceSessionId);
    if (prior) {
      if (prior.store_name !== storeName || prior.manager_user_id !== userId) throw error(409, 'dev_store_request_conflict', 'This interview already has a different development store request.');
      return read(orgId, voiceSessionId);
    }
    const id = newId('shopify_dev_store'), at = timestamp();
    const inserted = await run("INSERT INTO shopify_dev_store_requests(id,org_id,voice_session_id,manager_user_id,store_name,status,created_at,updated_at) VALUES(?,?,?,?,?,'creating',?,?) ON CONFLICT(org_id,voice_session_id) DO NOTHING", id, orgId, voiceSessionId, userId, storeName, at, at);
    if (inserted?.changes !== 1) {
      const existing = await find(orgId, voiceSessionId);
      if (!existing || existing.store_name !== storeName || existing.manager_user_id !== userId) throw error(409, 'dev_store_request_conflict', 'This interview already has a different development store request.');
      return read(orgId, voiceSessionId);
    }
    const childEnv = { CI: '1', SHOPIFY_CLI_NO_ANALYTICS: '1' };
    for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'XDG_CONFIG_HOME']) if (env[key]) childEnv[key] = env[key];
    if (env.SHOPIFY_SERVICE_ACCOUNT_TOKEN?.trim()) childEnv.SHOPIFY_SERVICE_ACCOUNT_TOKEN = env.SHOPIFY_SERVICE_ACCOUNT_TOKEN.trim();
    void (async () => {
      try {
        const result = await execute('shopify', ['store', 'create', 'dev', '--name', storeName, '--organization-id', organizationId, '--plan', plan, '--json'], { env: childEnv, timeout: 120_000, maxBuffer: 1_000_000 });
        const output = JSON.parse(result.stdout);
        const domain = String(output?.store?.domain || '').toLowerCase();
        if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/.test(domain) || String(output?.organization?.id) !== organizationId) throw new Error('unverified_store_result');
        await run("UPDATE shopify_dev_store_requests SET status='ready',store_domain=?,updated_at=? WHERE org_id=? AND id=? AND status='creating'", domain, timestamp(), orgId, id);
      } catch {
        await run("UPDATE shopify_dev_store_requests SET status='uncertain',error_code='creation_outcome_unknown',updated_at=? WHERE org_id=? AND id=? AND status='creating'", timestamp(), orgId, id).catch(() => {});
      }
    })();
    return read(orgId, voiceSessionId);
  }
  return { create, read };
}
