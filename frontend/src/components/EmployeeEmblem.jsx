import {initials} from '../lib/format.js';

import {emblemIndex,emblemPaths} from '../lib/identity.js';

export function EmployeeEmblem({employee = {}, size = 'medium', className = ''}) {
  const key = employee.id || employee.name || 'CrewOS';
  const monogram = employee.avatar || employee.spec?.identity?.avatarId || initials(employee.name || 'CrewOS');
  return <span className={`employee-emblem emblem-${size} ${className}`} aria-hidden="true" data-pattern={emblemIndex(key)}>
    <svg viewBox="0 0 48 48" fill="currentColor"><path d={emblemPaths[emblemIndex(key)]} fillRule="evenodd"/></svg>
    <span>{String(monogram).slice(0, 3)}</span>
  </span>;
}
