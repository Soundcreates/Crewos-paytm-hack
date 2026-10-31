/** Org/environment/account-bound encrypted credential lifecycle. Callers must authorize manager/admin ownership. */
export function createConnectionCredentialService({ repository, encrypt, decrypt, timestamp, keyId }) {
  return {
    async rotate({ orgId, connectionId, providerAccountId, environment, credential, expiresAt }) {
      if (typeof credential !== 'string' || credential.length < 12 || credential.length > 16000) throw new Error('Provider credential length is invalid.');
      if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) throw new Error('Credential expiry must be in the future.');
      const ciphertext = encrypt(credential);
      const result = await repository.saveConnectionSecret(ciphertext,keyId(),expiresAt || null,timestamp(),orgId,connectionId,providerAccountId,environment);
      if (!result?.changes) throw new Error('Provider connection ownership, account, or environment does not match.');
      return { connectionId, status:'connected', expiresAt:expiresAt || null };
    },
    async resolve({ orgId, connectionId, providerAccountId, environment }) {
      const row = await repository.findConnectionSecret(orgId,connectionId);
      if (!row || row.provider_account_id !== providerAccountId || row.environment !== environment || row.status !== 'connected' || row.revoked_at || !row.credential_ciphertext || row.credential_expires_at && Date.parse(row.credential_expires_at) <= Date.now()) return null;
      return decrypt(row.credential_ciphertext);
    },
    async revoke({ orgId, connectionId }) {
      const at = timestamp();
      const result = await repository.revokeConnectionSecret(at,at,orgId,connectionId);
      return Boolean(result?.changes);
    },
  };
}
