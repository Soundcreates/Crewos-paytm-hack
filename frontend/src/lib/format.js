export const pretty = (value) => String(value || '').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
export const initials = (value) => String(value || 'C').trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
export const stamp = (value) => value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
export const isManager = (session) => ['owner', 'admin', 'manager'].includes(session?.organization?.role);
export const isAdmin = (session) => ['owner', 'admin'].includes(session?.organization?.role);
export function formObject(form) { return Object.fromEntries(new FormData(form)); }
export function lines(value) { return String(value || '').split('\n').map((line) => line.trim()).filter(Boolean); }
export function jsonField(value, label, fallback) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { throw new Error(label + ' must contain valid JSON.'); }
}
export function capabilityRows(value) {
  return String(value || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [name, ...description] = line.split('|').map((part) => part.trim());
    return description.length ? { name, description: description.join(' | ') } : { name };
  });
}
export function capabilityText(value) {
  return (Array.isArray(value) ? value : []).map((item) => typeof item === 'string' ? item : [item?.name, item?.description].filter(Boolean).join(' | ')).join('\n');
}
