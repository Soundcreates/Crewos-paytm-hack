import { repositories } from '../../src/repositories/index.mjs';
interface RefundRow {
  id: string;
  workflow_id: string;
  employee_id: string;
  case_id: string;
  amount: number | string;
  currency: string;
  status: string;
  created_at: string;
  employee_name: string;
}

export async function listRecentRefunds(orgId: string): Promise<RefundRow[]> {
  return repositories.simulations.findManySimulatedRefundByOrgId(orgId);
}
