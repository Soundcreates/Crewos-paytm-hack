import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { after } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const root = resolve(import.meta.dirname, '..');
const vite = await createServer({
  configFile: false,
  root: resolve(root, 'frontend'),
  appType: 'custom',
  esbuild: { jsx: 'automatic' },
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true },
  logLevel: 'silent',
});
const { shouldHandlePrimaryNavigation, attemptRouteNavigation } = await vite.ssrLoadModule('/src/components/AppShell.jsx');
const { routeLoadingLabel } = await vite.ssrLoadModule('/src/app/App.jsx');
const { ViewBoundary } = await vite.ssrLoadModule('/src/components/ViewBoundary.jsx');

after(() => vite.close());

test('sidebar navigation leaves modified and middle clicks to the browser', () => {
  assert.equal(shouldHandlePrimaryNavigation({ button: 0 }), true);
  for (const event of [
    { button: 1 }, { button: 2 }, { button: 0, metaKey: true }, { button: 0, ctrlKey: true },
    { button: 0, shiftKey: true }, { button: 0, altKey: true }, { button: 0, defaultPrevented: true },
  ]) assert.equal(shouldHandlePrimaryNavigation(event), false);
});

test('cancelled route navigation is reported so the mobile menu stays open', () => {
  let target;
  assert.equal(attemptRouteNavigation(next => { target = next; return false; }, 'tasks'), false);
  assert.equal(target, 'tasks');
  assert.equal(attemptRouteNavigation(() => true, 'employees'), true);
});

test('route loading status names the destination', () => {
  assert.equal(routeLoadingLabel('schedules'), 'Loading Schedules…');
  assert.equal(routeLoadingLabel('employee/employee-1/edit'), 'Loading Employee editor…');
  assert.equal(routeLoadingLabel('meeting/meeting-1'), 'Loading Meeting details…');
});

test('view failure copy distinguishes saved work from unsaved changes', () => {
  const boundary = new ViewBoundary({ children: React.createElement('p', null, 'healthy page') });
  boundary.state = ViewBoundary.getDerivedStateFromError(new Error('page render failed'));
  const markup = renderToStaticMarkup(boundary.render());
  assert.match(markup, /Saved work remains on the server/);
  assert.match(markup, /Any unsaved changes may not have been saved/);
  assert.doesNotMatch(markup, /Your work is saved on the server/);
});

test('keyboard and mobile corrections retain controls while giving actions room to tap', () => {
  const shellCss = readFileSync(resolve(root, 'frontend/src/styles/shell.css'), 'utf8');
  const responsiveCss = readFileSync(resolve(root, 'frontend/src/styles/responsive.css'), 'utf8');
  const office = readFileSync(resolve(root, 'frontend/src/components/office/KonvaOfficeScene.jsx'), 'utf8');
  const officePage = readFileSync(resolve(root, 'frontend/src/pages/OfficePages.jsx'), 'utf8');
  const schedules = readFileSync(resolve(root, 'frontend/src/pages/SchedulesPage.jsx'), 'utf8');
  const actions = readFileSync(resolve(root, 'frontend/src/pages/OperationsPages.jsx'), 'utf8');

  assert.match(shellCss, /\.page-wrap:focus\s*\{[^}]*outline:\s*2px solid var\(--accent\)/s);
  assert.doesNotMatch(shellCss, /\.page-wrap:focus\s*\{[^}]*outline:\s*none/s);
  assert.match(shellCss, /\.side-nav\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto/s);
  assert.match(office, /className="office-konva-stage"[^\n]*aria-describedby="office-directory-hint"(?![^\n]*tabIndex)/);
  assert.match(officePage, /label:'Team'/);
  assert.match(officePage, /Edit layout/);
  assert.match(officePage, /\{item\.name\|\|item\.label\} · Edit/);
  assert.match(schedules, /className="section-actions schedule-actions"/);
  assert.match(responsiveCss, /\.schedule-actions>\.btn\s*\{[^}]*min-height:\s*44px/);
  assert.match(responsiveCss, /\.schedule-actions\s*\{[^}]*gap:\s*8px/s);
  assert.match(actions, /call\.tool==='solari\.sandbox\.echo'\?'View command evidence':'Open replay'/);
});
