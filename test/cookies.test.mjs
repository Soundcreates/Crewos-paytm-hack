import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useSecureCookie } from '../backend/lib/cookies.mjs';

test('production cookies are secure by default while local HTTP remains configurable', () => {
  const previous = { nodeEnv: process.env.NODE_ENV, cookieSecure: process.env.COOKIE_SECURE };
  const http = { socket: { encrypted: false } };
  const https = { socket: { encrypted: true } };
  try {
    process.env.NODE_ENV = 'production';
    process.env.COOKIE_SECURE = '';
    assert.equal(useSecureCookie(http), true);

    process.env.NODE_ENV = 'development';
    assert.equal(useSecureCookie(http), false);
    assert.equal(useSecureCookie(https), true);
    process.env.COOKIE_SECURE = 'true';
    assert.equal(useSecureCookie(http), true);
    process.env.COOKIE_SECURE = 'false';
    assert.equal(useSecureCookie(http), false);
    assert.equal(useSecureCookie(https), false);
  } finally {
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.cookieSecure === undefined) delete process.env.COOKIE_SECURE;
    else process.env.COOKIE_SECURE = previous.cookieSecure;
  }
});
