import { repositories } from '../../src/repositories/index.mjs';
import { evaluatePolicy, PolicyValidationError, TOOL_CATALOG, validatePolicyCondition } from 'solari-crew-core';
import type { PolicyCondition, PolicyEffect, PolicyInput, PolicyRule, ToolCatalogEntry } from 'solari-crew-core';
import { id, now } from '../../lib/db.mjs';

interface PolicyRow extends PolicyRule {
  id: string;
  org_id: string;
  created_at: string;
  active?: number;
}

export { PolicyValidationError };

export async function seedPolicies(orgId: string): Promise<void> {
  const existing = (await repositories.policies.findOnePolicyByOrgId(orgId))?.count ?? 0;
  if (existing) return;
  const defaults: Array<[string, string, PolicyEffect, PolicyCondition]> = [
    ['Never delete an account', 'account.delete', 'DENY', {}],
    ['Approve transfers over $500', 'payments.transfer', 'REQUIRE_APPROVAL', { amount: { gt: 500 } }],
    ['Escalate refunds over $500', 'payments.refund', 'REQUIRE_APPROVAL', { amount: { gt: 500 } }],
  ];
  for (const [name, tool, effect, condition] of defaults) {
    await repositories.policies.insertPolicy(id('pol'), orgId, name, tool, effect, JSON.stringify(condition), now());
  }
}

export async function checkPolicy(
  orgId: string,
  spec: { tools?: unknown } | null | undefined,
  tool: string,
  args: Record<string, unknown> = {},
) {
  const rules = await repositories.policies.findManyPolicyByOrgIdAndActiveAndTool(orgId, tool);
  return evaluatePolicy(spec, tool, args, rules);
}

export async function savePolicy(
  orgId: string,
  input: PolicyInput,
  catalog: readonly Pick<ToolCatalogEntry, 'key'>[] = TOOL_CATALOG,
): Promise<PolicyRow | undefined> {
  const tool = String(input.tool ?? '');
  const effect = String(input.effect ?? '');
  const name = String(input.name ?? '').trim();
  const validRule = catalog.some((entry) => entry.key === tool);
  if (!validRule || !name || !['ALLOW', 'REQUIRE_APPROVAL', 'DENY'].includes(effect)) throw new PolicyValidationError('Choose a catalog tool, a rule name, and ALLOW, REQUIRE_APPROVAL, or DENY.');
  const condition = input.condition === undefined ? {} : input.condition;
  validatePolicyCondition(condition);
  if (JSON.stringify(condition).length > 2000) throw new PolicyValidationError('Condition is too large.');
  const policyId = id('pol');
  await repositories.policies.insertPolicy(policyId, orgId, name, tool, effect, JSON.stringify(condition), now());
  return repositories.policies.findOnePolicyById(policyId);
}
