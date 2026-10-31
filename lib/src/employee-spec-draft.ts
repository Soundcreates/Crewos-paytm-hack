import type { EmployeeProvenance } from './employee-spec.js';

type DraftSpec = {
  mission: string;
  responsibilities: string[];
  successMetrics: { name: string; target: number }[];
  capabilities: { name: string; description: string }[];
  evaluationPolicy: string;
};

type DraftSource = { name: string; text: string; sourceId?: string };

const capabilityActions = new Map([
  ['own', 'Ownership'], ['review', 'Review'], ['escalate', 'Escalation'], ['create', 'Creation'],
  ['coordinate', 'Coordination'], ['manage', 'Management'], ['maintain', 'Maintenance'], ['monitor', 'Monitoring'],
  ['resolve', 'Resolution'], ['track', 'Tracking'], ['triage', 'Triage'], ['analyze', 'Analysis'],
  ['investigate', 'Investigation'],
]);
const numberWords = new Map([
  ['a', 1], ['an', 1], ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
  ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10], ['twelve', 12],
]);

function capabilityFromResponsibility(responsibility: string) {
  const match = responsibility.match(/^([a-z]+)\s+(.+)$/i);
  const action = match && capabilityActions.get(match[1].toLowerCase());
  if (!match || !action) return null;
  const object = match[2].split(/\b(?:from|through|within|over|under|for|to|by|with|using|via|across|before|after|and)\b/i)[0]
    .replace(/[.!?;:,]+$/, '').trim();
  if (object.length < 3 || object.length > 80) return null;
  return { name: `${action}: ${object}`, description: responsibility };
}

function numberValue(value: string) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : numberWords.get(value.toLowerCase());
}

function metricsFromLine(line: string) {
  const metrics: { name: string; target: number }[] = [];
  const time = line.match(/\bwithin\s+(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+((?:business\s+)?(?:hours?|days?|weeks?|months?))\b/i);
  if (time) {
    const target = numberValue(time[1]);
    const unit = time[2].toLowerCase().replace(/^business\s+/, '').replace(/s$/, '');
    const maximum = { hour: 24 * 365, day: 365, week: 52, month: 12 }[unit];
    if (target && target > 0 && maximum !== undefined && target <= maximum) metrics.push({ name: line.replace(/[.!?]+$/, ''), target });
  }

  const percentage = line.match(/\b(\d+(?:\.\d+)?)\s*(?:%|percent\b)/i);
  if (percentage && /\b(?:accuracy|quality|satisfaction|rate|compliance|success|resolution|uptime|availability|sla|cases|requests|tickets)\b/i.test(line)) {
    const target = Number(percentage[1]);
    if (target > 0 && target <= 100) metrics.push({ name: line.replace(/[.!?]+$/, ''), target });
  }
  return metrics;
}

export function compileFallback(source: string, jobTitle: string, department: string) {
  const lines = source.split(/\n+/)
    .map((line) => line.replace(/^\s*[-*•\d.)]+\s*/, '').trim())
    .filter((line) => !/^\[Source:.*\]$/i.test(line) && normalizedEvidence(line) !== normalizedEvidence(jobTitle) && line.length > 20 && line.length < 260);
  const responsibilities = [...new Set(lines)].slice(0, 8);
  const capabilities = responsibilities.flatMap((item) => {
    const capability = capabilityFromResponsibility(item);
    return capability ? [capability] : [];
  }).filter((item, index, all) => all.findIndex((candidate) => normalizedEvidence(candidate.name) === normalizedEvidence(item.name)) === index).slice(0, 8);
  const successMetrics = [...new Map(lines.flatMap(metricsFromLine).map((metric) => [`${normalizedEvidence(metric.name)}:${metric.target}`, metric])).values()].slice(0, 20);
  return {
    mission: `Deliver reliable ${jobTitle.toLowerCase()} work for ${department}.`,
    responsibilities,
    capabilities,
    successMetrics,
    tools: [],
    policies: [],
    coworkers: [],
    evaluationPolicy: 'Pass the assigned probation simulations at the configured threshold.',
  };
}

export function normalizedEvidence(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const provenanceStopwords = new Set(['about', 'after', 'against', 'also', 'and', 'are', 'before', 'being', 'by', 'for', 'from', 'has', 'have', 'into', 'its', 'not', 'of', 'on', 'or', 'over', 'the', 'their', 'through', 'to', 'under', 'using', 'via', 'was', 'were', 'when', 'where', 'with', 'within']);

function evidenceTokens(value: unknown) {
  return new Set((normalizedEvidence(value).match(/[a-z0-9]+/g) || []).filter((token) => token.length > 2 && !provenanceStopwords.has(token)));
}

export function provenanceSupportsField(value: unknown, evidence: unknown): boolean {
  const quote = normalizedEvidence(evidence);
  const quoteTokens = evidenceTokens(evidence);
  if (quoteTokens.size < 2) return false;
  const candidates = (Array.isArray(value) ? value : [value]).map((item) => item && typeof item === 'object'
    ? Object.values(item).filter((part) => part == null || ['string', 'number', 'boolean'].includes(typeof part)).join(' ')
    : String(item ?? ''));
  return candidates.some((candidate) => {
    const text = normalizedEvidence(candidate);
    if (!text) return false;
    if (text.includes(quote) || quote.includes(text)) return true;
    const fieldTokens = evidenceTokens(candidate);
    const shared = [...fieldTokens].filter((token) => quoteTokens.has(token)).length;
    return shared >= 2 && shared / fieldTokens.size >= 0.5;
  });
}

export function provenanceForDraft(spec: DraftSpec, sources: DraftSource[], proposed: unknown = []): EmployeeProvenance[] {
  const fields: (keyof DraftSpec)[] = ['mission', 'responsibilities', 'successMetrics', 'capabilities', 'evaluationPolicy'];
  const provenance: EmployeeProvenance[] = [];
  for (const value of (Array.isArray(proposed) ? proposed : []).slice(0, 50)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const citation = value as Record<string, unknown>;
    const fieldName = String(citation.field || '');
    if (!fields.includes(fieldName as keyof DraftSpec)) continue;
    const field = fieldName as keyof DraftSpec;
    const source = citation.sourceId ? sources.find((item) => item.sourceId === citation.sourceId) : sources.find((item) => item.name === citation.source);
    const evidence = String(citation.evidence || '').trim().slice(0, 500);
    if (!source || evidence.length < 8 || !normalizedEvidence(source.text).includes(normalizedEvidence(evidence)) || !provenanceSupportsField(spec[field], evidence)) continue;
    if (provenance.some((item) => item.field === field)) continue;
    provenance.push({ field, source: source.name, ...(source.sourceId ? { sourceId: source.sourceId } : {}), evidence, confidence: 0.85 });
  }
  for (const field of fields) {
    const value = spec[field];
    if (value == null || value === '' || Array.isArray(value) && !value.length || provenance.some((item) => item.field === field)) continue;
    const values = (Array.isArray(value) ? value : [value])
      .flatMap((item) => item && typeof item === 'object' ? Object.values(item) : [item])
      .map(String);
    const exact = sources.flatMap((source) => values.map((text) => ({ source, text })))
      .find(({ source, text }) => text.length >= 8 && text.length <= 500 && normalizedEvidence(source.text).includes(normalizedEvidence(text)));
    provenance.push(exact
      ? { field, source: exact.source.name, evidence: exact.text, confidence: 0.95 }
      : { field, source: 'Unattributed draft inference', confidence: 0.25 });
  }
  return [
    ...['identity.name', 'identity.title', 'identity.departmentId', 'identity.managerId', 'identity.avatarId', 'profileId', 'tools', 'policies', 'coworkers'].map((field) => ({ field, source: 'Manager input', confidence: 1 })),
    ...provenance,
  ];
}
