import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

test('production dashboard HTML loads the bundled React entry and stylesheet', () => {
  const root = resolve(import.meta.dirname, '..');
  const html = readFileSync(resolve(root, 'frontend/dist/index.html'), 'utf8');
  const script = html.match(/src="(\/assets\/index-[A-Za-z0-9_-]+\.js)"/);
  const stylesheet = html.match(/href="(\/assets\/index-[A-Za-z0-9_-]+\.css)"/);

  assert.ok(script, 'Vite index must reference a hashed production JavaScript bundle');
  assert.ok(stylesheet, 'Vite index must reference a hashed production stylesheet');
  assert.equal(html.includes('/app.js'), false, 'production dashboard must not load the legacy vanilla entry');
  assert.ok(existsSync(resolve(root, 'frontend/dist', script[1].slice(1))), 'React bundle exists');
  assert.ok(existsSync(resolve(root, 'frontend/dist', stylesheet[1].slice(1))), 'stylesheet exists');
  assert.ok(readFileSync(resolve(root, 'frontend/dist', script[1].slice(1)), 'utf8').includes('for your AI team'), 'production entry includes the current workspace sign-in experience');
});
