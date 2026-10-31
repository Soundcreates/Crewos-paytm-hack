import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { resolve } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

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

after(() => vite.close());

test('ViewBoundary renders a navigable alert fallback after a page render failure', () => {
  const boundary = new ViewBoundary({ children: React.createElement('p', null, 'healthy page') });
  boundary.state = ViewBoundary.getDerivedStateFromError(new Error('page render failed'));

  const markup = renderToStaticMarkup(boundary.render());
  assert.match(markup, /role="alert"/);
  assert.match(markup, /This view could not open/);
  assert.match(markup, /Try again/);
  assert.match(markup, /Reload workspace/);
  assert.doesNotMatch(markup, /healthy page/);
});

test('password recovery renders its request-code step before showing OTP fields', () => {
  const markup = renderToStaticMarkup(React.createElement(PasswordReset, {
    onCancel() {},
    notify() {},
  }));

  assert.match(markup, /Work email/);
  assert.match(markup, /Send reset code/);
  assert.doesNotMatch(markup, /Reset code/);
  assert.doesNotMatch(markup, /New password/);
});
