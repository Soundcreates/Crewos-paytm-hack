import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'crewos-secrets-'));
const envNames = ['NODE_ENV', 'DATABASE_URL', 'DATABASE_FILE', 'NEON_AUTH_BASE_URL', 'APP_MASTER_KEY', 'OPENROUTER_API_KEY'];
const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: '',
  DATABASE_FILE: join(directory, 'secrets.sqlite'),
  NEON_AUTH_BASE_URL: '',
  APP_MASTER_KEY: 'offline-integration-test-master-key',
});
const { decryptSecret, encryptSecret, getSecret, storeSecret } = await import('../backend/lib/secrets.mjs');
const { closeDatabase, now, run } = await import('../backend/lib/db.mjs');

after(async () => {
  await closeDatabase();
  rmSync(directory, { recursive: true, force: true });
  for (const name of envNames) {
    if (previousEnv[name] === undefined) delete process.env[name];
    else process.env[name] = previousEnv[name];
  }
});

test('integration secrets use authenticated encryption and reject tampering', () => {
  const plaintext = 'provider-secret-value';
  const ciphertext = encryptSecret(plaintext);
  assert.notEqual(ciphertext, plaintext);
  assert.equal(decryptSecret(ciphertext), plaintext);
  const tampered = Buffer.from(ciphertext, 'base64url');
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptSecret(tampered.toString('base64url')));
});

test('OpenRouter keys resolve from the server environment or the encrypted workspace vault', async () => {
  const orgId = 'org_openrouter_secret_test';
  await run('INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)', orgId, 'OpenRouter secret test', now());
  process.env.OPENROUTER_API_KEY = 'openrouter-environment-key';
  assert.equal(await getSecret(orgId, 'openrouter'), 'openrouter-environment-key');

  delete process.env.OPENROUTER_API_KEY;
  const saved = await storeSecret(orgId, 'user_openrouter_secret_test', 'openrouter', 'openrouter-workspace-key');
  assert.equal(saved.provider, 'openrouter');
  assert.equal(saved.display_name, 'OpenRouter');
  assert.equal(await getSecret(orgId, 'openrouter'), 'openrouter-workspace-key');
  await assert.rejects(storeSecret(orgId, 'user_openrouter_secret_test', 'openai', 'old-openai-workspace-key'), /Unsupported integration/);
});
