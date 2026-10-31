import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { resolve } from 'node:path';
import { createServer } from 'vite';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost:4173/',
  pretendToBeVisual: true,
});
const globalNames = [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Node',
  'Event', 'MouseEvent', 'FormData', 'MutationObserver', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame',
];
const previousGlobals = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
for (const name of globalNames) {
  const value = name in dom.window ? (name === 'window' ? dom.window : dom.window[name]) : undefined;
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import('react');
const { act, createElement, useState } = React;
const { createRoot } = await import('react-dom/client');
const vite = await createServer({
  configFile: false,
  root: resolve(import.meta.dirname, '../frontend'),
  appType: 'custom',
  esbuild: { jsx: 'automatic' },
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true },
  logLevel: 'silent',
});
const { ViewBoundary } = await vite.ssrLoadModule('/src/components/ViewBoundary.jsx');
const { PasswordReset } = await vite.ssrLoadModule('/src/components/PasswordReset.jsx');

after(async () => {
  await vite.close();
  dom.window.close();
  for (const [name, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

async function mount(t, element) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return container;
}

function input(container, name) {
  const element = container.querySelector(`[name="${name}"]`);
  assert.ok(element, `expected ${name} input to be rendered`);
  return element;
}

async function setValue(element, value) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value').set;
    setter.call(element, value);
    element.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

async function click(element) {
  await act(async () => {
    element.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function submitButton(container) {
  const button = container.querySelector('button[type="submit"]');
  assert.ok(button, 'expected a submit button');
  return button;
}

function Harness({ notify, onCancel }) {
  const [visible, setVisible] = useState(true);
  return visible
    ? createElement(PasswordReset, { notify, onCancel: () => { onCancel(); setVisible(false); } })
    : createElement('p', null, 'Sign in screen');
}

test('ViewBoundary catches a failed page render and retries into the healthy view', async (t) => {
  let shouldFail = true;
  function FlakyPage() {
    if (shouldFail) throw new Error('controlled page render failure');
    return createElement('p', null, 'Recovered screen');
  }

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await act(async () => root.render(createElement(ViewBoundary, null, createElement(FlakyPage))));
    assert.equal(container.querySelector('[role="alert"]')?.textContent.includes('This view could not open'), true);
    const retry = [...container.querySelectorAll('button')].find((button) => button.textContent.includes('Try again'));
    assert.ok(retry, 'failed view should offer a retry action');

    shouldFail = false;
    await click(retry);
    assert.match(container.textContent, /Recovered screen/);
    assert.equal(container.querySelector('[role="alert"]'), null);
  } finally {
    console.error = originalConsoleError;
  }
});

test('password recovery handles request, mismatch, resend, API error, success, and back transitions', async (t) => {
  const requests = [];
  const responses = [
    { status: 200, body: { data: { sent: true } } },
    { status: 503, body: { message: 'Mail delivery temporarily unavailable.' } },
    { status: 200, body: { data: { resent: true } } },
    { status: 400, body: { message: 'The reset code has expired.' } },
    { status: 200, body: { data: { reset: true } } },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : undefined });
    const response = responses.shift();
    assert.ok(response, `unexpected auth request ${url}`);
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const notifications = [];
  let cancelled = 0;
  const container = await mount(t, createElement(Harness, {
    notify: (message) => notifications.push(message),
    onCancel: () => { cancelled += 1; },
  }));
  await setValue(input(container, 'email'), ' Alice@Example.COM ');
  assert.equal(container.querySelector('[name="otp"]'), null, 'the code fields should appear only after requesting a code');

  await click(submitButton(container));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/auth/neon/email-otp/request-password-reset');
  assert.deepEqual(requests[0].body, { email: 'alice@example.com' });
  assert.equal(input(container, 'email').readOnly, true);
  assert.equal(notifications[0], 'If that email has an account, a reset code is on its way.');
  assert.ok(input(container, 'otp'));
  assert.ok(input(container, 'password'));
  assert.ok(input(container, 'confirmPassword'));

  await setValue(input(container, 'otp'), '123456');
  await setValue(input(container, 'password'), 'Correct-Horse-Battery');
  await setValue(input(container, 'confirmPassword'), 'Different-Horse-Battery');
  assert.equal(new FormData(container.querySelector('form')).get('password'), 'Correct-Horse-Battery');
  assert.equal(new FormData(container.querySelector('form')).get('confirmPassword'), 'Different-Horse-Battery');
  await click(submitButton(container));
  assert.equal(requests.length, 1, 'mismatched passwords must be rejected before sending a reset request');
  assert.match(container.querySelector('[role="alert"]')?.textContent || '', /passwords do not match/i);
  assert.ok(input(container, 'otp'), 'a mismatch should keep the code form open');

  const resend = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Resend reset code');
  assert.ok(resend);
  await click(resend);
  assert.equal(requests.length, 2);
  assert.match(container.querySelector('[role="alert"]')?.textContent || '', /Mail delivery temporarily unavailable/);
  assert.ok(input(container, 'otp'), 'a resend error should keep the code form open');

  await click(resend);
  assert.equal(requests.length, 3);
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.ok(input(container, 'otp'));

  await setValue(input(container, 'confirmPassword'), 'Correct-Horse-Battery');
  await click(submitButton(container));
  assert.equal(requests.length, 4);
  assert.equal(requests[3].url, '/api/auth/neon/email-otp/reset-password');
  assert.deepEqual(requests[3].body, {
    email: 'alice@example.com', otp: '123456', password: 'Correct-Horse-Battery',
  });
  assert.match(container.querySelector('[role="alert"]')?.textContent || '', /reset code has expired/i);
  assert.ok(input(container, 'otp'), 'a reset error should allow another attempt');

  await click(submitButton(container));
  assert.equal(requests.length, 5);
  assert.equal(cancelled, 1);
  assert.match(container.textContent, /Sign in screen/);
  assert.equal(notifications.at(-1), 'Password reset. Sign in with your new password.');

  const backContainer = await mount(t, createElement(Harness, {
    notify() {},
    onCancel: () => { cancelled += 1; },
  }));
  const back = [...backContainer.querySelectorAll('button')].find((button) => button.textContent === 'Back to sign in');
  assert.ok(back);
  await click(back);
  assert.equal(cancelled, 2);
  assert.match(backContainer.textContent, /Sign in screen/);
  assert.equal(requests.length, 5, 'back navigation should not call the auth endpoint');
});
