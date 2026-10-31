import { repositories } from '../../src/repositories/index.mjs';
import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { id, now } from '../../lib/db.mjs';
import { getLlmApiKey, isLocalLlmProvider } from '../../lib/llm-provider.mjs';

let cachedKey: Buffer | undefined;

function env(): Record<string, string | undefined> {
  return (globalThis as typeof globalThis & { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
}

function vaultKey(): Buffer {
  const masterKey = env().APP_MASTER_KEY;
  if (!masterKey || masterKey.length < 24) throw new Error('Set APP_MASTER_KEY (at least 24 characters) before storing integration secrets.');
  return cachedKey ??= scryptSync(masterKey, 'crewos-integration-vault-v1', 32);
}

export function encryptSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', vaultKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

export function decryptSecret(value: string): string {
  const payload = Buffer.from(value, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', vaultKey(), payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8');
}

export async function getSecret(orgId: string, provider: string): Promise<string | null | undefined> {
  const row = await repositories.integrations.findOneIntegrationByOrgIdAndProviderSelectSecretCiphertextStatus(orgId, provider);
  if (provider === 'openrouter') {
    if (isLocalLlmProvider()) return getLlmApiKey();
    const storedKey = row?.status !== 'reconnect' && typeof row?.secret_ciphertext === 'string' && row.secret_ciphertext
      ? decryptSecret(row.secret_ciphertext)
      : null;
    return getLlmApiKey(storedKey || env().OPENROUTER_API_KEY);
  }
  if (row?.status !== 'reconnect' && typeof row?.secret_ciphertext === 'string' && row.secret_ciphertext) return decryptSecret(row.secret_ciphertext);
  const environment = env();
  return provider === 'solari' ? environment.SOLARI_API_KEY : null;
}

export async function storeSecret(orgId: string, userId: string, provider: string, secret: string, config: Record<string, unknown> = {}): Promise<unknown> {
  if (!['solari', 'openrouter', 'jira'].includes(provider)) throw new Error('Unsupported integration.');
  if (typeof secret !== 'string' || secret.length < 12 || secret.length > 4096) throw new Error('Integration key must be between 12 and 4096 characters.');
  const ciphertext = encryptSecret(secret);
  const label = provider === 'solari' ? 'Solari' : provider === 'jira' ? 'Jira Cloud' : 'OpenRouter';
  const timestamp = now();
  return repositories.integrations.findOneIntegration(id('int'), orgId, provider, label, ciphertext, JSON.stringify(config), 'connected', timestamp, timestamp);
}

export async function replaceSecret(orgId: string, provider: string, secret: string): Promise<void> {
  const ciphertext = encryptSecret(secret);
  const result = await repositories.integrations.updateIntegrationByOrgIdAndProviderSetSecretCiphertextUpdatedAt(ciphertext, now(), orgId, provider);
  if (!result.changes) throw new Error('Integration is not connected.');
}

export async function removeSecret(orgId: string, provider: string): Promise<void> {
  await repositories.integrations.deleteIntegrationByOrgIdAndProvider(orgId, provider);
}
