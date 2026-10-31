import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectConfiguration } from '../backend/lib/config-check.mjs';

test('configuration checks are safe offline, catch partial integrations, and never include secret values', () => {
  const result = inspectConfiguration({ NODE_ENV: 'development', DEV_LLM_API_KEY: 'secret-never-print', ATLASSIAN_OAUTH_CLIENT_SECRET: 'another-never-print', DATABASE_URL: 'postgres://sensitive-user:secret-password@bad-host/db' });
  assert.equal(result.ready, false);
  assert.equal(result.liveVerified, false);
  assert.ok(result.checks.some(check => check.id === 'jira' && check.status === 'error'));
  assert.ok(result.checks.some(check => check.id === 'database_auth_pair' && check.status === 'error'));
  for (const value of ['secret-never-print','another-never-print','sensitive-user','secret-password','bad-host']) assert.ok(!JSON.stringify(result).includes(value));
  assert.equal(inspectConfiguration({}).ready, true);
});

test('development continues to allow local HTTP and loopback origins', () => {
  for (const APP_ORIGIN of ['http://localhost:4173', 'http://127.0.0.1:4173', 'http://[::1]:4173']) {
    const result = inspectConfiguration({ NODE_ENV: 'development', APP_ORIGIN });
    assert.equal(result.checks.find(check => check.id === 'APP_ORIGIN').status, 'pass', APP_ORIGIN);
    assert.equal(result.ready, true, APP_ORIGIN);
  }
});

test('production checks require secure origin, encryption, matching auth and a distinct grader', () => {
  const valid = { NODE_ENV: 'production', APP_ORIGIN: 'https://crewos.example.test', APP_MASTER_KEY: 'a-production-key-long-enough-for-encryption',
    DATABASE_URL: 'postgresql://user:password@ep-test-pooler.us-east-1.aws.neon.tech/neondb', NEON_AUTH_BASE_URL: 'https://ep-test.neonauth.us-east-1.aws.neon.tech/neondb/auth',
    OPENROUTER_MODEL: 'provider/planner', OPENROUTER_EVALUATOR_MODEL: 'provider/grader' };
  assert.equal(inspectConfiguration(valid).ready, true);
  for (const patch of [{APP_ORIGIN:'http://crewos.example.test'}, {APP_ORIGIN:'https://crewos.example.test/subpath'}, {APP_MASTER_KEY:'short'}, {NEON_AUTH_BASE_URL:'https://ep-other.neonauth.us-east-1.aws.neon.tech/neondb/auth'}, {OPENROUTER_EVALUATOR_MODEL:'provider/planner'}, {COOKIE_SECURE:'false'}]) {
    assert.equal(inspectConfiguration({...valid,...patch}).ready, false, JSON.stringify(Object.keys(patch)));
  }
  assert.equal(inspectConfiguration({...valid, ATLASSIAN_OAUTH_CLIENT_ID:'id', ATLASSIAN_OAUTH_CLIENT_SECRET:'secret', ATLASSIAN_OAUTH_REDIRECT_URI:'https://wrong.example.test/oauth/jira/callback'}).ready, false);
});
