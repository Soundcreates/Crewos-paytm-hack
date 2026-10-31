import test from 'node:test';
import assert from 'node:assert/strict';
import { mountOfficeCanvas } from '../frontend/src/components/office/canvas.js';

function createHarness({ width = 200, height = 100, dpr = 1, reducedMotion = false, contextAvailable = true, intersection = false, observeResize = true, legacyMedia = false } = {}) {
  const calls = [];
  const styles = [];
  const context = new Proxy({}, {
    get(target, key) {
      if (!(key in target)) target[key] = (...args) => calls.push([key, ...args]);
      return target[key];
    },
    set(target, key, value) { styles.push([key, value]); target[key] = value; return true; },
  });
  const handlers = new Map();
  let bounds = { left: 10, top: 20, width, height };
  const canvas = {
    width: 0, height: 0, style: {}, capturedPointers: [],
    getContext: () => contextAvailable ? context : null,
    getBoundingClientRect: () => bounds,
    setPointerCapture(id) { this.capturedPointers.push(id); },
    addEventListener(type, handler) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(handler);
    },
    removeEventListener(type, handler) { handlers.get(type)?.delete(handler); },
    dispatch(type, event = {}) {
      let result;
      for (const handler of [...(handlers.get(type) || [])]) result = handler(event);
      return result;
    },
    listenerCount(type) { return handlers.get(type)?.size || 0; },
  };
  const windowHandlers = new Map();
  const windowMock = {
    devicePixelRatio: dpr,
    addEventListener(type, handler) {
      if (!windowHandlers.has(type)) windowHandlers.set(type, new Set());
      windowHandlers.get(type).add(handler);
    },
    removeEventListener(type, handler) { windowHandlers.get(type)?.delete(handler); },
    dispatch(type) { for (const handler of [...(windowHandlers.get(type) || [])]) handler(); },
    listenerCount(type) { return windowHandlers.get(type)?.size || 0; },
    matchMedia() { return media; },
  };
  const documentHandlers = new Map();
  const documentMock = {
    hidden: false,
    addEventListener(type, handler) {
      if (!documentHandlers.has(type)) documentHandlers.set(type, new Set());
      documentHandlers.get(type).add(handler);
    },
    removeEventListener(type, handler) { documentHandlers.get(type)?.delete(handler); },
    dispatch(type) { for (const handler of [...(documentHandlers.get(type) || [])]) handler(); },
    listenerCount(type) { return documentHandlers.get(type)?.size || 0; },
  };
  const mediaHandlers = new Set();
  const media = {
    matches: reducedMotion,
    ...(legacyMedia ? {
      addListener(handler) { mediaHandlers.add(handler); },
      removeListener(handler) { mediaHandlers.delete(handler); },
    } : {
      addEventListener(type, handler) { if (type === 'change') mediaHandlers.add(handler); },
      removeEventListener(type, handler) { if (type === 'change') mediaHandlers.delete(handler); },
    }),
    get listenerCount() { return mediaHandlers.size; },
    setMatches(matches) {
      this.matches = matches;
      for (const handler of [...mediaHandlers]) handler({ matches });
    },
  };
  const frames = new Map();
  let nextFrame = 1;
  let clock = 0;
  let resizeObserver;
  let intersectionObserver;
  class ResizeObserverMock {
    constructor(callback) { this.callback = callback; this.target = null; this.disconnected = false; resizeObserver = this; }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
    trigger() { this.callback([{ target: this.target }]); }
  }
  class IntersectionObserverMock {
    constructor(callback) { this.callback = callback; this.disconnected = false; intersectionObserver = this; }
    observe(target) { this.target = target; }
    disconnect() { this.disconnected = true; }
    trigger(isIntersecting) { this.callback([{ target: this.target, isIntersecting }]); }
  }

  const keys = ['window', 'document', 'ResizeObserver', 'IntersectionObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, {
    window: windowMock,
    document: documentMock,
    ResizeObserver: observeResize ? ResizeObserverMock : undefined,
    IntersectionObserver: intersection ? IntersectionObserverMock : undefined,
    requestAnimationFrame(callback) { const id = nextFrame++; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    performance: { now: () => clock },
  });

  return {
    canvas, calls, styles, context, frames, media, document: documentMock, window: windowMock,
    get resizeObserver() { return resizeObserver; },
    get intersectionObserver() { return intersectionObserver; },
    setBounds(next) { bounds = { ...bounds, ...next }; },
    runFrame(id = frames.keys().next().value, timestamp = 1000) {
      const callback = frames.get(id);
      assert.ok(callback, `expected animation frame ${id} to be pending`);
      frames.delete(id);
      clock = timestamp;
      callback(timestamp);
    },
    cleanup() {
      for (const key of keys) {
        const descriptor = descriptors.get(key);
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    },
  };
}

const employee = { id: 'ada', name: 'Ada Lovelace', activity: 'working' };
const officeWithEmployee = () => ({
  rooms: [{ id: 'ops', name: 'Operations', x: .05, y: .08, w: .55, h: .78 }],
  desks: [{ id: 'desk-1', label: 'Ada', x: .68, y: .55 }],
  employees: [{ ...employee }],
  employeePositions: new Map([['ada', { x: .2, y: .2 }]]),
});

test('mount sizes for device pixel ratio, draws office content, observes resize, and cleans up', () => {
  const h = createHarness({ dpr: 3 });
  try {
    const office = officeWithEmployee();
    const mounted = mountOfficeCanvas(h.canvas, office);
    assert.equal(h.canvas.width, 400, 'pixel ratio is capped at 2');
    assert.equal(h.canvas.height, 200);
    assert.deepEqual(h.calls.find(([name]) => name === 'setTransform'), ['setTransform', 2, 0, 0, 2, 0, 0]);
    assert.ok(h.calls.some(([name, text]) => name === 'fillText' && text === 'Operations'));
    assert.ok(h.calls.some(([name, text]) => name === 'fillText' && text === 'Ada'));
    assert.ok(h.calls.some(([name]) => name === 'clearRect'));
    assert.equal(h.resizeObserver.target, h.canvas);
    assert.equal(h.frames.size, 1, 'animated employee schedules a frame');

    h.setBounds({ width: 300, height: 150 });
    h.resizeObserver.trigger();
    assert.equal(h.canvas.width, 600);
    assert.equal(h.canvas.height, 300);

    mounted.destroy();
    mounted.destroy();
    assert.equal(h.resizeObserver.disconnected, true);
    assert.equal(h.frames.size, 0, 'destroy cancels the scheduled frame');
    assert.equal(h.canvas.listenerCount('pointerdown'), 0);
    assert.equal(h.document.listenerCount('visibilitychange'), 0);
    const drawCount = h.calls.filter(([name]) => name === 'clearRect').length;
    mounted.refresh();
    assert.equal(h.calls.filter(([name]) => name === 'clearRect').length, drawCount, 'refresh after destroy is inert');
  } finally { h.cleanup(); }
});

test('supports resize fallback and returns inert controls when canvas context is unavailable', () => {
  const h = createHarness({ contextAvailable: false });
  try {
    const mounted = mountOfficeCanvas(h.canvas, officeWithEmployee());
    assert.equal(h.canvas.listenerCount('pointerdown'), 0);
    assert.equal(h.resizeObserver, undefined, 'no observer is installed without a context');
    assert.doesNotThrow(() => { mounted.refresh(); mounted.destroy(); });
  } finally { h.cleanup(); }

  const fallback = createHarness({ observeResize: false });
  try {
    const mounted = mountOfficeCanvas(fallback.canvas, { employees: [], employeePositions: new Map() });
    assert.equal(fallback.canvas.width, 200);
    assert.equal(fallback.frames.size, 0);
    assert.equal(fallback.window.listenerCount('resize'), 1);
    fallback.setBounds({ width: 320, height: 180 });
    globalThis.window.dispatch('resize');
    assert.equal(fallback.canvas.width, 320, 'window resize fallback redraws at the new size');
    mounted.destroy();
    assert.equal(globalThis.window.listenerCount('resize'), 0);
  } finally { fallback.cleanup(); }
});

test('reduced motion disables the animation loop and responds to preference changes', () => {
  const h = createHarness({ reducedMotion: true });
  try {
    const mounted = mountOfficeCanvas(h.canvas, officeWithEmployee());
    assert.equal(h.frames.size, 0);
    h.media.setMatches(false);
    assert.equal(h.frames.size, 1, 'turning reduced motion off starts animation');
    h.media.setMatches(true);
    assert.equal(h.frames.size, 1, 'already requested frame completes after preference change');
    h.runFrame();
    assert.equal(h.frames.size, 0, 'no further animation frame is requested');
    mounted.destroy();
    assert.equal(h.media.listenerCount, 0, 'preference listener is removed on destroy');
  } finally { h.cleanup(); }
});

test('activates a nondraggable employee and reports successful manager drag coordinates', async () => {
  const h = createHarness();
  try {
    const office = officeWithEmployee();
    const activated = [];
    const clickMount = mountOfficeCanvas(h.canvas, office, { onActivate: (hit) => activated.push(hit) });
    h.canvas.dispatch('pointerdown', { button: 0, pointerId: 1, clientX: 62, clientY: 52 });
    h.canvas.dispatch('pointerup');
    assert.equal(activated[0].type, 'employee');
    assert.equal(activated[0].id, 'ada');
    clickMount.destroy();

    const moveCalls = [];
    const dragMount = mountOfficeCanvas(h.canvas, office, {
      manager: true,
      onMoveEmployee: async (...args) => moveCalls.push(args),
    });
    const down = { button: 0, pointerId: 2, clientX: 62, clientY: 52, preventDefault() { this.prevented = true; } };
    h.canvas.dispatch('pointerdown', down);
    assert.equal(down.prevented, true);
    h.canvas.dispatch('pointermove', { pointerId: 2, clientX: 92, clientY: 72, preventDefault() {} });
    await h.canvas.dispatch('pointerup');
    assert.equal(h.canvas.capturedPointers.at(-1), 2);
    assert.equal(moveCalls[0][0], 'ada');
    assert.ok(Math.abs(moveCalls[0][1] - .35) < 1e-9);
    assert.ok(Math.abs(moveCalls[0][2] - .4) < 1e-9);
    dragMount.destroy();
  } finally { h.cleanup(); }
});

test('rolls back failed employee moves and canceled drags', async () => {
  const h = createHarness();
  try {
    const office = officeWithEmployee();
    const original = { ...office.employeePositions.get('ada') };
    const errors = [];
    const mounted = mountOfficeCanvas(h.canvas, office, {
      manager: true,
      onMoveEmployee: async () => { throw new Error('save failed'); },
      onError: (error) => errors.push(error.message),
    });
    const dragTo = (endX, endY, pointerId) => {
      h.canvas.dispatch('pointerdown', { button: 0, pointerId, clientX: 62, clientY: 52, preventDefault() {} });
      h.canvas.dispatch('pointermove', { pointerId, clientX: endX, clientY: endY, preventDefault() {} });
    };
    dragTo(82, 52, 3);
    await h.canvas.dispatch('pointerup');
    assert.deepEqual(office.employeePositions.get('ada'), original);
    assert.deepEqual(errors, ['save failed']);

    dragTo(92, 62, 4);
    h.canvas.dispatch('pointercancel');
    assert.deepEqual(office.employeePositions.get('ada'), original);
    mounted.destroy();
  } finally { h.cleanup(); }
});

test('pauses frames while hidden or outside the viewport and resumes when visible', () => {
  const h = createHarness({ intersection: true });
  try {
    const mounted = mountOfficeCanvas(h.canvas, officeWithEmployee());
    const initialFrame = h.frames.keys().next().value;
    h.intersectionObserver.trigger(false);
    assert.equal(h.frames.size, 0, 'offscreen canvas cancels animation');
    h.intersectionObserver.trigger(true);
    assert.equal(h.frames.size, 1, 'visible canvas redraws and animates');
    h.document.hidden = true;
    h.document.dispatch('visibilitychange');
    assert.equal(h.frames.size, 0, 'hidden document cancels animation');
    h.document.hidden = false;
    h.document.dispatch('visibilitychange');
    assert.equal(h.frames.size, 1, 'visible document resumes animation');
    assert.notEqual(h.frames.keys().next().value, initialFrame);
    mounted.destroy();
    assert.equal(h.intersectionObserver.disconnected, true);
  } finally { h.cleanup(); }
});

test('moves desks and rooms, resizes rooms, and restores canceled layout edits', () => {
  const h = createHarness();
  try {
    const room = { id: 'ops', name: 'Operations', x: .05, y: .08, w: .55, h: .78 };
    const desk = { id: 'desk-1', label: 'Desk A', x: .68, y: .55 };
    const office = { rooms: [room], desks: [desk], employees: [], employeePositions: new Map() };
    const activated = [];
    const mounted = mountOfficeCanvas(h.canvas, office, { manager: true, onActivate: (hit) => activated.push(hit) });

    h.canvas.dispatch('pointerdown', { button: 0, pointerId: 10, clientX: 40, clientY: 40, preventDefault() {} });
    h.canvas.dispatch('pointermove', { pointerId: 10, clientX: 60, clientY: 50, preventDefault() {} });
    assert.ok(Math.abs(room.x - .15) < 1e-9 && Math.abs(room.y - .18) < 1e-9);
    assert.ok(h.calls.filter(([name]) => name === 'lineTo').length >= 2, 'selected room draws its corner marker');
    h.canvas.dispatch('pointerup');
    assert.equal(activated.length, 0, 'moving a room does not activate it');

    const movedRoom = { x: room.x, y: room.y, w: room.w, h: room.h };
    h.canvas.dispatch('pointerdown', { button: 0, pointerId: 11, clientX: 150, clientY: 116, preventDefault() {} });
    h.canvas.dispatch('pointermove', { pointerId: 11, clientX: 170, clientY: 136, preventDefault() {} });
    assert.ok(Math.abs(room.w - .65) < 1e-9);
    assert.ok(Math.abs(room.h - .82) < 1e-9, 'resize clamps to the available height');
    assert.ok(h.calls.some(([name]) => name === 'lineTo'), 'resize drag draws its live corner handle');
    h.canvas.dispatch('pointercancel');
    assert.deepEqual({ x: room.x, y: room.y, w: room.w, h: room.h }, movedRoom);

    h.canvas.dispatch('pointerdown', { button: 0, pointerId: 12, clientX: 155, clientY: 80, preventDefault() {} });
    h.canvas.dispatch('pointermove', { pointerId: 12, clientX: 175, clientY: 83, preventDefault() {} });
    assert.ok(Math.abs(desk.x - .78) < 1e-9);
    assert.ok(Math.abs(desk.y - .58) < 1e-9);
    assert.ok(h.styles.some(([key, value]) => key === 'strokeStyle' && value === '#4e5fe8'), 'selected desk receives its selected stroke');
    h.canvas.dispatch('pointerup');
    assert.equal(activated.length, 0, 'moving a desk does not activate it');

    const movedDesk = { ...desk };
    h.canvas.dispatch('pointerdown', { button: 0, pointerId: 13, clientX: 170, clientY: 80, preventDefault() {} });
    h.canvas.dispatch('pointermove', { pointerId: 13, clientX: 190, clientY: 100, preventDefault() {} });
    assert.ok(Math.abs(desk.x - .79) < 1e-9 && Math.abs(desk.y - .59) < 1e-9, 'desk movement clamps at the canvas edge');
    h.canvas.dispatch('pointercancel');
    assert.deepEqual(desk, movedDesk);
    mounted.destroy();
  } finally { h.cleanup(); }
});

test('renders waiting, meeting, walking, paused, fallback, and normalized active states', () => {
  const h = createHarness({ width: 400, height: 300 });
  try {
    const employees = [
      { id: 'wait', name: 'Waiting Worker', activity: 'waiting' },
      { id: 'meet', name: 'Meeting Worker', activity: 'meeting' },
      { id: 'walk', name: 'Walking Worker', activity: 'walking' },
      { id: 'paused', name: 'Paused Worker', activity: 'paused' },
      { id: 'active', name: 'Active Worker', state: 'active' },
      { id: 'fallback', name: '' },
      { id: 'avatar', name: 'Named Avatar', avatar: 'NA', activity: 'unrecognized' },
    ];
    const employeePositions = new Map(employees.map((person, index) => [person.id, { x: .03 + index * .13, y: .2 }]));
    const mounted = mountOfficeCanvas(h.canvas, { employees, employeePositions });
    assert.ok(h.calls.some(([name, text]) => name === 'fillText' && text === '…'), 'waiting employee has its waiting badge');
    assert.ok(h.calls.some(([name, ...args]) => name === 'arc' && args[2] === 1.2), 'meeting employee has its meeting badge');
    assert.ok(h.calls.some(([name]) => name === 'lineTo'), 'walking employee draws its walking legs');
    assert.ok(h.calls.some(([name, text]) => name === 'fillText' && text === 'C'), 'empty name falls back to a C avatar');
    assert.ok(h.calls.some(([name, text]) => name === 'fillText' && text === 'Employee'), 'empty name falls back to Employee label');
    assert.ok(h.calls.some(([name, text]) => name === 'fillText' && text === 'NA'), 'explicit avatar initials are rendered');
    mounted.destroy();
  } finally { h.cleanup(); }
});

test('animates previous employee positions to their current positions and expires the transit', () => {
  const h = createHarness();
  try {
    const office = officeWithEmployee();
    const mounted = mountOfficeCanvas(h.canvas, office, {
      previousPositions: new Map([['ada', { x: .05, y: .05 }]]),
    });
    assert.ok(h.calls.some(([name]) => name === 'lineTo'), 'the initial transit frame renders walking legs');
    h.runFrame(undefined, Number.MAX_SAFE_INTEGER);
    assert.ok(h.calls.some(([name]) => name === 'fillRect'), 'after transit expiry the employee returns to the working icon');
    mounted.destroy();
  } finally { h.cleanup(); }
});

test('uses legacy media listeners and handles hover cursors and ignored nonprimary presses', () => {
  const h = createHarness({ legacyMedia: true });
  try {
    const office = {
      rooms: [{ id: 'ops', x: .05, y: .08, w: .55, h: .78 }],
      desks: [{ id: 'desk-1', x: .68, y: .55 }],
      employees: [{ id: 'ada', name: 'Ada', activity: 'meeting' }],
      employeePositions: new Map([['ada', { x: .2, y: .2 }]]),
    };
    const activated = [];
    const mounted = mountOfficeCanvas(h.canvas, office, { manager: true, onActivate: (hit) => activated.push(hit) });
    assert.equal(h.media.listenerCount, 1, 'legacy preference listener is attached');
    h.canvas.dispatch('pointermove', { clientX: 40, clientY: 40 });
    assert.equal(h.canvas.style.cursor, 'grab', 'room hover advertises moving');
    h.canvas.dispatch('pointermove', { clientX: 130, clientY: 106 });
    assert.equal(h.canvas.style.cursor, 'nwse-resize');
    h.canvas.dispatch('pointermove', { clientX: 155, clientY: 80 });
    assert.equal(h.canvas.style.cursor, 'grab', 'desk hover advertises moving');
    h.canvas.dispatch('pointermove', { clientX: 62, clientY: 52 });
    assert.equal(h.canvas.style.cursor, 'pointer', 'meeting employees are selectable but not draggable');
    h.canvas.dispatch('pointerdown', { button: 2, clientX: 62, clientY: 52 });
    h.canvas.dispatch('pointerup');
    assert.equal(activated.length, 0, 'nonprimary presses are ignored');
    h.canvas.dispatch('pointerdown', { button: 0, pointerId: 14, clientX: 62, clientY: 52 });
    h.canvas.dispatch('pointermove', { pointerId: 14, clientX: 92, clientY: 72 });
    h.canvas.dispatch('pointerup');
    assert.equal(activated[0].id, 'ada', 'meeting employee click activates without starting a drag');
    h.canvas.dispatch('pointermove', { clientX: 200, clientY: 120 });
    assert.equal(h.canvas.style.cursor, 'default');
    mounted.destroy();
    assert.equal(h.media.listenerCount, 0, 'legacy preference listener is removed on destroy');
  } finally { h.cleanup(); }
});

test('draws the coffee station, team table, and named employee sprite', () => {
  const h = createHarness({ width: 720, height: 420 });
  try {
    const office = {
      rooms: [], desks: [],
      employees: [{ id: 'mina', name: 'Mina Patel', avatar: 'MP', activity: 'idle' }],
      employeePositions: new Map([['mina', { x: .2, y: .3 }]]),
    };
    const mounted = mountOfficeCanvas(h.canvas, office);
    const labels = h.calls.filter(([method]) => method === 'fillText').map(([, text]) => text);
    assert.ok(labels.includes('Coffee machine'), 'coffee machine is named on the map');
    assert.ok(labels.includes('Team table'), 'conference table is named on the map');
    assert.ok(labels.includes('Mina'), 'employee name is drawn');
    assert.ok(labels.includes('MP'), 'employee initials are drawn');
    assert.ok(h.calls.some(([method, ...args]) => method === 'arc' && args[2] >= 13 && args[2] <= 20), 'worker sprite includes a recognizable avatar circle');
    mounted.destroy();
  } finally { h.cleanup(); }
});

test('coffee break only starts when an eligible employee is present', () => {
  const h = createHarness();
  try {
    const mounted = mountOfficeCanvas(h.canvas, { employees: [], employeePositions: new Map() });
    assert.equal(typeof mounted.startCoffeeBreak, 'function', 'mount exposes the scripted coffee routine');
    assert.equal(mounted.startCoffeeBreak(), false);
    mounted.destroy();
  } finally { h.cleanup(); }
});

test('coffee break animates to the station, shows its cup cue, then returns the worker home', () => {
  const h = createHarness({ width: 720, height: 420 });
  try {
    const office = {
      rooms: [], desks: [],
      employees: [{ id: 'mina', name: 'Mina Patel', avatar: 'MP', activity: 'idle' }],
      employeePositions: new Map([['mina', { x: .2, y: .3 }]]),
    };
    const mounted = mountOfficeCanvas(h.canvas, office);
    const nameX = () => h.calls.filter(([method, text]) => method === 'fillText' && text === 'Mina').at(-1)?.[2];
    const homeX = nameX();
    assert.equal(mounted.startCoffeeBreak(), true);
    assert.ok(h.frames.size > 0, 'routine is advanced by animation frames');

    const cues = [];
    for (let time = 0; time <= 20_000 && h.frames.size; time += 400) {
      const from = h.calls.length;
      h.runFrame(undefined, time);
      cues.push(...h.calls.slice(from).filter(([method]) => method === 'fillText').map(([, text]) => text));
    }
    const xPositions = h.calls.filter(([method, text]) => method === 'fillText' && text === 'Mina').map((call) => call[2]);
    assert.ok(Math.max(...xPositions) - Math.min(...xPositions) > 5, 'worker moves during the break');
    assert.ok(cues.some((text) => /coffee break|steam|☕|♨/iu.test(text)), 'active break draws a cup or steam cue');
    assert.ok(Math.abs(nameX() - homeX) < 1e-6, 'worker returns to the starting position');
    mounted.destroy();
  } finally { h.cleanup(); }
});

test('reduced motion keeps a coffee break static while frames advance', () => {
  const h = createHarness({ reducedMotion: true, width: 720, height: 420 });
  try {
    const office = {
      rooms: [], desks: [],
      employees: [{ id: 'mina', name: 'Mina Patel', avatar: 'MP', activity: 'idle' }],
      employeePositions: new Map([['mina', { x: .2, y: .3 }]]),
    };
    const mounted = mountOfficeCanvas(h.canvas, office);
    assert.equal(mounted.startCoffeeBreak(), true);
    const samples = [];
    for (const time of [0, 500, 1000, 2500, 5000, 10_000]) {
      if (!h.frames.size) break;
      const from = h.calls.length;
      h.runFrame(undefined, time);
      const position = h.calls.slice(from).filter(([method, text]) => method === 'fillText' && text === 'Mina').at(-1)?.[2];
      if (position !== undefined) samples.push(position);
    }
    assert.ok(samples.length <= 1 || samples.every((x) => Math.abs(x - samples[0]) < 1e-6), 'reduced motion does not animate worker travel');
    mounted.destroy();
  } finally { h.cleanup(); }
});
