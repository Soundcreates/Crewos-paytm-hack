import { repositories } from '../../src/repositories/index.mjs';
import type { PolicyCondition, PolicyInput, ToolCatalogEntry } from 'solari-crew-core';
import { savePolicy } from '../services/policy.js';

interface PolicyRow {
  id: string;
  org_id: string;
  name: string;
  tool: string;
  effect: string;
  condition: string;
  active: boolean | number;
  created_at: string;
}

function conditionJson(value: unknown): PolicyCondition {
  if (typeof value !== 'string') return value && typeof value === 'object' ? value as PolicyCondition : {};
  try { return JSON.parse(value) as PolicyCondition; }
  catch { return {}; }
}

export async function listOrganizationPolicies(orgId: string, listTools: (orgId: string) => Promise<unknown>) {
  const policies = (await repositories.policies.findManyPolicyByOrgId(orgId) as PolicyRow[])
    .map((row) => ({ ...row, condition: conditionJson(row.condition), active: Boolean(row.active) }));
  return { policies, tools: await listTools(orgId) };
}

export async function createOrganizationPolicy(
  orgId: string,
  input: PolicyInput,
  tools: readonly Pick<ToolCatalogEntry, 'key'>[],
) {
  const policy = await savePolicy(orgId, input, tools);
  return policy ? { ...policy, condition: conditionJson(policy.condition) } : undefined;
}

export async function updateOrganizationPolicy(orgId: string, policyId: string, active: unknown) {
  const policy = await repositories.policies.findOnePolicyByOrgIdAndId(orgId, policyId);
  if (!policy) return undefined;
  const isActive = Boolean(active);
  await repositories.policies.updatePolicyByIdAndOrgId(isActive ? 1 : 0, policy.id, orgId);
  return { ...policy, active: isActive };
}
