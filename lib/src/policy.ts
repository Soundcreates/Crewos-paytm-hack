export type PolicyEffect = 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
export type PolicyDecision = PolicyEffect;

export interface ToolCatalogEntry {
  key: string;
  label: string;
  group: string;
  input: Record<string, unknown>;
  providerTool?: boolean;
  requiresProviderConnection?: boolean;
  simulationOnly?: boolean;
  requiredScopes?: string[];
}

export interface PolicyCondition {
  [key: string]: unknown;
}

export interface PolicyInput {
  name?: unknown;
  tool?: unknown;
  effect?: unknown;
  condition?: unknown;
}

export interface PolicyRule {
  id?: string;
  name: string;
  effect: string;
  condition: unknown;
}

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
  policyId?: string;
}

export class PolicyValidationError extends Error {}

export const TOOL_CATALOG: ToolCatalogEntry[] = [
  { key: 'tinyfish.search', label: 'Search the public web', group: 'TinyFish search', input: { query: 'market demand for an AI fitness tracker', purpose: 'Find current public evidence about market demand.' } },
  { key: 'solari.browser.open', label: 'Open a web page', group: 'Solari browser', input: { url: 'https://example.com' } },
  { key: 'solari.browser.interact', label: 'Interact with an already-open web page', group: 'Solari browser', input: { actions: [{ action: 'click', selector: 'button[type="submit"]' }, { action: 'assertText', text: 'Saved' }] } },
  { key: 'solari.sandbox.echo', label: 'Run a sandbox check', group: 'Solari sandbox', input: { message: 'hello' } },
  { key: 'solari.desktop.exec', label: 'Run a command in a desktop VM', group: 'Solari desktop', input: { environmentId: 'env_…', command: 'echo', args: ['hello'] } },
  { key: 'jira.create_issue', label: 'Create a work item', group: 'Work tools', input: { title: 'Investigate incident', description: '...' } },
  { key: 'jira.delete_issue', label: 'Delete a work item', group: 'Work tools', input: { issueId: '...' } },
  { key: 'payments.transfer', label: 'Transfer funds', group: 'Finance', input: { amount: 100, currency: 'USD', recipient: '...' } },
  { key: 'payments.refund', label: 'Issue a simulated customer refund', group: 'Finance', input: { amount: 1000, currency: 'USD', caseId: '...' } },
  { key: 'shopify.product.set', label: 'Set a Shopify simulation product', group: 'Shopify catalog', input: { connectionId: 'simulation-connection', idempotencyKey: 'draft-product-v1', products: [{ title: 'Fixture product', variants: [{ sku: 'FIXTURE-1', priceMinor: 1299, currency: 'USD', inventory: 1 }] }] }, providerTool: true, requiresProviderConnection: true, simulationOnly: true, requiredScopes: ['read_products','write_products'] },
  { key: 'account.delete', label: 'Delete an account', group: 'Admin', input: { accountId: '...' } },
];

interface ConditionRule {
  gt?: unknown;
  gte?: unknown;
  lt?: unknown;
  lte?: unknown;
  equals?: unknown;
  in?: unknown;
}

function conditionMatches(condition: unknown, args: Record<string, unknown>): boolean {
  if (!condition || Array.isArray(condition) || typeof condition !== 'object') return true;
  for (const [key, rawRule] of Object.entries(condition)) {
    const value = args?.[key];
    const rule = rawRule as ConditionRule | null | undefined;
    if (!key.trim() || !rule || Array.isArray(rule) || typeof rule !== 'object') return true;
    const operators = Object.keys(rule);
    if (!operators.length || operators.some((operator) => !['gt', 'gte', 'lt', 'lte', 'equals', 'in'].includes(operator))) return true;
    const numericRules = [rule.gt, rule.gte, rule.lt, rule.lte].filter((item) => item !== undefined);
    if (numericRules.some((item) => typeof item !== 'number' || !Number.isFinite(item)) || numericRules.length && (typeof value !== 'number' || !Number.isFinite(value))) return true;
    if (rule.gt !== undefined && !(Number(value) > Number(rule.gt))) return false;
    if (rule.gte !== undefined && !(Number(value) >= Number(rule.gte))) return false;
    if (rule.lt !== undefined && !(Number(value) < Number(rule.lt))) return false;
    if (rule.lte !== undefined && !(Number(value) <= Number(rule.lte))) return false;
    if (rule.equals !== undefined && rule.equals !== null && !['string', 'number', 'boolean'].includes(typeof rule.equals)) return true;
    if (rule.equals !== undefined && value !== rule.equals) return false;
    if (rule.in !== undefined) {
      if (!Array.isArray(rule.in) || !rule.in.length || rule.in.length > 50 || rule.in.some((item) => item !== null && !['string', 'boolean'].includes(typeof item) && !(typeof item === 'number' && Number.isFinite(item)))) return true;
      if (!rule.in.includes(value)) return false;
    }
  }
  return true;
}

export function validatePolicyCondition(condition: unknown): asserts condition is Record<string, ConditionRule> {
  if (!condition || Array.isArray(condition) || typeof condition !== 'object') throw new PolicyValidationError('Condition must be an object.');
  const entries = Object.entries(condition);
  if (entries.length > 40) throw new PolicyValidationError('Condition has too many fields.');
  for (const [field, value] of entries) {
    if (!field.trim() || !value || Array.isArray(value) || typeof value !== 'object') throw new PolicyValidationError('Each condition field must have a comparison object.');
    const rule = value as Record<string, unknown>;
    const operators = Object.keys(rule);
    if (!operators.length || operators.some((operator) => !['gt', 'gte', 'lt', 'lte', 'equals', 'in'].includes(operator))) throw new PolicyValidationError('Conditions support gt, gte, lt, lte, equals, and in comparisons.');
    for (const operator of ['gt', 'gte', 'lt', 'lte']) {
      if (operator in rule && (typeof rule[operator] !== 'number' || !Number.isFinite(rule[operator]))) throw new PolicyValidationError(`${operator} thresholds must be finite numbers.`);
    }
    if ('equals' in rule && rule.equals !== null && !['string', 'number', 'boolean'].includes(typeof rule.equals)) throw new PolicyValidationError('equals comparisons need a text, number, boolean, or null value.');
    if (typeof rule.equals === 'number' && !Number.isFinite(rule.equals)) throw new PolicyValidationError('equals comparisons need a finite number.');
    if ('in' in rule && (!Array.isArray(rule.in) || !rule.in.length || rule.in.length > 50 || rule.in.some((item) => item !== null && !['string', 'boolean'].includes(typeof item) && !(typeof item === 'number' && Number.isFinite(item))))) throw new PolicyValidationError('in comparisons need 1 to 50 scalar values.');
  }
}

export function evaluatePolicy(
  spec: { tools?: unknown } | null | undefined,
  tool: string,
  args: Record<string, unknown> = {},
  rules: readonly PolicyRule[] = [],
): PolicyResult {
  if (tool === 'account.delete') return { decision: 'DENY', reason: 'Account deletion is disabled at the gateway.' };
  const grants: unknown[] = Array.isArray(spec?.tools) ? spec.tools : [];
  if (!grants.includes(tool)) return { decision: 'DENY', reason: `This employee has no grant for ${tool}.` };
  const matched = rules.filter((row) => {
    let condition: unknown = row.condition;
    try { if (typeof condition === 'string') condition = JSON.parse(condition) as unknown; }
    catch { return true; }
    return conditionMatches(condition, args);
  });
  const deny = matched.find((row) => row.effect === 'DENY');
  if (deny) return { decision: 'DENY', reason: deny.name, ...(deny.id ? { policyId: deny.id } : {}) };
  const approval = matched.find((row) => row.effect === 'REQUIRE_APPROVAL');
  if (approval) return { decision: 'REQUIRE_APPROVAL', reason: approval.name, ...(approval.id ? { policyId: approval.id } : {}) };
  const allow = matched.find((row) => row.effect === 'ALLOW');
  if (allow) return { decision: 'ALLOW', reason: allow.name, ...(allow.id ? { policyId: allow.id } : {}) };
  return { decision: 'ALLOW', reason: 'Granted by the employee spec and no active policy blocks this action.' };
}
