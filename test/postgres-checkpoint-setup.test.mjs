import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTransientPostgresInitializationError, setupPostgresCheckpointer } from '../backend/workflows/langgraph/postgres-checkpoint-setup.mjs';

function makeDatabase() {
  const state = { migrationTable: false, version: -1, aborted: false, snapshot: null, calls: [], clients: 0, releases: [] };
  const pool = {
    async connect() {
      state.clients += 1;
      return {
        async query(sql, params = []) {
          state.calls.push({ sql, params });
          if (sql === 'BEGIN') {
            state.aborted = false;
            state.snapshot = { migrationTable: state.migrationTable, version: state.version };
            return { rows: [] };
          }
          if (sql === 'ROLLBACK') {
            state.aborted = false;
            Object.assign(state, state.snapshot);
            state.snapshot = null;
            return { rows: [] };
          }
          if (sql === 'COMMIT') { state.snapshot = null; return { rows: [] }; }
          if (state.aborted) throw new Error('current transaction is aborted');
          if (sql === 'SELECT v FROM "public".checkpoint_migrations ORDER BY v DESC LIMIT 1') {
            if (!state.migrationTable) {
              state.aborted = true;
              throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
            }
            return { rows: state.version < 0 ? [] : [{ v: state.version }] };
          }
          if (sql.startsWith('CREATE TABLE IF NOT EXISTS "public".checkpoint_migrations')) {
            state.migrationTable = true;
            return { rows: [] };
          }
          if (sql.startsWith('INSERT INTO "public".checkpoint_migrations')) {
            state.version = params[0];
            return { rows: [] };
          }
          return { rows: [] };
        },
        release(error) { state.releases.push(error); },
      };
    },
  };
  return { state, pool };
}

async function simulateSdkSetup(pool) {
  const client = await pool.connect();
  try {
    let version = -1;
    try {
      const result = await client.query('SELECT v FROM "public".checkpoint_migrations ORDER BY v DESC LIMIT 1');
      if (result.rows.length) version = result.rows[0].v;
    } catch (error) {
      if (error.code !== '42P01') throw error;
    }
    for (let next = version + 1; next < 3; next += 1) {
      await client.query(`CREATE TABLE IF NOT EXISTS sdk_migration_${next}`);
      await client.query('INSERT INTO "public".checkpoint_migrations (v) VALUES ($1)', [next]);
    }
  } finally {
    client.release();
  }
}

test('creates the migration ledger before SDK setup under one transaction lock and supports an existing schema', async () => {
  const { state, pool } = makeDatabase();
  await setupPostgresCheckpointer(pool, simulateSdkSetup, { sleep: async () => {} });
  await setupPostgresCheckpointer(pool, simulateSdkSetup, { sleep: async () => {} });

  assert.equal(state.clients, 2);
  assert.equal(state.version, 2);
  assert.equal(state.calls.filter(({ sql }) => sql === 'SELECT pg_advisory_xact_lock($1)').length, 2);
  assert.equal(state.calls.filter(({ sql }) => sql.startsWith('CREATE TABLE IF NOT EXISTS sdk_migration_')).length, 3);
  assert.equal(state.calls.filter(({ sql }) => sql === 'COMMIT').length, 2);
  assert.equal(state.calls.some(({ sql }) => sql === 'ROLLBACK'), false);
  assert.deepEqual(state.releases, [undefined, undefined]);
});

test('rolls back a failed migration atomically and does not retry permanent errors', async () => {
  const { state, pool } = makeDatabase();
  const migrationError = Object.assign(new Error('permission denied'), { code: '42501' });
  let attempts = 0;

  await assert.rejects(setupPostgresCheckpointer(pool, async () => {
    attempts += 1;
    throw migrationError;
  }, { sleep: async () => {} }), migrationError);

  assert.equal(attempts, 1);
  assert.equal(state.calls.filter(({ sql }) => sql === 'ROLLBACK').length, 1);
  assert.equal(state.calls.some(({ sql }) => sql === 'COMMIT'), false);
  assert.equal(state.clients, 1);
  assert.equal(state.migrationTable, false);
});

test('retries transient database startup errors with bounded attempts', async () => {
  const { state, pool } = makeDatabase();
  const sleeps = [];
  let attempts = 0;

  await setupPostgresCheckpointer(pool, async () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error('serialization failure'), { code: '40001' });
  }, { maxAttempts: 3, sleep: async (ms) => sleeps.push(ms) });

  assert.equal(attempts, 2);
  assert.equal(state.calls.filter(({ sql }) => sql === 'ROLLBACK').length, 1);
  assert.equal(state.calls.filter(({ sql }) => sql === 'COMMIT').length, 1);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 100 && sleeps[0] < 150);
});

test('recognizes wrapped connection errors as transient and leaves schema errors permanent', () => {
  assert.equal(isTransientPostgresInitializationError({ cause: { code: 'ECONNRESET' } }), true);
  assert.equal(isTransientPostgresInitializationError({ code: '42P01' }), false);
});
