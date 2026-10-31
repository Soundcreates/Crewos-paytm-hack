import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, neonAuth } from '../frontend/src/lib/api.js';
import { navigationGroupsForMode, routeFromHash } from '../frontend/src/config/navigation.js';

test('Neon authentication preserves structured verification errors and request references', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 'EMAIL_NOT_VERIFIED', message: 'Verify first' }), { status: 403, headers: {'content-type':'application/json','x-request-id':'request-verification'} });
  await assert.rejects(neonAuth('sign-in/email', {body:{email:'test@example.test',password:'not-logged'}}), error => error instanceof ApiError && error.code === 'EMAIL_NOT_VERIFIED' && error.status === 403 && error.requestId === 'request-verification');
});

test('password recovery uses the same-origin auth proxy with cookies and surfaces rejected codes', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [];
  globalThis.fetch = async (url,options) => {
    calls.push({url,options});
    return new Response(JSON.stringify(url.endsWith('/reset-password') ? {error:{code:'INVALID_OTP',message:'The reset code is invalid or expired.'}} : {success:true}), {status:url.endsWith('/reset-password') ? 400 : 200,headers:{'content-type':'application/json'}});
  };
  await neonAuth('email-otp/request-password-reset',{body:{email:'reset@example.test'}});
  await assert.rejects(neonAuth('email-otp/reset-password',{body:{email:'reset@example.test',otp:'123456',password:'new-password-123'}}),error=>error.code==='INVALID_OTP');
  assert.equal(calls[0].url,'/api/auth/neon/email-otp/request-password-reset');
  assert.equal(calls[0].options.credentials,'same-origin');
  assert.equal(calls[1].url,'/api/auth/neon/email-otp/reset-password');
});

test('every visible navigation route resolves in its mode while pilot still excludes schedules', () => {
  for (const pilotMode of [false, true]) {
    const items = navigationGroupsForMode(pilotMode).flatMap(([, links]) => links.map(([key]) => key));
    for (const key of items) assert.equal(routeFromHash('#' + key, pilotMode), key, `${key} route in ${pilotMode ? 'pilot' : 'full'} mode`);
  }
  assert.equal(routeFromHash('#settings', false), 'settings');
  assert.equal(routeFromHash('#settings', true), 'settings');
  assert.equal(routeFromHash('#/settings', false), 'settings');
  assert.equal(routeFromHash('#/settings', true), 'settings');
  assert.equal(routeFromHash('#/settings?view=policies', false), 'settings');
  assert.equal(routeFromHash('#/settings?view=members', true), 'settings');
  assert.equal(routeFromHash('#schedules', true), 'overview');
  assert.equal(routeFromHash('#schedules', false), 'schedules');
  assert.equal(routeFromHash('#unknown-route', false), 'overview');
  assert.equal(routeFromHash('#unknown-route', true), 'overview');
});
