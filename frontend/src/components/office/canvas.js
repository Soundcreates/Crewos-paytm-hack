const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function officeMetrics(width, height) {
  const scale = Math.min(width, height);
  const avatarRadius = clamp(scale * 0.045, 13, 20);
  return { avatarRadius, deskWidth: clamp(scale * 0.14, 42, 58), deskHeight: clamp(scale * 0.09, 29, 37) };
}

function employeePosition(office, employee) {
  return office.employeePositions?.get(employee.id) || { x: Number(employee.x) || 0, y: Number(employee.y) || 0 };
}

function visibleEmployeePosition(position, width, height, metrics = officeMetrics(width, height)) {
  return { x: clamp(position.x, 0, Math.max(0, 1 - metrics.avatarRadius * 2 / width)), y: clamp(position.y, 0, Math.max(0, 1 - (metrics.avatarRadius * 2 + 20) / height)) };
}

function visibleDeskPosition(desk, width, height, metrics = officeMetrics(width, height)) {
  return { x: clamp(desk.x, 0, Math.max(0, 1 - metrics.deskWidth / width)), y: clamp(desk.y, 0, Math.max(0, 1 - (metrics.deskHeight + 12) / height)) };
}

function inside(point, left, top, width, height) {
  return point.x >= left && point.y >= top && point.x <= left + width && point.y <= top + height;
}

export function hitTestOffice(office, point, width, height, manager = true) {
  if (width <= 0 || height <= 0) return null;
  const { avatarRadius, deskWidth, deskHeight } = officeMetrics(width, height);
  for (const employee of [...(office.employees || [])].reverse()) {
    const position = visibleEmployeePosition(employeePosition(office, employee), width, height, { avatarRadius, deskWidth, deskHeight });
    if (inside(point, position.x * width, position.y * height, avatarRadius * 2, avatarRadius * 2 + 18)) {
      return { type: 'employee', id: employee.id, item: employee, draggable: manager && employee.activity !== 'meeting' };
    }
  }
  if (manager) {
    for (const desk of [...(office.desks || [])].reverse()) {
      const position = visibleDeskPosition(desk, width, height, { avatarRadius, deskWidth, deskHeight });
      const left = position.x * width, top = position.y * height;
      if (inside(point, left, top, deskWidth, deskHeight)) return { type: 'desk', id: desk.id, item: desk };
    }
  }
  const station = coffeeStationGeometry(office, width, height);
  if (inside(point, station.cx - station.w * .62, station.cy - station.h * .5, station.w * 1.24, station.h * 1.08)) {
    return { type: 'coffee', id: 'coffee-machine', item: station };
  }
  if (!manager) return null;
  for (const room of [...(office.rooms || [])].reverse()) {
    const left = room.x * width, top = room.y * height;
    if (!inside(point, left, top, room.w * width, room.h * height)) continue;
    const resizeSize = Math.min(14, room.w * width * .4, room.h * height * .4);
    const resize = point.x >= left + room.w * width - resizeSize && point.y >= top + room.h * height - resizeSize;
    return { type: 'room', id: room.id, item: room, mode: resize ? 'resize' : 'move' };
  }
  return null;
}

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function activityOf(employee) {
  const activity = employee.activity || employee.state || 'idle';
  return activity === 'active' ? 'idle' : activity;
}

function drawRoom(ctx, room, index, width, height, selected) {
  const x = room.x * width, y = room.y * height, w = room.w * width, h = room.h * height;
  ctx.save();
  ctx.shadowColor = 'rgba(31, 43, 55, .10)';
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  roundRect(ctx, x, y, w, h, 12);
  ctx.fillStyle = index % 2 ? '#eef1f4' : '#f8f8f4';
  ctx.fill();
  ctx.restore();
  ctx.lineWidth = selected ? 2 : 1;
  ctx.strokeStyle = selected ? '#4e5fe8' : '#c7d0d2';
  ctx.stroke();
  ctx.save();
  ctx.beginPath(); roundRect(ctx, x, y, w, h, 12);
  ctx.clip();
  ctx.strokeStyle = 'rgba(139, 153, 160, .13)';
  ctx.lineWidth = 1;
  for (let board = y + 42; board < y + h; board += 22) {
    ctx.beginPath(); ctx.moveTo(x + 1, board); ctx.lineTo(x + w - 1, board); ctx.stroke();
  }
  for (let seam = x + 30; seam < x + w; seam += 62) {
    ctx.beginPath(); ctx.moveTo(seam, y + 42); ctx.lineTo(seam, y + h); ctx.stroke();
  }
  ctx.fillStyle = '#192736';
  ctx.font = '700 12px ui-sans-serif, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(room.name || 'Room', x + 13, y + 10, Math.max(0, w - 26));
  ctx.fillStyle = '#788995';
  ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
  ctx.fillText(String(room.id || '').toUpperCase(), x + 13, y + 26, Math.max(0, w - 26));
  ctx.restore();
  if (selected) {
    ctx.fillStyle = '#4e5fe8';
    ctx.beginPath();
    ctx.moveTo(x + w - 15, y + h);
    ctx.lineTo(x + w, y + h - 15);
    ctx.lineTo(x + w, y + h);
    ctx.fill();
  }
}

function drawPlant(ctx, x, y, scale = 1) {
  ctx.save();
  ctx.fillStyle = 'rgba(31, 43, 55, .12)';
  ctx.beginPath(); ctx.ellipse(x, y + 5 * scale, 11 * scale, 4 * scale, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#c7a17c';
  roundRect(ctx, x - 8 * scale, y - 1 * scale, 16 * scale, 12 * scale, 3 * scale); ctx.fill();
  ctx.fillStyle = '#527f66';
  for (const [dx, dy, rotation] of [[-5, -7, -.6], [0, -12, 0], [5, -7, .6]]) {
    ctx.save(); ctx.translate(x + dx * scale, y + dy * scale); ctx.rotate(rotation);
    ctx.beginPath(); ctx.ellipse(0, 0, 3.4 * scale, 7 * scale, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

function drawChair(ctx, x, y, scale = 1, color = '#8b9caf') {
  ctx.save();
  ctx.fillStyle = 'rgba(31, 43, 55, .10)';
  ctx.beginPath(); ctx.ellipse(x, y + 5 * scale, 9 * scale, 5 * scale, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = color;
  roundRect(ctx, x - 8 * scale, y - 6 * scale, 16 * scale, 14 * scale, 5 * scale); ctx.fill();
  ctx.strokeStyle = 'rgba(35, 48, 61, .24)';
  ctx.lineWidth = 1.3 * scale;
  ctx.beginPath(); ctx.moveTo(x - 5 * scale, y + 7 * scale); ctx.lineTo(x - 7 * scale, y + 12 * scale);
  ctx.moveTo(x + 5 * scale, y + 7 * scale); ctx.lineTo(x + 7 * scale, y + 12 * scale); ctx.stroke();
  ctx.restore();
}

function drawDesk(ctx, desk, office, width, height, metrics, selected, now) {
  const position = visibleDeskPosition(desk, width, height, metrics);
  const x = position.x * width, y = position.y * height, w = metrics.deskWidth, h = metrics.deskHeight;
  const assignment = office.deskAssignments?.get(desk.id);
  const employee = office.employees?.find((person) => person.id === assignment);
  const activity = employee ? activityOf(employee) : 'idle';
  const color = employee ? stateColor(activity) : '#8b9caf';
  const unit = Math.min(w / 52, h / 34);
  drawChair(ctx, x + w / 2, y + h + 4 * unit, unit, '#8c9db0');
  ctx.save();
  ctx.shadowColor = 'rgba(31, 43, 55, .14)';
  ctx.shadowBlur = 5;
  ctx.shadowOffsetY = 2;
  roundRect(ctx, x + 2, y + h * .43, w - 4, h * .56, 5);
  ctx.fillStyle = '#caa77f';
  ctx.fill();
  ctx.strokeStyle = '#a78362'; ctx.lineWidth = 1; ctx.stroke();
  ctx.restore();
  roundRect(ctx, x + w * .3, y + h * .03, w * .4, h * .45, 4);
  ctx.fillStyle = '#243447';
  ctx.fill();
  roundRect(ctx, x + w * .33, y + h * .07, w * .34, h * .35, 2);
  ctx.fillStyle = '#dcebf0'; ctx.fill();
  ctx.fillStyle = '#aecbd2';
  ctx.fillRect(x + w * .37, y + h * .13, w * .15, h * .025);
  ctx.fillRect(x + w * .37, y + h * .19, w * .23, h * .025);
  ctx.fillStyle = activity === 'working' && Math.sin(now / 300) > 0 ? '#4e5fe8' : '#89a6b0';
  ctx.fillRect(x + w * .57, y + h * .28, w * .035, h * .06);
  ctx.strokeStyle = selected ? '#4e5fe8' : '#a78362';
  ctx.lineWidth = selected ? 2 : 1;
  ctx.stroke();
  ctx.fillStyle = '#f5eee3';
  roundRect(ctx, x + w * .21, y + h * .54, w * .32, h * .14, 2); ctx.fill();
  ctx.strokeStyle = '#9d9b92'; ctx.lineWidth = .7;
  for (let key = 0; key < 4; key++) {
    ctx.beginPath(); ctx.moveTo(x + w * (.24 + key * .065), y + h * .57); ctx.lineTo(x + w * (.24 + key * .065), y + h * .65); ctx.stroke();
  }
  ctx.fillStyle = '#657f94';
  roundRect(ctx, x + w * .72, y + h * .54, w * .12, h * .18, 3); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(x + w * .12, y + h * .7, 3.1 * unit, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#7c5544';
  ctx.beginPath(); ctx.arc(x + w * .12, y + h * .69, 2.1 * unit, 0, Math.PI * 2); ctx.fill();
  drawPlant(ctx, x + w * .91, y + h * .68, .62 * unit);
  ctx.fillStyle = color;
  ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(desk.label || 'Desk', x + w + 5, y + h * .72, 72);
  ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
}

function stateColor(activity) {
  return ({ working: '#4e5fe8', waiting: '#e7a174', meeting: '#75aabc', walking: '#538d78', paused: '#aab3b6', probation: '#86aeb8', draft: '#d6e98d' })[activity] || '#b9d890';
}

const AVATAR_HAIR = ['#243447', '#513b35', '#604c69', '#463c2d', '#354c56'];
const AVATAR_SKIN = ['#f0c7a5', '#dba883', '#bc8062', '#efcfb0', '#c68e72'];

function drawCoffeeCup(ctx, x, y, scale, now, reducedMotion) {
  ctx.save();
  ctx.fillStyle = '#fffdf5'; ctx.strokeStyle = '#ab7554'; ctx.lineWidth = 1.2 * scale;
  roundRect(ctx, x - 4 * scale, y - 5 * scale, 9 * scale, 10 * scale, 2 * scale); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#744832';
  ctx.beginPath(); ctx.ellipse(x, y - 4.2 * scale, 3.6 * scale, 1.4 * scale, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(x + 5 * scale, y - 1 * scale, 2.5 * scale, -Math.PI / 2, Math.PI / 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(149, 113, 82, .62)'; ctx.lineWidth = 1 * scale;
  for (let steam = 0; steam < 2; steam++) {
    const offset = steam * 4 * scale;
    const drift = reducedMotion ? 0 : Math.sin(now / 180 + steam) * 1.2 * scale;
    ctx.beginPath(); ctx.moveTo(x - 2 * scale + offset, y - 8 * scale);
    ctx.quadraticCurveTo(x - 5 * scale + drift + offset, y - 12 * scale, x - 2 * scale + offset, y - 15 * scale); ctx.stroke();
  }
  ctx.restore();
}

function coffeeStationGeometry(office, width, height) {
  const rooms = office.rooms || [];
  const room = rooms.find((item) => /coffee|cafe|kitchen|break|quiet|focus/i.test(String(item.id || '') + ' ' + String(item.name || '')))
    || rooms[rooms.length - 1];
  const size = Math.min(width, height);
  const w = clamp(size * .145, 42, 62), h = clamp(size * .15, 42, 64);
  const cx = room ? (room.x + room.w * .69) * width : width * .87;
  const cy = room ? (room.y + room.h * .49) * height : height * .76;
  return { cx, cy, w, h, room };
}

function drawCoffeeStation(ctx, station, now, reducedMotion, brewing = false) {
  const { cx, cy, w, h } = station;
  const unit = Math.min(w / 54, h / 58);
  ctx.save();
  ctx.fillStyle = 'rgba(31, 43, 55, .13)';
  ctx.beginPath(); ctx.ellipse(cx, cy + h * .43, w * .59, h * .13, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#c49b75';
  roundRect(ctx, cx - w * .58, cy + h * .17, w * 1.16, h * .22, 5 * unit); ctx.fill();
  ctx.strokeStyle = '#9e7658'; ctx.lineWidth = 1.2 * unit; ctx.stroke();
  ctx.fillStyle = '#677d78';
  roundRect(ctx, cx - w * .37, cy - h * .46, w * .74, h * .69, 6 * unit); ctx.fill();
  ctx.strokeStyle = '#475d5b'; ctx.lineWidth = 1.2 * unit; ctx.stroke();
  ctx.fillStyle = '#dce8df';
  roundRect(ctx, cx - w * .22, cy - h * .35, w * .44, h * .23, 3 * unit); ctx.fill();
  ctx.fillStyle = '#4e5fe8';
  ctx.beginPath(); ctx.arc(cx + w * .22, cy - h * .25, 2.7 * unit, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#344c4b';
  roundRect(ctx, cx - w * .19, cy + h * .04, w * .38, h * .06, 2 * unit); ctx.fill();
  ctx.fillStyle = '#b89a7b';
  roundRect(ctx, cx - w * .27, cy + h * .23, w * .54, h * .05, 2 * unit); ctx.fill();
  drawCoffeeCup(ctx, cx + w * .34, cy + h * .3, .74 * unit, now, reducedMotion);
  if (brewing && !reducedMotion) {
    ctx.fillStyle = 'rgba(78, 95, 232, .11)';
    ctx.beginPath(); ctx.arc(cx, cy - h * .56, 7 * unit + Math.sin(now / 150) * 2 * unit, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#536777'; ctx.font = '700 9px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText('Coffee machine', cx, cy + h * .48);
  ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic'; ctx.restore();
}

function drawMeetingTable(ctx, room, width, height) {
  const x = room.x * width, y = room.y * height, roomWidth = room.w * width, roomHeight = room.h * height;
  const w = Math.max(58, Math.min(roomWidth * .54, width * .27));
  const h = Math.max(24, Math.min(roomHeight * .19, height * .12));
  const cx = x + roomWidth / 2, cy = y + roomHeight * .64;
  const chair = Math.max(.62, Math.min(.94, Math.min(width, height) / 440));
  for (const seat of [-1, 1]) {
    for (const column of [-.29, .29]) drawChair(ctx, cx + w * column, cy + h * seat * .93, chair, seat < 0 ? '#92a9bb' : '#7d96a8');
  }
  drawChair(ctx, cx - w * .59, cy, chair, '#889caf');
  drawChair(ctx, cx + w * .59, cy, chair, '#889caf');
  ctx.save();
  ctx.fillStyle = 'rgba(31, 43, 55, .16)';
  ctx.beginPath(); ctx.ellipse(cx, cy + 5, w * .56, h * .68, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#d7bd98';
  roundRect(ctx, cx - w / 2, cy - h / 2, w, h, h / 2); ctx.fill();
  ctx.strokeStyle = '#a88869'; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.fillStyle = '#3c4c5b';
  roundRect(ctx, cx - w * .15, cy - h * .25, w * .25, h * .43, 3); ctx.fill();
  ctx.fillStyle = '#d8e8e8';
  roundRect(ctx, cx - w * .13, cy - h * .2, w * .21, h * .29, 2); ctx.fill();
  ctx.fillStyle = '#f5eee4';
  roundRect(ctx, cx + w * .17, cy - h * .22, w * .11, h * .3, 2); ctx.fill();
  ctx.strokeStyle = '#b6a38e'; ctx.lineWidth = .8; ctx.stroke();
  ctx.fillStyle = '#617079'; ctx.font = '700 9px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText('Team table', cx, cy + h * .74);
  ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic'; ctx.restore();
}

function coffeeBreakFrame(coffeeBreak, timestamp) {
  if (!coffeeBreak) return null;
  const elapsed = Math.max(0, timestamp - coffeeBreak.started);
  const walkMs = 1000, brewMs = 700, sipMs = 1200, returnMs = 1000;
  if (coffeeBreak.static) return elapsed >= walkMs + brewMs + sipMs + returnMs
    ? { complete: true }
    : { position: coffeeBreak.from, activity: 'idle', pose: 'drinking', phase: 'drinking' };
  const smooth = (value) => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };
  const between = (from, to, progress) => ({ x: from.x + (to.x - from.x) * smooth(progress), y: from.y + (to.y - from.y) * smooth(progress) });
  if (elapsed < walkMs) return { position: between(coffeeBreak.from, coffeeBreak.station, elapsed / walkMs), activity: 'walking', pose: 'carrying', phase: 'walking' };
  if (elapsed < walkMs + brewMs) return { position: coffeeBreak.station, activity: 'idle', pose: 'brewing', phase: 'brewing' };
  if (elapsed < walkMs + brewMs + sipMs) return { position: coffeeBreak.station, activity: 'idle', pose: 'drinking', phase: 'drinking' };
  if (elapsed < walkMs + brewMs + sipMs + returnMs) {
    return { position: between(coffeeBreak.station, coffeeBreak.from, (elapsed - walkMs - brewMs - sipMs) / returnMs), activity: 'walking', pose: 'carrying', phase: 'returning' };
  }
  return { complete: true };
}

function drawEmployee(ctx, employee, position, activity, now, width, height, radius, reducedMotion, selected, coffeePose = null) {
  const x = position.x * width + radius, y = position.y * height + radius;
  const seed = Array.from(String(employee.id || 'crew')).reduce((sum, letter) => sum + letter.charCodeAt(0), 0);
  const phase = reducedMotion ? 0 : now / (activity === 'walking' ? 92 : activity === 'working' ? 105 : 230) + seed;
  const walk = activity === 'walking';
  const bob = reducedMotion ? 0 : Math.sin(phase) * (walk ? 1.8 : activity === 'working' ? .5 : .8);
  const cy = y + bob, skin = AVATAR_SKIN[(seed >> 2) % AVATAR_SKIN.length], hair = AVATAR_HAIR[seed % AVATAR_HAIR.length];
  const typeMotion = activity === 'working' && !reducedMotion ? Math.sin(now / 78 + seed) * radius * .13 : 0;
  ctx.fillStyle = 'rgba(31, 43, 55, .16)'; ctx.beginPath(); ctx.ellipse(x, cy + radius * 1.08, radius * .72, radius * .2, 0, 0, Math.PI * 2); ctx.fill();
  if (['working', 'waiting', 'meeting', 'walking'].includes(activity) || coffeePose) {
    const ring = activity === 'working' ? 'rgba(78,95,232,.18)' : activity === 'waiting' ? 'rgba(231,161,116,.2)' : 'rgba(117,170,188,.17)';
    ctx.beginPath(); ctx.arc(x, cy, radius + 3, 0, Math.PI * 2); ctx.fillStyle = ring; ctx.fill();
  }
  ctx.beginPath(); ctx.arc(x, cy, radius, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
  ctx.beginPath(); ctx.arc(x, cy, radius * .82, 0, Math.PI * 2); ctx.fillStyle = stateColor(activity); ctx.fill();
  const legSwing = walk && !reducedMotion ? Math.sin(phase) * radius * .22 : 0;
  ctx.strokeStyle = '#35465a'; ctx.lineWidth = Math.max(2, radius * .14); ctx.lineCap = 'round'; ctx.beginPath();
  ctx.moveTo(x - radius * .2, cy + radius * .77); ctx.lineTo(x - radius * .27 + legSwing, cy + radius * 1.18);
  ctx.moveTo(x + radius * .2, cy + radius * .77); ctx.lineTo(x + radius * .27 - legSwing, cy + radius * 1.18); ctx.stroke();
  const headRadius = radius * .39, headY = cy - radius * .27;
  ctx.fillStyle = skin; ctx.beginPath(); ctx.arc(x, headY, headRadius, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = hair; ctx.beginPath(); ctx.arc(x, headY - radius * .02, headRadius, Math.PI * 1.03, Math.PI * 1.96);
  ctx.lineTo(x + headRadius * .9, headY + radius * .02); ctx.quadraticCurveTo(x, headY - headRadius * .48, x - headRadius * .9, headY + radius * .02); ctx.fill();
  ctx.fillStyle = '#25313a'; ctx.beginPath();
  ctx.arc(x - headRadius * .34, headY + headRadius * .14, Math.max(1, radius * .045), 0, Math.PI * 2);
  ctx.arc(x + headRadius * .34, headY + headRadius * .14, Math.max(1, radius * .045), 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fff'; roundRect(ctx, x - radius * .48, cy + radius * .18, radius * .96, radius * .62, radius * .28); ctx.fill();
  ctx.fillStyle = activity === 'working' ? '#5568e8' : stateColor(activity); roundRect(ctx, x - radius * .42, cy + radius * .23, radius * .84, radius * .54, radius * .25); ctx.fill();
  ctx.lineCap = 'round'; ctx.strokeStyle = skin; ctx.lineWidth = Math.max(2.2, radius * .21); ctx.beginPath();
  if (coffeePose === 'drinking') { ctx.moveTo(x + radius * .32, cy + radius * .42); ctx.lineTo(x + radius * .56, cy + radius * .05); }
  else if (coffeePose === 'brewing') { ctx.moveTo(x + radius * .32, cy + radius * .42); ctx.lineTo(x + radius * .82, cy + radius * .28); }
  else if (coffeePose === 'carrying') { ctx.moveTo(x + radius * .32, cy + radius * .42); ctx.lineTo(x + radius * .76, cy + radius * .61 + (walk ? legSwing * .4 : 0)); }
  else if (activity === 'working') {
    ctx.moveTo(x - radius * .34, cy + radius * .4); ctx.lineTo(x - radius * .68, cy + radius * .65 + typeMotion);
    ctx.moveTo(x + radius * .34, cy + radius * .4); ctx.lineTo(x + radius * .68, cy + radius * .65 - typeMotion);
  } else {
    ctx.moveTo(x - radius * .3, cy + radius * .42); ctx.lineTo(x - radius * .7 + legSwing, cy + radius * .78);
    ctx.moveTo(x + radius * .3, cy + radius * .42); ctx.lineTo(x + radius * .7 - legSwing, cy + radius * .78);
  }
  ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = '700 ' + Math.max(7, radius * .35) + 'px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const avatar = String(employee.avatar || String(employee.name || 'C').split(/\s+/).map((part) => part[0]).slice(0, 2).join('')).slice(0, 2).toUpperCase();
  ctx.fillText(avatar, x, cy + radius * .51, radius * .68);
  if (selected) { ctx.lineWidth = 2.5; ctx.strokeStyle = '#4e5fe8'; ctx.beginPath(); ctx.arc(x, cy, radius + 2.5, 0, Math.PI * 2); ctx.stroke(); }
  if (coffeePose === 'carrying') drawCoffeeCup(ctx, x + radius * .86, cy + radius * .49, radius / 19, now, reducedMotion);
  if (coffeePose === 'drinking') drawCoffeeCup(ctx, x + radius * .5, cy + radius * .03 - (reducedMotion ? 0 : Math.sin(now / 190) * radius * .05), radius / 18, now, reducedMotion);
  if (coffeePose === 'brewing') drawCoffeeCup(ctx, x + radius * .85, cy + radius * .4, radius / 19, now, reducedMotion);
  ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
  const label = String(employee.name || 'Employee').split(/\s+/)[0], textX = x - Math.max(20, label.length * 3);
  ctx.font = '700 10px ui-sans-serif, system-ui, sans-serif'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,.98)';
  ctx.strokeText(label, textX, cy + radius + 15); ctx.fillStyle = '#253b50'; ctx.fillText(label, textX, cy + radius + 15);
  if (coffeePose) { ctx.fillStyle = '#5568e8'; ctx.font = '700 8px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Coffee break', x, cy + radius + 26); }
  if (activity === 'waiting') {
    ctx.beginPath(); ctx.arc(x + radius * .7, cy - radius * .7, 8, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
    ctx.fillStyle = '#b36b48'; ctx.font = '700 12px ui-sans-serif, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillText('…', x + radius * .7, cy - radius * .7 + 4);
  } else if (activity === 'working') {
    ctx.fillStyle = '#4e5fe8'; roundRect(ctx, x + radius * .65, cy + radius * .08, 11, 8, 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillRect(x + radius * .65 + 3, cy + radius * .08 + 3, 5, 1.5);
  } else if (activity === 'meeting') {
    ctx.fillStyle = '#fff'; roundRect(ctx, x + radius * .55, cy - radius * .95, 18, 11, 4); ctx.fill();
    ctx.beginPath(); ctx.arc(x + radius * .55 + 6, cy - radius * .95 + 5, 1.2, 0, Math.PI * 2);
    ctx.arc(x + radius * .55 + 11, cy - radius * .95 + 5, 1.2, 0, Math.PI * 2); ctx.fillStyle = '#467a8a'; ctx.fill();
  }
  ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
}
function drawOfficeFurniture(ctx, office, width, height, now, reducedMotion, brewing) {
  const rooms = office.rooms || [];
  const meetingRoom = rooms.find((room) => /meeting|review|conference/i.test(String(room.id || '') + ' ' + String(room.name || '')))
    || rooms[0] || { x: .53, y: .05, w: .43, h: .45 };
  drawMeetingTable(ctx, meetingRoom, width, height);
  const station = coffeeStationGeometry(office, width, height);
  drawCoffeeStation(ctx, station, now, reducedMotion, brewing);
  const operationRoom = rooms.find((room) => /operation|work|studio/i.test(String(room.id || '') + ' ' + String(room.name || ''))) || rooms[0];
  if (operationRoom) {
    drawPlant(ctx, (operationRoom.x + operationRoom.w * .92) * width, (operationRoom.y + operationRoom.h * .82) * height, .82);
    drawPlant(ctx, (operationRoom.x + operationRoom.w * .08) * width, (operationRoom.y + operationRoom.h * .84) * height, .72);
  }
}

function drawOffice(ctx, office, width, height, now, reducedMotion, drag, transits, selectedId, coffeeBreak) {
  const metrics = officeMetrics(width, height);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#e9edf0';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(128, 145, 158, .2)';
  for (let x = 11; x < width; x += 24) for (let y = 11; y < height; y += 24) {
    ctx.beginPath(); ctx.arc(x, y, .8, 0, Math.PI * 2); ctx.fill();
  }
  for (const [index, room] of (office.rooms || []).entries()) drawRoom(ctx, room, index, width, height, drag?.hit.type === 'room' && drag.hit.id === room.id);
  for (const desk of office.desks || []) drawDesk(ctx, desk, office, width, height, metrics, drag?.hit.type === 'desk' && drag.hit.id === desk.id, now);
  const coffeeFrame = coffeeBreakFrame(coffeeBreak, now);
  drawOfficeFurniture(ctx, office, width, height, now, reducedMotion, coffeeFrame?.phase === 'brewing');
  for (const employee of office.employees || []) {
    const position = office.employeePositions?.get(employee.id) || employeePosition(office, employee);
    const transit = transits.get(employee.id);
    let visiblePosition = position;
    let activity = activityOf(employee);
    let coffeePose = null;
    if (coffeeBreak?.employeeId === employee.id && coffeeFrame) {
      visiblePosition = coffeeFrame.position;
      activity = coffeeFrame.activity;
      coffeePose = coffeeFrame.pose;
    }
    if (transit) {
      const progress = clamp((now - transit.started) / transit.duration, 0, 1);
      const eased = progress * progress * (3 - 2 * progress);
      visiblePosition = { x: transit.from.x + (position.x - transit.from.x) * eased, y: transit.from.y + (position.y - transit.from.y) * eased };
      if (progress < 1) activity = 'walking';
      else transits.delete(employee.id);
    }
    if (drag?.hit.type === 'employee' && drag.hit.id === employee.id && drag.moved) {
      visiblePosition = office.employeePositions.get(employee.id);
      activity = 'walking';
    }
    visiblePosition = visibleEmployeePosition(visiblePosition, width, height, metrics);
    drawEmployee(ctx, employee, visiblePosition, activity, now, width, height, metrics.avatarRadius, reducedMotion, selectedId === employee.id, coffeePose);
  }
  if (drag?.hit.type === 'room' && drag.hit.mode === 'resize') {
    ctx.fillStyle = '#4e5fe8';
    const room = drag.hit.item, x = (room.x + room.w) * width, y = (room.y + room.h) * height;
    const size = Math.min(14, room.w * width * .4, room.h * height * .4);
    ctx.beginPath(); ctx.moveTo(x - size, y); ctx.lineTo(x, y - size); ctx.lineTo(x, y); ctx.fill();
  }
}

export function mountOfficeCanvas(canvas, office, { manager = false, previousPositions = new Map(), onActivate = () => {}, onMoveEmployee = async () => {}, onError = () => {}, onCoffeeBreakChange = () => {} } = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { refresh() {}, destroy() {} };
  const reducedMotionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let reducedMotion = Boolean(reducedMotionQuery?.matches);
  let width = 0, height = 0, pixelRatio = 1, frame = 0, visible = true, disposed = false, drag = null, selectedId = null, coffeeBreak = null;
  let lastCoffeePhase = null;
  const transits = new Map();
  const positions = office.employeePositions || new Map();
  const now = () => performance.now();
  for (const employee of office.employees || []) {
    const previous = previousPositions.get(employee.id), current = positions.get(employee.id);
    if (previous && current && Math.hypot(previous.x - current.x, previous.y - current.y) > .025) transits.set(employee.id, { from: previous, started: now(), duration: 700 });
  }

  function draw(timestamp = now()) {
    if (disposed || !width || !height) return;
    if (coffeeBreak) {
      const state = coffeeBreakFrame(coffeeBreak, timestamp);
      if (state?.complete) finishCoffeeBreak();
      else if (state?.phase && state.phase !== lastCoffeePhase) {
        lastCoffeePhase = state.phase;
        onCoffeeBreakChange({ active: true, employeeName: coffeeBreak.employee.name || 'Crewmate', phase: state.phase });
      }
    }
    drawOffice(ctx, office, width, height, timestamp, reducedMotion, drag, transits, selectedId, coffeeBreak);
  }
  function finishCoffeeBreak() {
    if (!coffeeBreak) return;
    const employeeName = coffeeBreak.employee.name || 'Crewmate';
    coffeeBreak = null;
    lastCoffeePhase = null;
    onCoffeeBreakChange({ active: false, employeeName, phase: 'complete' });
  }
  function stopFrame() { if (frame) cancelAnimationFrame(frame); frame = 0; }
  function shouldAnimate() {
    return width > 0 && height > 0 && (Boolean(coffeeBreak) || (!reducedMotion && ((office.employees || []).length > 0 || transits.size > 0 || drag?.moved)));
  }
  function animate(timestamp) {
    frame = 0;
    if (disposed || !visible || document.hidden) return;
    draw(timestamp);
    if (shouldAnimate()) frame = requestAnimationFrame(animate);
  }
  function scheduleDraw() {
    draw();
    if (visible && !document.hidden && shouldAnimate() && !frame) frame = requestAnimationFrame(animate);
  }
  function startCoffeeBreak() {
    if (disposed || coffeeBreak || !width || !height) return false;
    const employee = (office.employees || []).find((person) => !['meeting', 'paused', 'draft', 'probation', 'walking'].includes(activityOf(person)));
    if (!employee) return false;
    const metrics = officeMetrics(width, height), station = coffeeStationGeometry(office, width, height);
    const from = visibleEmployeePosition(positions.get(employee.id) || employeePosition(office, employee), width, height, metrics);
    const to = visibleEmployeePosition({
      x: (station.cx - station.w * .78) / width - metrics.avatarRadius / width,
      y: (station.cy + station.h * .36) / height - metrics.avatarRadius / height,
    }, width, height, metrics);
    coffeeBreak = { employeeId: employee.id, employee, from, station: to, started: now(), static: reducedMotion };
    lastCoffeePhase = null;
    scheduleDraw();
    return true;
  }
  function resize() {
    const bounds = canvas.getBoundingClientRect();
    width = bounds.width; height = bounds.height;
    pixelRatio = Math.min(2, window.devicePixelRatio || 1);
    const nextWidth = Math.max(1, Math.round(width * pixelRatio)), nextHeight = Math.max(1, Math.round(height * pixelRatio));
    if (canvas.width !== nextWidth || canvas.height !== nextHeight) { canvas.width = nextWidth; canvas.height = nextHeight; }
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    scheduleDraw();
  }
  function localPoint(event) {
    const bounds = canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top, width: bounds.width, height: bounds.height };
  }
  function pointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    const point = localPoint(event);
    const hit = hitTestOffice(office, point, point.width, point.height, manager);
    if (hit?.type === 'coffee') {
      drag = { hit, startX: point.x, startY: point.y, moved: false, start: null };
      canvas.setPointerCapture?.(event.pointerId);
      return;
    }
    if (!hit || (hit.type === 'employee' && !hit.draggable)) {
      drag = hit ? { hit, startX: point.x, startY: point.y, moved: false, start: null } : null;
      if (drag) canvas.setPointerCapture?.(event.pointerId);
      return;
    }
    let start;
    if (hit.type === 'employee') start = visibleEmployeePosition(positions.get(hit.id) || employeePosition(office, hit.item), point.width, point.height);
    else if (hit.type === 'desk') start = visibleDeskPosition(hit.item, point.width, point.height);
    else start = { x: hit.item.x, y: hit.item.y, w: hit.item.w, h: hit.item.h };
    drag = { hit, startX: point.x, startY: point.y, start, moved: false };
    canvas.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }
  function pointerMove(event) {
    const point = localPoint(event);
    if (!drag) {
      const hit = hitTestOffice(office, point, point.width, point.height, manager);
      canvas.style.cursor = hit?.type === 'coffee' ? 'pointer' : hit?.type === 'employee' ? (hit.draggable ? 'grab' : 'pointer') : hit?.mode === 'resize' ? 'nwse-resize' : hit ? 'grab' : 'default';
      return;
    }
    if (!drag.start) return;
    if (Math.hypot(point.x - drag.startX, point.y - drag.startY) > 4) drag.moved = true;
    if (!drag.moved) return;
    const dx = (point.x - drag.startX) / point.width, dy = (point.y - drag.startY) / point.height;
    if (drag.hit.type === 'room' && drag.hit.mode === 'resize') {
      drag.hit.item.w = clamp(drag.start.w + dx, .05, 1 - drag.start.x);
      drag.hit.item.h = clamp(drag.start.h + dy, .05, 1 - drag.start.y);
    } else {
      const metrics = officeMetrics(point.width, point.height);
      const size = drag.hit.type === 'room' ? { w: drag.start.w, h: drag.start.h } : drag.hit.type === 'desk' ? { w: metrics.deskWidth / point.width, h: (metrics.deskHeight + 12) / point.height } : { w: .1, h: .2 };
      const x = clamp(drag.start.x + dx, 0, 1 - size.w);
      const y = clamp(drag.start.y + dy, 0, 1 - size.h);
      if (drag.hit.type === 'employee') positions.set(drag.hit.id, { x, y });
      else Object.assign(drag.hit.item, { x, y });
    }
    event.preventDefault();
    scheduleDraw();
  }
  async function pointerUp() {
    if (!drag) return;
    const current = drag; drag = null;
    if (current.hit.type === 'coffee') {
      if (!current.moved) startCoffeeBreak();
      return;
    }
    if (current.hit.type === 'employee' && current.moved) {
      const next = positions.get(current.hit.id);
      selectedId = current.hit.id;
      scheduleDraw();
      try { await onMoveEmployee(current.hit.id, next.x, next.y); }
      catch (error) { positions.set(current.hit.id, current.start); onError(error); scheduleDraw(); }
      return;
    }
    if (current.moved) { scheduleDraw(); return; }
    selectedId = current.hit.type === 'employee' ? current.hit.id : null;
    onActivate(current.hit);
    scheduleDraw();
  }
  function pointerCancel() {
    if (!drag) return;
    const current = drag; drag = null;
    if (current.start && current.moved) {
      if (current.hit.type === 'employee') positions.set(current.hit.id, current.start);
      else Object.assign(current.hit.item, current.start);
    }
    scheduleDraw();
  }
  function visibilityChange() {
    if (document.hidden) stopFrame();
    else scheduleDraw();
  }
  function motionChange(event) { reducedMotion = event.matches; scheduleDraw(); }
  canvas.addEventListener('pointerdown', pointerDown);
  canvas.addEventListener('pointermove', pointerMove);
  canvas.addEventListener('pointerup', pointerUp);
  canvas.addEventListener('pointercancel', pointerCancel);
  document.addEventListener('visibilitychange', visibilityChange);
  if (reducedMotionQuery?.addEventListener) reducedMotionQuery.addEventListener('change', motionChange);
  else reducedMotionQuery?.addListener?.(motionChange);
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  if (resizeObserver) resizeObserver.observe(canvas);
  else window.addEventListener('resize', resize);
  let intersectionObserver;
  if (typeof IntersectionObserver === 'function') {
    intersectionObserver = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (visible) scheduleDraw(); else stopFrame(); });
    intersectionObserver.observe(canvas);
  }
  resize();

  return {
    refresh: scheduleDraw,
    destroy() {
      if (disposed) return;
      disposed = true;
      stopFrame();
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      canvas.removeEventListener('pointerdown', pointerDown);
      canvas.removeEventListener('pointermove', pointerMove);
      canvas.removeEventListener('pointerup', pointerUp);
      canvas.removeEventListener('pointercancel', pointerCancel);
      document.removeEventListener('visibilitychange', visibilityChange);
      if (reducedMotionQuery?.removeEventListener) reducedMotionQuery.removeEventListener('change', motionChange);
      else reducedMotionQuery?.removeListener?.(motionChange);
      if (!resizeObserver) window.removeEventListener('resize', resize);
      finishCoffeeBreak();
      drag = null;
    },
    startCoffeeBreak,
  };
}
