import test from 'node:test';
import assert from 'node:assert/strict';
import { hitTestOffice, officeMetrics } from '../frontend/src/components/office/canvas.js';

test('office hit testing prioritizes avatars, then desks, then room resize corners', () => {
  const office = {
    rooms: [{ id: 'ops', x: .1, y: .1, w: .5, h: .5 }],
    desks: [{ id: 'desk-1', x: .2, y: .2 }],
    employees: [{ id: 'employee-1', name: 'Ada', activity: 'idle' }],
    employeePositions: new Map([['employee-1', { x: .2, y: .2 }]]),
  };
  assert.equal(hitTestOffice(office, { x: 170, y: 90 }, 800, 400).type, 'employee');
  assert.equal(hitTestOffice({ ...office, employees: [], employeePositions: new Map() }, { x: 165, y: 90 }, 800, 400).type, 'desk');
  assert.equal(hitTestOffice({ ...office, desks: [], employees: [], employeePositions: new Map() }, { x: 130, y: 100 }, 800, 400).mode, 'move');
  assert.equal(hitTestOffice({ ...office, desks: [], employees: [], employeePositions: new Map() }, { x: 470, y: 230 }, 800, 400).mode, 'resize');
  assert.equal(hitTestOffice({ ...office, employees: [], employeePositions: new Map() }, { x: 130, y: 100 }, 800, 400, false), null);
  const edgeEmployee = { employees: [{ id: 'edge' }], employeePositions: new Map([['edge', { x: 1, y: 1 }]]) };
  assert.equal(hitTestOffice(edgeEmployee, { x: 799, y: 398 }, 800, 400, false).id, 'edge');
});

test('office geometry stays legible in narrow canvases', () => {
  const metrics = officeMetrics(320, 280);
  assert.ok(metrics.avatarRadius >= 13);
  assert.ok(metrics.deskWidth > metrics.deskHeight);
});
