import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadMcpPostconditionVerifier } from '../backend/lib/mcp-verifier.mjs';

test('MCP verifier loader accepts only a trusted module with the required export', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'crewos-mcp-verifier-'));
  try {
    const modulePath = join(directory, 'verifier.mjs');
    writeFileSync(modulePath, 'export function canVerifyMcpPostcondition(context) { return context.tool.name === "create_record"; } export async function verifyMcpPostcondition(context) { return { verified: context.result.id === context.input.id, evidence: { checkedId: context.result.id } }; }');
    const verifier = await loadMcpPostconditionVerifier(modulePath, directory);
    const context = { tool: { name: 'create_record' }, input: { id: 'record-1' }, result: { id: 'record-1' } };
    assert.equal(await verifier.canVerifyMcpPostcondition(context), true);
    assert.deepEqual(await verifier.verifyMcpPostcondition(context), {
      verified: true,
      evidence: { checkedId: 'record-1' },
    });
    assert.deepEqual(await verifier.verifyMcpPostcondition({ ...context, result: { id: 'record-2' } }), {
      verified: false,
      evidence: { checkedId: 'record-2' },
    });

    const defaultPath = join(directory, 'default.mjs');
    writeFileSync(defaultPath, 'export default { canVerifyMcpPostcondition() { return true; }, verifyMcpPostcondition() { return { verified: true }; } };');
    const defaultVerifier = await loadMcpPostconditionVerifier(defaultPath, directory);
    assert.equal(await defaultVerifier.canVerifyMcpPostcondition({}), true);
    assert.deepEqual(await defaultVerifier.verifyMcpPostcondition({}), { verified: true });

    const invalidPath = join(directory, 'invalid.mjs');
    writeFileSync(invalidPath, 'export const verifyMcpPostcondition = true;');
    await assert.rejects(loadMcpPostconditionVerifier(invalidPath, directory), /must export canVerifyMcpPostcondition/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('MCP verifier loader is disabled when no trusted module is configured', async () => {
  assert.equal(await loadMcpPostconditionVerifier('', process.cwd()), null);
});
