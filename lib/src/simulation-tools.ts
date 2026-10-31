import { validateBrowserActions } from './solari-tools.mjs';

export interface SimulatedRefund {
  ok: true;
  simulated: true;
  refundId: string;
  caseId: string;
  amount: number;
  currency: string;
  status: 'simulated';
}

export interface VerifiedRefundEvidence {
  refundId: string;
  caseId: string;
  amount: number;
  currency: string;
  status: 'simulated';
  simulated: true;
}

export type SimulatedRefundVerification =
  | { verified: true; evidence: VerifiedRefundEvidence }
  | { verified: false; evidence: { simulated: true; invalidResult: true } };

export function canExecuteSimulationTool(tool: string, input: unknown): boolean {
  if (tool === 'payments.refund' || tool === 'solari.sandbox.echo' || tool === 'solari.browser.open') return true;
  if (tool !== 'solari.browser.interact' || !input || typeof input !== 'object' || Array.isArray(input)) return false;
  try {
    const actions = validateBrowserActions((input as Record<string, unknown>).actions);
    return actions.every((action) => action.action === 'assertText' || action.action === 'wait');
  } catch { return false; }
}

interface ParsedRefundInput {
  amount: number;
  currency: string;
  caseId: string;
}

function refundInput(input: unknown): ParsedRefundInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Refund input must be an object.');
  const values = input as Record<string, unknown>;
  const amount = Number(values.amount);
  const currency = String(values.currency ?? '').trim().toUpperCase();
  const caseId = String(values.caseId ?? '').trim();
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) throw new Error('Refund amount must be greater than 0 and no more than 1,000,000.');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('Currency must be a three-letter code.');
  if (!caseId || caseId.length > 100 || /[\0\r\n]/.test(caseId)) throw new Error('Case ID must be non-empty text up to 100 characters.');
  return { amount, currency, caseId };
}

export function executeSimulatedRefund(input: unknown, runId: string, stepIndex: number): SimulatedRefund {
  const { amount, currency, caseId } = refundInput(input);
  return { ok: true, simulated: true, refundId: `${runId}:${stepIndex}`, caseId, amount, currency, status: 'simulated' };
}

export function verifySimulatedRefund(input: unknown, output: unknown): SimulatedRefundVerification {
  const expected = refundInput(input);
  const result = output as Record<string, unknown> | null | undefined;
  const verified = Boolean(result?.ok === true && result.simulated === true && result.status === 'simulated' && result.caseId === expected.caseId && Number(result.amount) === expected.amount && result.currency === expected.currency && typeof result.refundId === 'string' && result.refundId.length > 0);
  return verified
    ? { verified: true, evidence: { refundId: result!.refundId as string, caseId: result!.caseId as string, amount: expected.amount, currency: expected.currency, status: result!.status as 'simulated', simulated: true } }
    : { verified: false, evidence: { simulated: true, invalidResult: true } };
}
