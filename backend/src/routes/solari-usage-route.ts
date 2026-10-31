interface EnvironmentRow {
  provider_id: unknown;
  created_at: unknown;
}

interface ToolRunRow {
  output: unknown;
  created_at: unknown;
}

interface SimulationRunRow {
  evidence: unknown;
  created_at: unknown;
}

function parsedJson(value: unknown, fallback: unknown): unknown {
  try { return JSON.parse(String(value)) as unknown; }
  catch { return fallback; }
}

function property(value: unknown, name: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

export function collectSolariUsageSessionIds(
  environments: EnvironmentRow[],
  toolRuns: ToolRunRow[],
  simulationRuns: SimulationRunRow[],
): string[] {
  const sessions = new Map<string, string>();
  const remember = (sessionId: unknown, createdAt: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 2048) return;
    const timestamp = String(createdAt || '');
    const current = sessions.get(sessionId);
    if (current === undefined || timestamp > current) sessions.set(sessionId, timestamp);
  };

  for (const row of environments) remember(row.provider_id, row.created_at);
  for (const row of toolRuns) remember(property(parsedJson(row.output, {}), 'sessionId'), row.created_at);
  for (const row of simulationRuns) {
    const evidence = parsedJson(row.evidence, []);
    if (Array.isArray(evidence)) for (const item of evidence) remember(property(item, 'replaySessionId'), row.created_at);
  }

  return [...sessions]
    .sort((left, right) => right[1].localeCompare(left[1]))
    .map(([sessionId]) => sessionId);
}
