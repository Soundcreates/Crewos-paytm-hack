/** Pure, dependency-free contracts for CrewOS organization work. */
export type Environment = 'simulation' | 'staging' | 'production';
export type TaskState = 'queued' | 'planning' | 'running' | 'retry' | 'waiting_dependency' | 'waiting_approval' | 'waiting_external' | 'reconciling' | 'verifying' | 'completed' | 'failed' | 'cancelled';

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const integer = (v: unknown): v is number => Number.isSafeInteger(v);
const currencies = new Set(['USD','EUR','GBP','INR','CAD','AUD','JPY','SGD','NZD','CHF']);

export interface BusinessProfile { orgId: string; version: number; business: Record<string, unknown>; brand: Record<string, unknown>; products: Array<Record<string, unknown>>; policy: Record<string, unknown>; integrationsRequested: string[]; missingFields: string[]; evidenceRefs: string[] }
export interface TaskContract { id: string; orgId: string; goal: string; capability: string; state: TaskState; inputRefs: string[]; idempotencyKey: string; ownerEmployeeId?: string }
export interface EventEnvelope { id: string; orgId: string; connectionId: string; provider: string; eventType: string; externalEventId: string; environment: Environment; simulated: boolean; occurredAt?: string; payload: Record<string, unknown> }
export interface ProviderContext { orgId: string; connectionId: string; provider: string; providerAccountId: string; environment: Environment; scopes: string[] }
export interface ActionRequest { orgId: string; taskId: string; workflowId: string; toolRunId: string; connectionId: string; environment: Environment; action: string; idempotencyKey: string; input: Record<string, unknown> }
export interface EmployeeCard { employeeId: string; orgId: string; role: string; capabilities: string[]; status: 'draft' | 'probation' | 'active' | 'paused' }
export interface RoleContract { key: string; title: string; description: string; capabilities: string[] }
export interface CapabilityContract { key: string; description: string; requiredTools: string[]; risk: 'low' | 'medium' | 'high' | 'critical' }
export interface PolicyContract { id: string; orgId: string; capability: string; effect: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY'; revision: string; condition: Record<string, unknown> }
export interface ProfileClaim { fieldPath: string; value: unknown; sourceTurnId: string; confirmed: boolean; requestHash: string }

export function validateBusinessProfile(v: unknown): v is BusinessProfile {
  if (!record(v) || !nonEmpty(v.orgId) || !integer(v.version) || v.version < 1 || !record(v.business) || !record(v.brand) || !Array.isArray(v.products) || !record(v.policy) || !Array.isArray(v.integrationsRequested) || !Array.isArray(v.missingFields) || !Array.isArray(v.evidenceRefs)) return false;
  const skus = new Set<string>();
  for (const product of v.products) {
    if (!record(product) || !nonEmpty(product.localId) || !nonEmpty(product.title) || !Array.isArray(product.variants)) return false;
    for (const variant of product.variants) {
      if (!record(variant) || !integer(variant.priceMinor) || variant.priceMinor < 0 || typeof variant.currency !== 'string' || !currencies.has(variant.currency)) return false;
      if (variant.sku != null) { if (!nonEmpty(variant.sku) || skus.has(variant.sku)) return false; skus.add(variant.sku); }
      if (variant.inventory != null && (!integer(variant.inventory) || variant.inventory < 0)) return false;
    }
  }
  return true;
}

export function validateTaskContract(v: unknown): v is TaskContract {
  return record(v) && nonEmpty(v.id) && nonEmpty(v.orgId) && nonEmpty(v.goal) && nonEmpty(v.capability) && nonEmpty(v.idempotencyKey) && Array.isArray(v.inputRefs) && v.inputRefs.every(nonEmpty) && ['queued','planning','running','retry','waiting_dependency','waiting_approval','waiting_external','reconciling','verifying','completed','failed','cancelled'].includes(String(v.state));
}
export function validateEventEnvelope(v: unknown): v is EventEnvelope {
  return record(v) && ['id','orgId','connectionId','provider','eventType','externalEventId'].every(k => nonEmpty(v[k])) && ['simulation','staging','production'].includes(String(v.environment)) && typeof v.simulated === 'boolean' && record(v.payload);
}
export function validateActionRequest(v: unknown): v is ActionRequest {
  return record(v) && ['orgId','taskId','workflowId','toolRunId','connectionId','action','idempotencyKey'].every(k => nonEmpty(v[k])) && ['simulation','staging','production'].includes(String(v.environment)) && record(v.input);
}
export function validateProviderContext(v: unknown): v is ProviderContext {
  return record(v) && ['orgId','connectionId','provider','providerAccountId'].every(k => nonEmpty(v[k])) && ['simulation','staging','production'].includes(String(v.environment)) && Array.isArray(v.scopes) && v.scopes.every(nonEmpty);
}
export function validateEmployeeCard(v: unknown): v is EmployeeCard {
  return record(v) && ['employeeId','orgId','role'].every(k => nonEmpty(v[k])) && Array.isArray(v.capabilities) && v.capabilities.every(nonEmpty) && ['draft','probation','active','paused'].includes(String(v.status));
}
export function validateRoleContract(v: unknown): v is RoleContract {
  return record(v) && ['key','title','description'].every(k => nonEmpty(v[k])) && Array.isArray(v.capabilities) && v.capabilities.length > 0 && v.capabilities.every(nonEmpty);
}
export function validateCapabilityContract(v: unknown): v is CapabilityContract {
  return record(v) && nonEmpty(v.key) && nonEmpty(v.description) && Array.isArray(v.requiredTools) && v.requiredTools.every(nonEmpty) && ['low','medium','high','critical'].includes(String(v.risk));
}
export function validatePolicyContract(v: unknown): v is PolicyContract {
  return record(v) && ['id','orgId','capability','revision'].every(k => nonEmpty(v[k])) && ['ALLOW','REQUIRE_APPROVAL','DENY'].includes(String(v.effect)) && record(v.condition);
}
export function canTransitionTask(from: TaskState, to: TaskState): boolean {
  const allowed: Record<TaskState, TaskState[]> = { queued:['planning','failed','cancelled'], planning:['running','failed','cancelled'], running:['retry','waiting_dependency','waiting_approval','waiting_external','reconciling','verifying','failed','cancelled'], retry:['running','failed','cancelled'], waiting_dependency:['queued','failed','cancelled'], waiting_approval:['queued','failed','cancelled'], waiting_external:['queued','reconciling','failed','cancelled'], reconciling:['queued','waiting_external','failed','cancelled'], verifying:['completed','failed'], completed:[], failed:[], cancelled:[] };
  return allowed[from].includes(to);
}
