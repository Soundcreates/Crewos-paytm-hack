export function chunks(text: string, max = 1400): string[] {
  const paragraphs = String(text).replace(/\r/g, '').split(/\n\s*\n/).map((value) => value.trim()).filter(Boolean);
  const result: string[] = [];
  let part = '';
  for (const paragraph of paragraphs) {
    if (paragraph.length > max) {
      if (part) result.push(part), part = '';
      for (let i = 0; i < paragraph.length; i += max) result.push(paragraph.slice(i, i + max));
    } else if ((part.length + paragraph.length + 2) > max) {
      result.push(part); part = paragraph;
    } else part += `${part ? '\n\n' : ''}${paragraph}`;
  }
  if (part) result.push(part);
  return result;
}

export function memoryAuthorityBoost(row: { source?: unknown; kind?: unknown }): number {
  const source = String(row.source || '').toLowerCase();
  const kind = String(row.kind || '').toLowerCase();
  if (kind === 'policy' || source.startsWith('policy:')) return 0.1;
  if (source.startsWith('document:')) return 0.06;
  if (kind === 'procedural') return 0.04;
  return 0;
}

export function memoryRelevance(row: { source?: unknown; kind?: unknown }, semantic: number, lexical: number, hasVector = true): number {
  return (hasVector ? semantic * 0.85 + lexical * 0.15 : lexical) + memoryAuthorityBoost(row);
}
