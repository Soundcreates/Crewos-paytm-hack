import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Arc, Circle, Ellipse, Group, Layer, Line, Path, Rect, Stage, Text } from 'react-konva';

import {useAppearance} from '../../lib/appearance.jsx';
import {emblemIndex,emblemPaths} from '../../lib/identity.js';

const lightPalette={floor:'#f3f4f6',grid:'#e2e4e8',surface:'#fff',room:'#fbfcfd',header:'#eceff4',border:'#d6dbe4',accent:'#335cff',badge:'#edf1ff',text:'#17181b',muted:'#6d727c',furniture:'#c5cbd6',status:{working:'#335cff',waiting:'#ad7500',meeting:'#6475a0',walking:'#335cff',paused:'#8d929c',probation:'#ad7500',draft:'#8d929c',idle:'#19734a'}};
const darkPalette={floor:'#111215',grid:'#292d35',surface:'#1a1c20',room:'#202329',header:'#2a2e36',border:'#3c424e',accent:'#8ba4ff',badge:'#272f4a',text:'#f3f4f6',muted:'#a1a6b1',furniture:'#515968',status:{working:'#8ba4ff',waiting:'#f2c66d',meeting:'#b1bfe1',walking:'#8ba4ff',paused:'#a1a6b1',probation:'#f2c66d',draft:'#a1a6b1',idle:'#8ad7ac'}};
function useOfficePalette(){return useAppearance().theme==='dark'?darkPalette:lightPalette;}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const statusColors = {
  working: '#6a6a6a',
  waiting: '#a3a3a3',
  meeting: '#878787',
  walking: '#7d7d7d',
  paused: '#989898',
  probation: '#a3a3a3',
  draft: '#adadad',
  idle: '#838383',
};
const getActivity = (employee) => {
  const value = employee.activity || employee.state || 'idle';
  return value === 'active' ? 'idle' : value;
};
const firstName = (employee) => String(employee.name || 'Employee').trim().split(/\s+/)[0];

function roomKind(room) {
  const name = String((room?.id || '') + ' ' + (room?.name || '')).toLowerCase();
  if (/meeting|review|conference|board/.test(name)) return 'meeting';
  if (/coffee|cafe|kitchen|break/.test(name)) return 'cafe';
  if (/quiet|focus|library/.test(name)) return 'quiet';
  return 'work';
}

function positionFor(layout, kind, item) {
  return layout[kind + ':' + item.id] || { x: Number(item.x) || 0, y: Number(item.y) || 0, w: Number(item.w) || 0, h: Number(item.h) || 0 };
}

function FloorPlan({ width, height }) {
  const p=useOfficePalette();
  const vertical = [], horizontal = [];
  for (let x = 18; x < width; x += 28) vertical.push(<Line key={'v' + x} points={[x, 0, x, height]} stroke={p.grid} strokeWidth={1} opacity={0.44}/>);
  for (let y = 18; y < height; y += 28) horizontal.push(<Line key={'h' + y} points={[0, y, width, y]} stroke={p.grid} strokeWidth={1} opacity={0.44}/>);
  return <Layer listening={false}>
    <Rect width={width} height={height} fill={p.floor}/>
    {vertical}{horizontal}
    <Rect x={12} y={12} width={width - 24} height={height - 24} cornerRadius={15} stroke={p.border} strokeWidth={1.5} fill={p.floor}/>
    <Group x={25} y={22}>
      <Rect width={117} height={22} cornerRadius={11} fill={p.surface} stroke={p.border}/>
      <Circle x={12} y={11} radius={3} fill="#9d9d9d"/>
      <Text x={22} y={5} text="TEAM FLOOR" fontSize={8} fontStyle="bold" letterSpacing={.65} fill={p.muted}/>
    </Group>
  </Layer>;
}

function RoomShape({ room, index, position, width, height, manager, hovered, onHover, onClick, onDragEnd, onResize }) {
  const p=useOfficePalette();
  const x = position.x * width, y = position.y * height;
  const w = position.w * width, h = position.h * height;
  const kind = roomKind(room);
  const palettes={fill:p.room,edge:p.border,accent:kind==='meeting'?p.accent:p.furniture,floor:p.header};
  const size = 12;
  return <Group
    key={room.id || 'room-' + index}
    x={x}
    y={y}
    draggable={manager}
    dragBoundFunc={(point) => ({ x: clamp(point.x, 0, Math.max(0, width - w)), y: clamp(point.y, 0, Math.max(0, height - h)) })}
    onDragEnd={(event) => onDragEnd(room, event.target.x() / width, event.target.y() / height)}
    onClick={(event) => { event.cancelBubble = true; onClick({ type: 'room', id: room.id, item: room, mode: 'move' }); }}
    onTap={(event) => { event.cancelBubble = true; onClick({ type: 'room', id: room.id, item: room, mode: 'move' }); }}
    onMouseEnter={() => onHover('room:' + room.id)}
    onMouseLeave={() => onHover(null)}
    onTouchStart={() => onHover('room:' + room.id)}
  >
    <Rect width={w} height={h} cornerRadius={11} fill={palettes.fill} stroke={hovered ? p.accent : palettes.edge} strokeWidth={hovered ? 2 : 1.3} shadowColor="#434343" shadowBlur={hovered ? 13 : 8} shadowOpacity={.12} shadowOffsetY={3}/>
    <Rect x={1} y={1} width={w - 2} height={35} cornerRadius={[10, 10, 4, 4]} fill={palettes.floor}/>
    <Rect x={0} y={0} width={5} height={h} cornerRadius={[10, 0, 0, 10]} fill={palettes.accent} opacity={.82}/>
    <Text x={13} y={8} width={Math.max(35, w - 65)} text={String(room.name || 'Room').toUpperCase()} fontSize={Math.min(11, Math.max(8, w / 23))} fontStyle="bold" letterSpacing={.5} fill={p.text} ellipsis/>
    <Text x={13} y={23} width={Math.max(25, w - 26)} text={String(room.id || '').toUpperCase()} fontSize={8} fontFamily="IBM Plex Mono, monospace" fill={p.muted} ellipsis/>
    <Line points={[11, 39, w - 11, 39]} stroke={palettes.edge} strokeWidth={1} opacity={.62} listening={false}/>
    {Array.from({ length: Math.max(0, Math.floor((h - 44) / 32)) }, (_, row) => <Line key={'floor-' + row} points={[8, 52 + row * 32, w - 8, 52 + row * 32]} stroke={palettes.edge} strokeWidth={.6} opacity={.15} listening={false}/>)}
    {manager && <Group
      x={w - size}
      y={h - size}
      draggable
      dragBoundFunc={(point) => ({ x: clamp(point.x, 34, width - x - size), y: clamp(point.y, 34, height - y - size) })}
      onDragStart={(event) => { event.cancelBubble = true; }}
      onDragMove={(event) => { event.cancelBubble = true; }}
      onDragEnd={(event) => {
        event.cancelBubble = true;
        const node = event.target;
        onResize(room, clamp((node.x() + size) / width, .08, 1 - position.x), clamp((node.y() + size) / height, .08, 1 - position.y));
      }}
    >
      <Rect width={size * 2} height={size * 2} x={-size / 2} y={-size / 2} cornerRadius={5} fill={p.accent} stroke={p.surface} strokeWidth={1.5} shadowColor="#5d5d5d" shadowBlur={5} shadowOpacity={.26}/>
      <Line points={[2, 9, 9, 2]} stroke="#fff" strokeWidth={1.4} listening={false}/>
    </Group>}
  </Group>;
}

function Plant({ x, y, scale = 1 }) {
  return <Group x={x} y={y} scaleX={scale} scaleY={scale} listening={false}>
    <Ellipse x={0} y={8} radiusX={12} radiusY={4} fill="#414141" opacity={.12}/>
    <Rect x={-8} y={-1} width={16} height={12} cornerRadius={3} fill="#a1a1a1" stroke="#838383" strokeWidth={.7}/>
    <Ellipse x={-5} y={-9} radiusX={3.5} radiusY={8} rotation={-35} fill="#818181"/>
    <Ellipse x={0} y={-13} radiusX={3.3} radiusY={8} fill="#999999"/>
    <Ellipse x={5} y={-9} radiusX={3.5} radiusY={8} rotation={35} fill="#7e7e7e"/>
  </Group>;
}

function Chair({ x, y, fill = '#9a9a9a', scale = 1 }) {
  return <Group x={x} y={y} scaleX={scale} scaleY={scale} listening={false}>
    <Ellipse x={0} y={5} radiusX={9} radiusY={4} fill="#333333" opacity={.1}/>
    <Rect x={-8} y={-6} width={16} height={14} cornerRadius={5} fill={fill} stroke="#767676" strokeWidth={.7}/>
    <Line points={[-5, 7, -7, 12]} stroke="#828282" strokeWidth={1.3} lineCap="round"/>
    <Line points={[5, 7, 7, 12]} stroke="#828282" strokeWidth={1.3} lineCap="round"/>
  </Group>;
}

function Desk({ desk, position, width, height, manager, hovered, onHover, onClick, onDragEnd, employee }) {
  const p=useOfficePalette();
  const x = position.x * width, y = position.y * height;
  const scale = clamp(Math.min(width, height) / 470, .76, 1.16);
  const w = 62 * scale, h = 38 * scale;
  const activity = employee ? getActivity(employee) : 'idle';
  return <Group
    key={desk.id}
    x={x}
    y={y}
    draggable={manager}
    dragBoundFunc={(point) => ({ x: clamp(point.x, 0, Math.max(0, width - w - 12)), y: clamp(point.y, 0, Math.max(0, height - h - 20)) })}
    onDragEnd={(event) => onDragEnd(desk, event.target.x() / width, event.target.y() / height)}
    onClick={(event) => { event.cancelBubble = true; onClick({ type: 'desk', id: desk.id, item: desk }); }}
    onTap={(event) => { event.cancelBubble = true; onClick({ type: 'desk', id: desk.id, item: desk }); }}
    onMouseEnter={() => onHover('desk:' + desk.id)}
    onMouseLeave={() => onHover(null)}
  >
    <Chair x={w / 2} y={h + 4} scale={scale}/>
    <Rect x={4} y={h * .37} width={w - 8} height={h * .57} cornerRadius={5} fill={p.furniture} stroke={hovered ? p.accent : p.border} strokeWidth={hovered ? 2 : 1} shadowColor="#3e3e3e" shadowBlur={5} shadowOpacity={.14} shadowOffsetY={2}/>
    <Rect x={w * .28} y={0} width={w * .44} height={h * .5} cornerRadius={4} fill="#353535" stroke="#272727" strokeWidth={1}/>
    <Rect x={w * .32} y={3} width={w * .36} height={h * .36} cornerRadius={2} fillLinearGradientStartPoint={{ x: 0, y: 0 }} fillLinearGradientEndPoint={{ x: w * .36, y: h * .36 }} fillLinearGradientColorStops={[0, '#ededed', 1, '#cbcbcb']}/>
    <Line points={[w * .38, h * .13, w * .58, h * .13]} stroke="#a6a6a6" strokeWidth={1}/>
    <Line points={[w * .38, h * .22, w * .62, h * .22]} stroke="#b8b8b8" strokeWidth={1}/>
    <Circle x={w * .63} y={h * .32} radius={2.2} fill={statusColors[activity] || statusColors.idle}/>
    <Rect x={w * .24} y={h * .59} width={w * .27} height={h * .14} cornerRadius={2} fill="#efefef"/>
    <Rect x={w * .69} y={h * .57} width={w * .11} height={h * .18} cornerRadius={3} fill="#838383"/>
    <Plant x={w * .92} y={h * .68} scale={.45 * scale}/>
    <Text x={0} y={h + 16} width={w + 18} text={desk.label || 'Desk'} fontSize={8} fontStyle="bold" fill={p.muted}/>
  </Group>;
}

function MeetingTable({ room, width, height }) {
  const p=useOfficePalette();
  const cx = (room.x + room.w / 2) * width;
  const cy = (room.y + room.h * .65) * height;
  const tableWidth = Math.max(62, Math.min(room.w * width * .48, width * .26));
  const tableHeight = Math.max(28, Math.min(room.h * height * .18, height * .12));
  const chairScale = clamp(Math.min(width, height) / 460, .62, .9);
  return <Group listening={false}>
    {[-1, 1].map((row) => [-.28, .28].map((column) => <Chair key={row + ':' + column} x={cx + tableWidth * column} y={cy + tableHeight * row * .9} scale={chairScale} fill={row < 0 ? '#aaaaaa' : '#959595'}/>))}
    <Chair x={cx - tableWidth * .58} y={cy} scale={chairScale}/>
    <Chair x={cx + tableWidth * .58} y={cy} scale={chairScale}/>
    <Ellipse x={cx} y={cy + 5} radiusX={tableWidth * .53} radiusY={tableHeight * .62} fill="#333333" opacity={.13}/>
    <Rect x={cx - tableWidth / 2} y={cy - tableHeight / 2} width={tableWidth} height={tableHeight} cornerRadius={tableHeight / 2} fill={p.furniture} stroke={p.border} strokeWidth={1.2} shadowColor="#3c3c3c" shadowBlur={5} shadowOpacity={.13} shadowOffsetY={2}/>
    <Rect x={cx - tableWidth * .1} y={cy - tableHeight * .22} width={tableWidth * .2} height={tableHeight * .43} cornerRadius={3} fill="#484848"/>
    <Rect x={cx - tableWidth * .075} y={cy - tableHeight * .16} width={tableWidth * .15} height={tableHeight * .28} cornerRadius={2} fill="#e6e6e6"/>
    <Rect x={cx + tableWidth * .2} y={cy - tableHeight * .2} width={tableWidth * .1} height={tableHeight * .31} cornerRadius={2} fill="#f4f4f4" stroke="#ababab" strokeWidth={.7}/>
    <Text x={cx - 40} y={cy + tableHeight * .73} width={80} align="center" text="TEAM TABLE" fontSize={8} fontStyle="bold" letterSpacing={.5} fill={p.muted}/>
  </Group>;
}

function CoffeeStation({ room, width, height, brewing, onStart }) {
  const p=useOfficePalette();
  const size = Math.min(width, height);
  const machineWidth = clamp(size * .13, 48, 65), machineHeight = clamp(size * .15, 54, 68);
  const cx = room ? (room.x + room.w * .73) * width : width * .88;
  const cy = room ? (room.y + room.h * .53) * height : height * .76;
  return <Group x={cx} y={cy} onClick={(event) => { event.cancelBubble = true; onStart(); }} onTap={(event) => { event.cancelBubble = true; onStart(); }} onMouseEnter={(event) => { event.target.getStage().container().style.cursor = 'pointer'; }} onMouseLeave={(event) => { event.target.getStage().container().style.cursor = 'default'; }}>
    <Ellipse x={0} y={machineHeight * .48} radiusX={machineWidth * .58} radiusY={machineHeight * .13} fill="#363636" opacity={.16}/>
    <Rect x={-machineWidth * .58} y={machineHeight * .16} width={machineWidth * 1.16} height={machineHeight * .22} cornerRadius={5} fill="#a1a1a1" stroke="#7c7c7c" strokeWidth={1}/>
    <Rect x={-machineWidth * .37} y={-machineHeight * .47} width={machineWidth * .74} height={machineHeight * .68} cornerRadius={7} fillLinearGradientStartPoint={{ x: -machineWidth / 2, y: -machineHeight / 2 }} fillLinearGradientEndPoint={{ x: machineWidth / 2, y: machineHeight / 2 }} fillLinearGradientColorStops={[0, '#919191', 1, '#656565']} stroke="#575757" strokeWidth={1.2} shadowColor="#323232" shadowBlur={7} shadowOpacity={.18} shadowOffsetY={2}/>
    <Rect x={-machineWidth * .22} y={-machineHeight * .34} width={machineWidth * .44} height={machineHeight * .23} cornerRadius={3} fill="#ebebeb" stroke="#c3c3c3" strokeWidth={.6}/>
    <Circle x={machineWidth * .22} y={-machineHeight * .24} radius={3} fill={brewing ? '#a5a5a5' : '#808080'} shadowColor={brewing ? '#a5a5a5' : '#808080'} shadowBlur={brewing ? 7 : 2} shadowOpacity={.6}/>
    <Rect x={-machineWidth * .19} y={machineHeight * .03} width={machineWidth * .38} height={machineHeight * .07} cornerRadius={2} fill="#454545"/>
    <Rect x={-machineWidth * .28} y={machineHeight * .22} width={machineWidth * .56} height={machineHeight * .05} cornerRadius={2} fill="#949494"/>
    <Group x={machineWidth * .34} y={machineHeight * .29} scaleX={.75} scaleY={.75}>
      <Rect x={-5} y={-5} width={10} height={12} cornerRadius={2} fill="#fdfdfd" stroke="#7e7e7e" strokeWidth={1}/>
      <Ellipse x={0} y={-4} radiusX={3.8} radiusY={1.4} fill="#505050"/>
      <Arc x={5} y={0} innerRadius={1.5} outerRadius={3.5} angle={180} rotation={270} stroke="#7e7e7e" strokeWidth={1}/>
    </Group>
    <Text x={-54} y={machineHeight * .5} width={108} align="center" text={brewing ? 'BREWING' : 'COFFEE MACHINE'} fontSize={8} fontStyle="bold" letterSpacing={.4} fill={p.muted}/>
  </Group>;
}

function EmployeeToken({ employee, position, width, height, now, reducedMotion, selected, manager, onClick, onDragEnd }) {
  const p=useOfficePalette();
  const radius=clamp(Math.min(width,height)*.043,16,21);
  const activity=getActivity(employee),canDrag=manager&&activity!=='meeting';
  const status=p.status[activity]||p.muted;
  const bob=reducedMotion||activity!=='walking'?0:Math.sin(now/92)*1.2;
  const avatar=String(employee.avatar||String(employee.name||'C').split(/\s+/).map(part=>part[0]).slice(0,2).join('')).slice(0,3).toUpperCase();
  const x=position.x*width,y=position.y*height;
  return <Group x={x} y={y} draggable={canDrag}
    dragBoundFunc={point=>({x:clamp(point.x,0,Math.max(0,width-radius*2)),y:clamp(point.y,0,Math.max(0,height-radius*2-28))})}
    onDragEnd={event=>onDragEnd(employee,event.target.x()/width,event.target.y()/height)}
    onClick={event=>{event.cancelBubble=true;onClick({type:'employee',id:employee.id,item:employee,draggable:canDrag});}}
    onTap={event=>{event.cancelBubble=true;onClick({type:'employee',id:employee.id,item:employee,draggable:canDrag});}}
    onMouseEnter={event=>{event.target.getStage().container().style.cursor=canDrag?'grab':'pointer';}}
    onMouseLeave={event=>{event.target.getStage().container().style.cursor='default';}}>
    <Rect y={bob} width={radius*2} height={radius*2} cornerRadius={10} fill={p.badge} stroke={selected?p.accent:p.border} strokeWidth={selected?2:1} shadowColor="#000" shadowBlur={8} shadowOpacity={.12} shadowOffsetY={2}/>
    <Path x={radius*.23} y={radius*.13+bob} scaleX={radius*.032} scaleY={radius*.032} data={emblemPaths[emblemIndex(employee.id||employee.name)]} fill={p.accent} fillRule="evenodd" listening={false}/>
    <Text x={radius*.75} y={radius*1.48+bob} width={radius*1.05} align="right" text={avatar} fontSize={7} fontFamily="IBM Plex Mono, monospace" fill={p.accent} listening={false}/>
    <Circle x={radius*1.9} y={bob+2} radius={4.5} fill={status} stroke={p.surface} strokeWidth={1.5}/>
    <Rect x={radius-42} y={radius*2+6} width={84} height={18} cornerRadius={5} fill={p.surface} opacity={.97}/>
    <Text x={radius-40} y={radius*2+11} width={80} text={firstName(employee)} align="center" fontSize={9} fontStyle="bold" fill={p.text} ellipsis/>
    <Text x={radius-40} y={radius*2+29} width={80} text={activity.replace('_',' ')} align="center" fontSize={8} fill={status}/>
  </Group>;
}

function phaseAt(coffeeBreak, now, reducedMotion = false) {
  if (!coffeeBreak) return null;
  const elapsed = Math.max(0, now - coffeeBreak.started);
  if (reducedMotion && elapsed < 3900) return { phase: 'drinking', position: coffeeBreak.station, activity: 'idle', pose: 'drinking' };
  const smooth = (value) => { const t = clamp(value, 0, 1); return t * t * (3 - 2 * t); };
  const between = (from, to, progress) => ({ x: from.x + (to.x - from.x) * smooth(progress), y: from.y + (to.y - from.y) * smooth(progress) });
  if (elapsed < 1000) return { phase: 'walking', position: between(coffeeBreak.from, coffeeBreak.station, elapsed / 1000), activity: 'walking', pose: 'carrying' };
  if (elapsed < 1700) return { phase: 'brewing', position: coffeeBreak.station, activity: 'idle', pose: 'brewing' };
  if (elapsed < 2900) return { phase: 'drinking', position: coffeeBreak.station, activity: 'idle', pose: 'drinking' };
  if (elapsed < 3900) return { phase: 'returning', position: between(coffeeBreak.station, coffeeBreak.from, (elapsed - 2900) / 1000), activity: 'walking', pose: 'carrying' };
  return { phase: 'complete' };
}

export const KonvaOfficeScene = forwardRef(function KonvaOfficeScene({
  office,
  manager,
  onActivate,
  onMoveEmployee,
  onError,
  onCoffeeBreakChange, onLayoutChange,
}, ref) {
  const host = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [layout, setLayout] = useState({});
  const [employeePositions, setEmployeePositions] = useState(() => new Map(office.employeePositions || []));
  const [hovered, setHovered] = useState(null);
  const [selected, setSelected] = useState(null);
  const [now, setNow] = useState(() => performance.now());
  const [coffeeBreak, setCoffeeBreak] = useState(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const employees = office.employees || [];
  const rooms = office.rooms || [];
  const desks = office.desks || [];

  useEffect(() => {
    const element = host.current;
    if (!element) return undefined;
    const resize = () => {
      const box = element.getBoundingClientRect();
      const next = { width: Math.max(1, Math.round(box.width)), height: Math.max(1, Math.round(box.height)) };
      setSize((old) => old.width === next.width && old.height === next.height ? old : next);
    };
    resize();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
    observer?.observe(element);
    if (!observer) window.addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      if (!observer) window.removeEventListener('resize', resize);
    };
  }, []);

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return undefined;
    setReducedMotion(query.matches);
    const update = (event) => setReducedMotion(event.matches);
    if (query.addEventListener) query.addEventListener('change', update);
    else query.addListener?.(update);
    return () => {
      if (query.removeEventListener) query.removeEventListener('change', update);
      else query.removeListener?.(update);
    };
  }, []);

  useEffect(() => {
    setEmployeePositions(new Map(office.employeePositions || []));
    setLayout({});
  }, [office.employeePositions, office.rooms, office.desks]);

  const meetingRoomBase = rooms.find((room) => roomKind(room) === 'meeting') || rooms[0] || { id: 'meeting', x: .53, y: .05, w: .43, h: .45 };
  const coffeeRoomBase = rooms.find((room) => roomKind(room) === 'cafe') || rooms.find((room) => roomKind(room) === 'quiet') || rooms[rooms.length - 1];
  const meetingRoom = { ...meetingRoomBase, ...positionFor(layout, 'room', meetingRoomBase) };
  const coffeeRoom = coffeeRoomBase ? { ...coffeeRoomBase, ...positionFor(layout, 'room', coffeeRoomBase) } : null;
  const coffeeStation = useMemo(() => {
    const bounds = size;
    const machineWidth = clamp(Math.min(bounds.width, bounds.height) * .13, 48, 65);
    const machineHeight = clamp(Math.min(bounds.width, bounds.height) * .15, 54, 68);
    return {
      x: coffeeRoom ? (coffeeRoom.x + coffeeRoom.w * .73) * bounds.width : bounds.width * .88,
      y: coffeeRoom ? (coffeeRoom.y + coffeeRoom.h * .53) * bounds.height : bounds.height * .76,
      width: machineWidth,
      height: machineHeight,
    };
  }, [size, coffeeRoom?.x, coffeeRoom?.y, coffeeRoom?.w, coffeeRoom?.h]);
  const coffeeFrame = phaseAt(coffeeBreak, now, reducedMotion);

  useEffect(() => {
    if (!coffeeBreak) return undefined;
    if (coffeeFrame?.phase === 'complete') {
      const timer = window.setTimeout(() => setCoffeeBreak(null), 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [coffeeBreak, coffeeFrame?.phase]);

  useEffect(() => {
    if (!coffeeBreak) return;
    onCoffeeBreakChange({ active: true, employeeName: coffeeBreak.employee.name || 'Crewmate', phase: coffeeFrame?.phase || 'walking' });
  }, [coffeeBreak, coffeeFrame?.phase, onCoffeeBreakChange]);

  useEffect(() => {
    if (coffeeBreak) return;
    onCoffeeBreakChange({ active: false, employeeName: '', phase: 'complete' });
  }, [coffeeBreak, onCoffeeBreakChange]);

  useEffect(() => {
    if (!coffeeBreak && (reducedMotion || !employees.some(employee=>getActivity(employee)==='walking'))) return undefined;
    let frame = 0;
    let visible = true;
    let lastDraw = 0;
    const tick = (timestamp) => {
      if (!visible || document.hidden) return;
      if (timestamp - lastDraw >= 40) {
        lastDraw = timestamp;
        setNow(timestamp);
      }
      frame = window.requestAnimationFrame(tick);
    };
    const visibility = () => {
      if (document.hidden) window.cancelAnimationFrame(frame);
      else frame = window.requestAnimationFrame(tick);
    };
    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (!visible) window.cancelAnimationFrame(frame);
      else frame = window.requestAnimationFrame(tick);
    }) : null;
    observer?.observe(host.current);
    document.addEventListener('visibilitychange', visibility);
    if (!document.hidden) frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [reducedMotion, coffeeBreak, employees]);

  const startCoffeeBreak = () => {
    if (coffeeBreak || !size.width || !employees.length) return false;
    const employee = employees.find((person) => !['meeting', 'paused', 'draft', 'probation', 'walking'].includes(getActivity(person)));
    if (!employee) return false;
    const from = employeePositions.get(employee.id) || office.employeePositions?.get(employee.id) || { x: Number(employee.x) || .1, y: Number(employee.y) || .1 };
    const radius = clamp(Math.min(size.width, size.height) * .043, 15, 20);
    const station = {
      x: (coffeeStation.x - coffeeStation.width * .78) / size.width - radius / size.width,
      y: (coffeeStation.y + coffeeStation.height * .36) / size.height - radius / size.height,
    };
    setCoffeeBreak({ employeeId: employee.id, employee, from, station, started: performance.now() });
    return true;
  };
  useImperativeHandle(ref, () => ({ startCoffeeBreak }), [coffeeBreak, size, employees, employeePositions, office.employeePositions, coffeeStation]);

  const activate = (hit) => {
    if (hit.type === 'employee') setSelected(hit.id);
    else setSelected(null);
    onActivate(hit);
  };
  const saveEmployeePosition = async (employee, x, y) => {
    const original = employeePositions.get(employee.id) || office.employeePositions?.get(employee.id);
    const next = { x: clamp(x, 0, 1), y: clamp(y, 0, 1) };
    setEmployeePositions((previous) => new Map(previous).set(employee.id, next));
    try { await onMoveEmployee(employee.id, next.x, next.y); }
    catch (error) {
      if (original) setEmployeePositions((previous) => new Map(previous).set(employee.id, original));
      onError(error);
    }
  };
  useEffect(()=>{onLayoutChange?.({rooms:rooms.map(room=>({...room,...positionFor(layout,'room',room)})),desks:desks.map(desk=>({...desk,...positionFor(layout,'desk',desk)}))});},[layout,rooms,desks,onLayoutChange]);
  const saveLayoutPosition = (type, item, x, y) => setLayout((previous) => ({
    ...previous,
    [type + ':' + item.id]: { ...positionFor(previous, type, item), x, y },
  }));
  const saveRoomSize = (room, w, h) => setLayout((previous) => ({
    ...previous,
    ['room:' + room.id]: { ...positionFor(previous, 'room', room), w, h },
  }));

  return <div ref={host} className="office-konva-stage" role="img" aria-label={'Office plan with ' + rooms.length + ' rooms, ' + desks.length + ' desks, and ' + employees.length + ' teammates.'} aria-describedby="office-directory-hint">
    {size.width > 1 && size.height > 1 && <Stage width={size.width} height={size.height}>
      <FloorPlan width={size.width} height={size.height}/>
      <Layer>
        {rooms.map((room, index) => <RoomShape
          key={room.id || 'room-' + index}
          room={room}
          index={index}
          position={positionFor(layout, 'room', room)}
          width={size.width}
          height={size.height}
          manager={manager}
          hovered={hovered === 'room:' + room.id}
          onHover={setHovered}
          onClick={activate}
          onDragEnd={(item, x, y) => saveLayoutPosition('room', item, x, y)}
          onResize={saveRoomSize}
        />)}
        {desks.map((desk) => {
          const employeeId = office.deskAssignments?.get(desk.id);
          const employee = employees.find((person) => person.id === employeeId);
          return <Desk
            key={desk.id}
            desk={desk}
            position={positionFor(layout, 'desk', desk)}
            width={size.width}
            height={size.height}
            manager={manager}
            hovered={hovered === 'desk:' + desk.id}
            onHover={setHovered}
            onClick={activate}
            onDragEnd={(item, x, y) => saveLayoutPosition('desk', item, x, y)}
            employee={employee}
          />;
        })}
        <MeetingTable room={meetingRoom} width={size.width} height={size.height}/>
        <CoffeeStation room={coffeeRoom} width={size.width} height={size.height} brewing={coffeeFrame?.phase === 'brewing'} onStart={startCoffeeBreak}/>
        {rooms.filter((room) => roomKind(room) === 'work').slice(0, 1).map((room) => <Group key={'plants-' + room.id} listening={false}>
          <Plant x={(room.x + room.w * .91) * size.width} y={(room.y + room.h * .82) * size.height} scale={.8}/>
          <Plant x={(room.x + room.w * .08) * size.width} y={(room.y + room.h * .84) * size.height} scale={.7}/>
        </Group>)}
        {employees.map((employee, index) => {
          const coffeePerson = coffeeBreak?.employeeId === employee.id ? coffeeFrame : null;
          const position = coffeePerson?.position || employeePositions.get(employee.id) || office.employeePositions?.get(employee.id) || { x: Number(employee.x) || (index % 5) * .13 + .2, y: Number(employee.y) || (index % 4) * .17 + .2 };
          const currentEmployee = coffeePerson ? { ...employee, activity: coffeePerson.activity } : employee;
          return <EmployeeToken
            key={employee.id}
            employee={currentEmployee}
            index={index}
            position={position}
            width={size.width}
            height={size.height}
            now={now}
            reducedMotion={reducedMotion}
            selected={selected === employee.id}
            manager={manager && !coffeePerson}
            onClick={activate}
            onDragEnd={saveEmployeePosition}
          />;
        })}
      </Layer>
    </Stage>}
  </div>;
});
