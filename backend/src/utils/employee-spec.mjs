import { normalizedEvidence, TOOL_CATALOG } from 'solari-crew-core';

export const SPEC_SOURCE_BUDGET = 30_000;

export function specFieldValue(spec, field) {
  const [first, second] = field.split('.');
  return second ? spec?.[first]?.[second] : spec?.[first];
}

export function fallbackToolSuggestions(sources, catalog = TOOL_CATALOG) {
  const hints = new Map([
    ['tinyfish.search', /\b(?:research|search|market demand|market analysis|competitor analysis|industry trends|landscape analysis)\b/i],
    ['solari.browser.open', /\b(?:browse|browser|web|website|internet)\w*\b/i],
    ['solari.browser.interact', /\b(?:click|fill|submit|interact|form)\w*\b/i],
    ['solari.sandbox.echo', /\b(?:sandbox|echo|smoke test)\b/i],
    ['solari.desktop.exec', /\b(?:desktop|legacy application|virtual machine|terminal command)\b/i],
    ['jira.create_issue', /\b(?:jira|ticket|issue|work item)\b/i],
    ['jira.delete_issue', /\b(?:delete|remove|close)\b.{0,60}\b(?:ticket|issue|work item)\b/i],
    ['payments.transfer', /\b(?:transfer|payout|payment)\w*\b/i],
    ['payments.refund', /\brefund\w*\b/i],
  ]);
  const suggestions = [];

  for (const tool of catalog) {
    const pattern = hints.get(tool.key);
    const phrase = tool.mcpTool?.toolName.replace(/[._-]+/g, ' ').toLowerCase();
    if (!pattern && !phrase) continue;

    for (const source of sources) {
      const text = String(source.text || '');
      const index = pattern?.exec(text)?.index ?? (phrase ? normalizedEvidence(text).indexOf(phrase) : -1);
      if (index < 0) continue;

      const start = Math.max(0, index - 120);
      suggestions.push({
        tool: tool.key,
        rationale: `The source mentions work related to ${tool.label.toLowerCase()}.`,
        source: source.name,
        evidence: text.slice(start, start + 360).trim(),
      });
      break;
    }

    if (suggestions.length >= 5) break;
  }

  return suggestions;
}

export function selectSpecSourceExcerpts(sources, budget = SPEC_SOURCE_BUDGET) {
  const fixedLength = sources.reduce((length, source) => length + `[Source: ${source.name}]\n`.length, 0)
    + Math.max(0, sources.length - 1) * 2;
  let remaining = Math.max(0, budget - fixedLength);
  const lengths = sources.map(() => 0);
  let active = sources.map((_, index) => index)
    .filter((index) => String(sources[index].text || '').length);

  while (remaining && active.length) {
    const share = Math.max(1, Math.floor(remaining / active.length));
    const next = [];
    for (const index of active) {
      const text = String(sources[index].text || '');
      const take = Math.min(text.length - lengths[index], share, remaining);
      lengths[index] += take;
      remaining -= take;
      if (lengths[index] < text.length) next.push(index);
    }
    active = next;
  }

  return sources.map((source, index) => ({
    ...source,
    text: String(source.text || '').slice(0, lengths[index]),
  }));
}

export function validateToolSuggestions(proposed, sources, catalog = TOOL_CATALOG) {
  const suggestions = [];
  const seen = new Set();

  for (const item of (Array.isArray(proposed) ? proposed : []).slice(0, 20)) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.tool !== 'string') continue;
    const tool = catalog.find((entry) => entry.key === item.tool);
    const rationale = typeof item.rationale === 'string' ? item.rationale.trim().slice(0, 400) : '';
    const source = typeof item.source === 'string' ? sources.find((entry) => entry.name === item.source) : null;
    const evidence = typeof item.evidence === 'string' ? item.evidence.trim().slice(0, 500) : '';
    if (!tool || seen.has(tool.key) || !rationale || !source || evidence.length < 8) continue;
    if (!normalizedEvidence(source.text).includes(normalizedEvidence(evidence))) continue;

    seen.add(tool.key);
    suggestions.push({ tool: tool.key, label: tool.label, rationale, source: source.name, evidence });
    if (suggestions.length >= 5) break;
  }

  return suggestions;
}
