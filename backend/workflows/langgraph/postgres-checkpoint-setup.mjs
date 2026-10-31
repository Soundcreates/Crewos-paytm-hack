const CHECKPOINT_SETUP_LOCK_ID = 742311232;
const TRANSIENT_SQLSTATES = new Set(['40001', '40P01', '55P03', '53300', '57P01', '57P02', '57P03']);
const TRANSIENT_NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EAI_AGAIN']);

export function isTransientPostgresInitializationError(error) {
  const visited = new Set();
  let current = error;
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const code = typeof current.code === 'string' ? current.code : '';
    if (code.startsWith('08') || TRANSIENT_SQLSTATES.has(code) || TRANSIENT_NETWORK_CODES.has(code)) return true;
    current = current.cause;
  }
  return false;
}

async function setupOnce(pool, setup) {
  let client;
  let discardClientError;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [CHECKPOINT_SETUP_LOCK_ID]);

    // The SDK catches 42P01 when its migration table is missing. PostgreSQL
    // still aborts the surrounding transaction after that error, so create the
    // metadata table first while holding the same transaction-scoped lock.
    await client.query('CREATE SCHEMA IF NOT EXISTS "public"');
    await client.query('CREATE TABLE IF NOT EXISTS "public".checkpoint_migrations (v INTEGER PRIMARY KEY)');

    // PostgresSaver.setup() calls connect() itself. Keep all of its migration
    // queries on this transaction-pinned connection, which is also safe with
    // Neon transaction pooling.
    const setupPool = {
      async connect() {
        return { query: client.query.bind(client), release() {} };
      },
    };
    await setup(setupPool);
    await client.query('COMMIT');
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        discardClientError = rollbackError;
      }
    }
    throw error;
  } finally {
    if (client) client.release(discardClientError);
  }
}

export async function setupPostgresCheckpointer(pool, setup, { maxAttempts = 4, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const attempts = Math.max(1, Math.trunc(Number(maxAttempts) || 4));
  for (let attempt = 1; ; attempt += 1) {
    try {
      await setupOnce(pool, setup);
      return;
    } catch (error) {
      if (attempt >= attempts || !isTransientPostgresInitializationError(error)) throw error;
      const delay = Math.min(1000, 100 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 50);
      await sleep(delay);
    }
  }
}
