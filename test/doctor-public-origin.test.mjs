import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectConfiguration } from '../backend/lib/config-check.mjs';

const productionConfig = {
  NODE_ENV: 'production',
  APP_ORIGIN: 'https://crewos.example.test',
  APP_MASTER_KEY: 'test-only-placeholder-key-long-enough',
  DATABASE_URL: 'postgresql://user:password@ep-test-pooler.us-east-1.aws.neon.tech/neondb',
  NEON_AUTH_BASE_URL: 'https://ep-test.neonauth.us-east-1.aws.neon.tech/neondb/auth',
  OPENROUTER_MODEL: 'provider/planner',
  OPENROUTER_EVALUATOR_MODEL: 'provider/grader',
};

const nonPublicOrigins = [
  'https://localhost',
  'https://crewos.localhost',
  'https://localhost.',
  'https://localhost.localdomain',
  'https://127.0.0.1',
  'https://127.1', // WHATWG URL normalizes shorthand IPv4 to 127.0.0.1.
  'https://2130706433', // WHATWG URL normalizes a single integer IPv4 form.
  'https://0x7f000001', // WHATWG URL normalizes hexadecimal IPv4.
  'https://10.0.0.8',
  'https://172.16.0.1',
  'https://192.168.1.1',
  'https://169.254.169.254',
  'https://100.64.0.1',
  'https://0.0.0.0',
  'https://255.255.255.255',
  'https://224.0.0.1',
  'https://[::]',
  'https://[0:0:0:0:0:0:0:1]', // WHATWG URL normalizes expanded IPv6 to [::1].
  'https://[fd12:3456::1]',
  'https://[fe80::1]',
  'https://[::ffff:127.0.0.1]', // WHATWG URL canonicalizes the mapped address.
  'https://[::ffff:10.0.0.1]',
  'https://[2001:db8::1]',
  'https://[3fff::1]',
];

for (const origin of nonPublicOrigins) {
  test(`production doctor rejects non-public origin ${origin}`, () => {
    const result = inspectConfiguration({ ...productionConfig, APP_ORIGIN: origin });
    const check = result.checks.find(({ id }) => id === 'APP_ORIGIN');

    assert.equal(check.status, 'error', `${origin} is local or private, despite using HTTPS`);
    assert.equal(result.ready, false, 'a private HTTPS origin must not make the production configuration ready');
  });
}

for (const origin of [
  'https://crewos.example.test',
  'https://8.8.8.8',
  'https://[2606:4700:4700::1111]',
  'https://[::ffff:8.8.8.8]',
]) {
  test(`production doctor accepts public origin ${origin}`, () => {
    const result = inspectConfiguration({ ...productionConfig, APP_ORIGIN: origin });
    const check = result.checks.find(({ id }) => id === 'APP_ORIGIN');

    assert.equal(check.status, 'pass');
    assert.equal(result.ready, true);
    assert.equal(result.liveVerified, false, 'static origin checks do not verify DNS reachability or live service behavior');
  });
}
