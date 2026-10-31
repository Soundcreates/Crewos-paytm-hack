export function memoryContextSlice(memories, budget = 6000) {
  let remaining = budget;
  const context = [];

  for (const memory of memories) {
    const base = {
      kind: memory.kind,
      title: memory.title,
      source: memory.source,
      confidence: memory.confidence,
      body: '',
    };
    const body = String(memory.body || '').slice(0, Math.max(0, remaining - JSON.stringify(base).length));
    if (!body) break;

    const entry = { ...base, body };
    const size = JSON.stringify(entry).length + 1;
    if (size > remaining) break;
    context.push(entry);
    remaining -= size;
  }

  return context;
}

export function isReadOnlyResearchTask(goal) {
  const text = String(goal || '');
  const researchIntent = /\b(?:research|search|find|look up|market demand|market analysis|competitor analysis|industry trends|landscape analysis)\b/i.test(text);
  const actionIntent = /\b(?:open|navigate|click|fill|create|submit|send|publish|purchase|buy|book|schedule|update|edit|delete|remove|refund|transfer|post|comment|message|log in|sign in|save|file|raise)\b/i.test(text);
  return researchIntent && !actionIntent;
}

export function normalizePublicResearchUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (['example.com', 'example.org', 'example.net', 'localhost'].includes(url.hostname.toLowerCase())) return null;
    if (url.hostname.endsWith('.invalid')) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}
