export function safeTaskTraceValue(value, depth = 0, limits = {}) {
  const maxArrayItems = limits.maxArrayItems ?? 40;
  const maxStringLength = limits.maxStringLength ?? 4000;
  if (depth > 8) return '[depth limit]';
  if (Array.isArray(value)) return value.slice(0, maxArrayItems).map((item) => safeTaskTraceValue(item, depth + 1, limits));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, /authorization|cookie|password|secret|token|api[_-]?key/i.test(key) ? '[redacted]' : safeTaskTraceValue(item, depth + 1, limits)]));
  if (typeof value === 'string' && value.length > maxStringLength) return `${value.slice(0, maxStringLength)}…`;
  return value;
}
