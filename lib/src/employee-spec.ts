export interface EmployeeIdentity {
  name: string;
  title: string;
  departmentId: string;
  managerId: string;
  avatarId: string;
}

export interface EmployeeSuccessMetric {
  name: string;
  target: number;
}

export interface EmployeeCapability {
  name: string;
  description: string;
}

export interface EmployeeProvenance {
  source: string;
  confidence: number;
  sourceId?: string;
  field?: string;
  evidence?: string;
}

/** Versioned EmployeeSpec contract from the research report, plus existing persisted profile metadata. */
export interface EmployeeSpec {
  id: string;
  version: number;
  profileId: string | null;
  identity: EmployeeIdentity;
  mission: string;
  responsibilities: string[];
  successMetrics: EmployeeSuccessMetric[];
  capabilities: EmployeeCapability[];
  tools: string[];
  policies: string[];
  coworkers: string[];
  evaluationPolicy: string;
  provenance: EmployeeProvenance[];
}

/** Normalized values from the JS boundary; the builder owns the persisted object shape. */
export type EmployeeSpecBuilderInput = Omit<EmployeeSpec, 'identity'> & Pick<EmployeeIdentity,
  'name' | 'title' | 'departmentId' | 'managerId' | 'avatarId'>;

/** Converts current editor lines and legacy string arrays to the report's object shape. */
export function parseEmployeeCapabilities(value: unknown): EmployeeCapability[] {
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\n+/) : [];
  const result: EmployeeCapability[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    let capability: EmployeeCapability;
    if (typeof entry === 'string') {
      const text = entry.trim();
      const separator = text.indexOf('|');
      capability = separator < 0
        ? { name: text, description: '' }
        : { name: text.slice(0, separator).trim(), description: text.slice(separator + 1).trim() };
    } else if (entry && typeof entry === 'object') {
      const value = entry as Record<string, unknown>;
      capability = { name: String(value.name ?? '').trim(), description: String(value.description ?? '').trim() };
    } else {
      capability = { name: String(entry ?? '').trim(), description: '' };
    }

    if (!capability.name) continue;
    const key = `${capability.name}\0${capability.description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(capability);
    if (result.length === 30) break;
  }

  return result;
}

/** Builds a detached, typed EmployeeSpec from server-validated values. */
export function buildEmployeeSpec(input: EmployeeSpecBuilderInput): EmployeeSpec {
  return {
    id: input.id,
    version: input.version,
    profileId: input.profileId,
    identity: {
      name: input.name,
      title: input.title,
      departmentId: input.departmentId,
      managerId: input.managerId,
      avatarId: input.avatarId,
    },
    mission: input.mission,
    responsibilities: [...input.responsibilities],
    successMetrics: input.successMetrics.map((metric) => ({ ...metric })),
    capabilities: input.capabilities.map((capability) => ({ ...capability })),
    tools: [...input.tools],
    policies: [...input.policies],
    coworkers: [...input.coworkers],
    evaluationPolicy: input.evaluationPolicy,
    provenance: input.provenance.map((source) => ({ ...source })),
  };
}
