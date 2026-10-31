import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type VerifierFunction = (context: unknown) => unknown | Promise<unknown>;
type Verifier = {
  canVerifyMcpPostcondition: VerifierFunction;
  verifyMcpPostcondition: VerifierFunction;
};

function properties(value: unknown): Record<string, unknown> | null {
  return value !== null && (typeof value === 'object' || typeof value === 'function') ? value as Record<string, unknown> : null;
}

function verifierFunction(value: unknown): value is VerifierFunction {
  return typeof value === 'function';
}

export async function loadMcpPostconditionVerifier(specifier: unknown, projectRoot: string): Promise<Verifier | null> {
  if (!String(specifier || '').trim()) return null;
  const value = String(specifier).trim();
  const url = value.startsWith('file:') ? new URL(value) : pathToFileURL(resolve(projectRoot, value));
  const verifierModule = properties(await import(url.href)) || {};
  const defaultExports = properties(verifierModule.default);
  const verifyMcpPostcondition = verifierModule.verifyMcpPostcondition || defaultExports?.verifyMcpPostcondition;
  const canVerifyMcpPostcondition = verifierModule.canVerifyMcpPostcondition || defaultExports?.canVerifyMcpPostcondition;
  if (!verifierFunction(verifyMcpPostcondition) || !verifierFunction(canVerifyMcpPostcondition)) {
    throw new Error('MCP_VERIFIER_MODULE must export canVerifyMcpPostcondition(context) and verifyMcpPostcondition(context).');
  }
  return { canVerifyMcpPostcondition, verifyMcpPostcondition };
}
