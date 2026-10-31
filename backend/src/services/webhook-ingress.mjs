import { createHmac, timingSafeEqual } from 'node:crypto';

export class WebhookVerificationError extends Error {
  constructor(message, code = 'webhook_invalid') { super(message); this.name = 'WebhookVerificationError'; this.code = code; }
}

export function verifyHmacSha256(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || !Buffer.isBuffer(secret) && typeof secret !== 'string' || typeof signature !== 'string') throw new WebhookVerificationError('Webhook signature is missing or malformed.', 'signature_invalid');
  const normalized = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  if (!/^[a-f0-9]{64}$/i.test(normalized)) throw new WebhookVerificationError('Webhook signature is malformed.', 'signature_invalid');
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const supplied = Buffer.from(normalized, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new WebhookVerificationError('Webhook signature verification failed.', 'signature_invalid');
  return true;
}

/** Verifies before parsing or persistence. org identity comes from the resolved connection. */
export async function ingestSignedWebhook({ rawBody, signature, secret, connection, eventId, eventType, occurredAt = null, transaction, repository, newId, timestamp }) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length > 1024 * 1024) throw new WebhookVerificationError('Webhook body exceeds the 1 MiB limit.', 'body_too_large');
  if (!connection?.id || !connection?.org_id) throw new WebhookVerificationError('Server-side provider connection was not found.', 'connection_missing');
  if (connection.environment === 'production' && connection.fixture === true) throw new WebhookVerificationError('Simulated fixture events cannot target production connections.', 'fixture_production_blocked');
  verifyHmacSha256(rawBody, signature, secret);
  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); }
  catch { throw new WebhookVerificationError('Webhook body is not valid JSON.', 'payload_invalid'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !eventId || !eventType) throw new WebhookVerificationError('Webhook envelope is invalid.', 'envelope_invalid');
  const at = timestamp();
  return transaction(async () => {
    const inserted = await repository.createInboxEvent(newId('evt'),connection.org_id,connection.provider,connection.id,eventId,eventType,connection.environment,connection.simulated === true ? 1 : 0,occurredAt,at,JSON.stringify(payload),null,connection.org_id,connection.id,connection.environment);
    if (!inserted?.changes) return { duplicate: true };
    const inbox = await repository.findInboxEvent(connection.org_id,connection.id,eventId);
    await repository.enqueueOutbox(newId('outbox'),connection.org_id,'webhook.received',JSON.stringify({ inboxId: inbox.id }),`webhook:${connection.id}:${eventId}`,at);
    return { duplicate: false, inboxId: inbox.id };
  });
}
