import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api.js';

const KonvaOfficeScene = lazy(() => import('./KonvaOfficeScene.jsx').then(({ KonvaOfficeScene: Scene }) => ({ default: Scene })));

export function LiveOffice({ office, manager, onEmployee, onError, notify, onEdit, onModel }) {
  const scene = useRef(null);
  const [coffeeBreak, setCoffeeBreak] = useState(null);
  const updateCoffeeBreak = useCallback((state) => setCoffeeBreak(state.active ? state : null), []);
  const officeModel = useMemo(() => {
    const rooms = office.rooms || [], desks = office.desks || [], employees = office.employees || [];
    const meetings = (office.meetings || []).filter((meeting) => ['briefing', 'in_meeting'].includes(meeting.status));
    const meetingRoom = rooms.find((room) => /meeting|review/i.test((room.id || '') + ' ' + (room.name || ''))) || rooms[0];
    const meetingPositions = new Map();
    for (const meeting of meetings) {
      const ids = meeting.participantIds || [];
      const seats = [[.31, .57], [.69, .57], [.31, .78], [.69, .78], [.16, .66], [.84, .66]];
      ids.forEach((id, index) => {
        if (meetingRoom && !meetingPositions.has(id)) {
          const [seatX, seatY] = seats[index % seats.length];
          meetingPositions.set(id, { x: meetingRoom.x + meetingRoom.w * seatX - .025, y: meetingRoom.y + meetingRoom.h * seatY - .04 });
        }
      });
    }
    const assigned = new Map();
    for (const desk of desks) { const person = employees.find((item) => ![...assigned.values()].includes(item.id) && Math.abs(Number(item.x) - desk.x) < .003 && Math.abs(Number(item.y) - desk.y) < .003); if (person) assigned.set(desk.id, person.id); }
    const employeePositions = new Map(employees.map((employee, index) => {
      const activity = employee.activity || (employee.state === 'active' ? 'idle' : employee.state);
      const desk = !['working', 'waiting', 'meeting'].includes(activity) ? desks.find((item) => assigned.get(item.id) === employee.id) : null;
      const position = activity === 'meeting' ? meetingPositions.get(employee.id) : null;
      return [employee.id, { x: Math.max(.02, Math.min(.9, position?.x ?? desk?.x ?? employee.x ?? ((index % 5) * .13 + .2))), y: Math.max(.02, Math.min(.8, position?.y ?? desk?.y ?? employee.y ?? ((index % 4) * .17 + .2))) }];
    }));
    return { ...office, rooms, desks, employees, employeePositions, deskAssignments: assigned };
  }, [office]);
  useEffect(() => {
    onModel(officeModel);
  }, [officeModel, onModel]);
  const onLayoutChange=useCallback(layout=>onModel({...officeModel,...layout}),[officeModel,onModel]);
  const employees = office.employees || [];
  const available = employees.some((person) => !['meeting', 'paused', 'draft', 'probation', 'walking'].includes(person.activity || person.state));
  const working = employees.filter((person) => ['working', 'active'].includes(person.activity || person.state)).length;
  const phases = { walking: 'Walking to the coffee machine', brewing: 'Making a fresh cup', drinking: 'Taking a coffee break', returning: 'Heading back to work' };
  function beginCoffeeBreak() {
    if (!scene.current?.startCoffeeBreak()) notify('No teammate is available for a coffee break right now.');
  }
  return <>
    <div id="office-map" className={'office-preview office-map ' + (manager ? 'editable' : '')}>
      <Suspense fallback={<div className="office-konva-loading" role="status">Loading office map…</div>}>
        <KonvaOfficeScene ref={scene} office={officeModel} manager={manager} onLayoutChange={onLayoutChange}
          onCoffeeBreakChange={updateCoffeeBreak}
          onActivate={(hit) => hit.type === 'employee' ? onEmployee(hit.id) : manager && onEdit(hit.type, hit.item)}
          onMoveEmployee={async (id, x, y) => {
            await api('/api/office/employees/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ x, y }) });
            const old = officeModel.employees.find((person) => person.id === id); if (old) Object.assign(old, { x, y });
            notify('Desk position saved.');
          }} onError={onError}/>
      </Suspense>
    </div>
    <p className="field-hint office-map-caption">Activity labels reflect workspace records. The Team view provides the same information as a list.</p>
  </>;
}
