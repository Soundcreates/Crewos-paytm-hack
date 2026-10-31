import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('production requires PostgreSQL configuration', () => {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    "await import('./backend/lib/db.mjs')",
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: '',
      DATABASE_FILE: '/tmp/crewos-production-db-config-test.sqlite',
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /DATABASE_URL is required in production/);
});

test('production PostgreSQL requires a Neon Auth endpoint', () => {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    "await import('./backend/lib/db.mjs')",
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://app:secret@ep-example-pooler.neon.tech/neondb?sslmode=require',
      NEON_AUTH_BASE_URL: '',
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PostgreSQL without Neon Auth is allowed only in development and only on a configured local host/);
});

test('local Neon PostgreSQL cannot silently fall back to local password auth', () => {
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e',
    "await import('./backend/lib/db.mjs')",
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://app:secret@ep-main-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require',
      NEON_AUTH_BASE_URL: '',
    },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PostgreSQL without Neon Auth is allowed only in development and only on a configured local host/);
});
