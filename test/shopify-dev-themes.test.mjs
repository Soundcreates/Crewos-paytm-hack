import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { shopifyDevStoreSchema, shopifyDevThemeSchema } from '../backend/lib/shopify-dev-store-schema.mjs';
import { buildDevelopmentTheme, createShopifyDevThemeService } from '../backend/src/services/shopify-dev-themes.mjs';

function setup(execute) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE organizations(id TEXT PRIMARY KEY); CREATE TABLE users(id TEXT PRIMARY KEY);
    CREATE TABLE sarvam_voice_sessions(id TEXT PRIMARY KEY,org_id TEXT NOT NULL,UNIQUE(org_id,id));
    INSERT INTO organizations VALUES('org-a'); INSERT INTO users VALUES('manager-a'); INSERT INTO sarvam_voice_sessions VALUES('voice-a','org-a');`);
  db.exec(shopifyDevStoreSchema); db.exec(shopifyDevThemeSchema);
  db.prepare("INSERT INTO shopify_dev_store_requests(id,org_id,voice_session_id,manager_user_id,store_name,status,store_domain,created_at,updated_at) VALUES(?,?,?,?,?,'ready',?,?,?)").run('store-a', 'org-a', 'voice-a', 'manager-a', 'Acme shoes', 'acme.myshopify.com', new Date().toISOString(), new Date().toISOString());
  const service = createShopifyDevThemeService({ get: async (sql, ...args) => db.prepare(sql).get(...args), run: async (sql, ...args) => db.prepare(sql).run(...args), newId: () => 'theme-request-a', timestamp: () => new Date().toISOString(), env: { SHOPIFY_DEV_STORE_ENABLED: 'true', HOME: '/tmp', PATH: '/bin', OPENROUTER_API_KEY: 'must-not-reach-cli' }, execute });
  return { db, service };
}
const request = { orgId: 'org-a', userId: 'manager-a', voiceSessionId: 'voice-a', category: 'footwear' };
async function settled(service) {
  for (let i = 0; i < 100; i++) { const state = await service.read('org-a', 'voice-a'); if (state?.status !== 'creating') return state; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Theme fixture did not settle');
}

test('generated themes place user-provided names in escaped settings, not Liquid code', () => {
  const files = buildDevelopmentTheme({ name: '{{ malicious }} <store>', category: 'bags' });
  const index = JSON.parse(files['templates/index.json']);
  assert.equal(index.sections.main.settings.heading, '{{ malicious }} <store>');
  assert.match(files['sections/crewos-home.liquid'], /section\.settings\.heading \| escape/);
  assert.equal(files['sections/crewos-home.liquid'].includes('{{ malicious }}'), false);
  assert.match(files['assets/crewos.css'], /#a46a3e/);
});

test('a created dev store gets one unpublished theme preview with a verified URL', async () => {
  let calls = 0;
  const { db, service } = setup(async (_cmd, args, options) => {
    calls++;
    assert.ok(args.includes('--unpublished'));
    assert.equal(args.includes('--publish'), false);
    assert.equal(args.includes('--allow-live'), false);
    assert.equal(options.env.OPENROUTER_API_KEY, undefined);
    assert.match(await readFile(join(args[args.indexOf('--path') + 1], 'layout/theme.liquid'), 'utf8'), /content_for_layout/);
    return { stdout: JSON.stringify({ theme: { id: 42, role: 'unpublished', shop: 'acme.myshopify.com', preview_url: 'https://acme.myshopify.com/?preview_theme_id=42' } }) };
  });
  try {
    assert.equal((await service.create(request)).status, 'creating');
    assert.equal((await service.create(request)).status, 'creating');
    assert.equal((await settled(service)).previewUrl, 'https://acme.myshopify.com/?preview_theme_id=42');
    assert.equal(calls, 1);
    await assert.rejects(service.create({ ...request, userId: 'other' }), { code: 'dev_store_not_ready' });
  } finally { db.close(); }
});

test('an unexpected provider preview URL remains uncertain and is not retried', async () => {
  let calls = 0;
  const { db, service } = setup(async () => { calls++; return { stdout: JSON.stringify({ theme: { id: 42, role: 'unpublished', shop: 'acme.myshopify.com', preview_url: 'https://attacker.example/?preview_theme_id=42' } }) }; });
  try {
    await service.create(request);
    assert.equal((await settled(service)).status, 'uncertain');
    assert.equal((await service.create(request)).status, 'uncertain');
    assert.equal(calls, 1);
  } finally { db.close(); }
});
