#!/usr/bin/env node
import { CrewOSClient } from '../lib/client.mjs';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const integerEnv = (name, fallback, min, max) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
};

async function main() {
  if (!process.argv.includes('--confirm-simulated-workflows')) {
    throw new Error('This check creates simulated $1 refund workflows and audit records. Rerun with --confirm-simulated-workflows to continue.');
  }
  const email = process.env.CREWOS_EMAIL;
  const password = process.env.CREWOS_PASSWORD;
  if (!email || !password) throw new Error('Set CREWOS_EMAIL and CREWOS_PASSWORD.');
  const count = integerEnv('STRESS_WORKFLOW_COUNT', 16, 2, 64);
  const timeoutMs = integerEnv('STRESS_POLL_TIMEOUT_MS', 300_000, 10_000, 900_000);
  const pollMs = integerEnv('STRESS_POLL_INTERVAL_MS', 100, 50, 10_000);
  const client = new CrewOSClient();
  await client.login({ email, password });
  const startedAt = Date.now();
  try {
    const employees = (await client.employees()).filter((employee) => employee.state === 'active'
      && employee.spec?.tools?.length === 1 && employee.spec.tools[0] === 'payments.refund');
    if (employees.length < 2) throw new Error('Deploy at least two test employees whose only granted tool is payments.refund.');
    const testId = `${Date.now().toString(36)}-${process.pid}`;
    const creates = await Promise.allSettled(Array.from({ length: count }, (_, index) => {
      const employee = employees[index % employees.length];
      const caseId = `STRESS-${testId}-${index + 1}`;
      return client.createWorkflow({ employeeId: employee.id, goal: `Run the simulated USD $1.00 refund for case ${caseId}. This is a concurrency acceptance check.` })
        .then((workflow) => ({ ...workflow, employeeName: employee.name, caseId }));
    }));
    const failures = creates.filter((result) => result.status === 'rejected').map((result) => String(result.reason?.message || result.reason));
    const pending = new Map(creates.filter((result) => result.status === 'fulfilled').map((result) => [result.value.id, result.value]));
    const completed = [];
    const readFailures = new Map();
    let maxConcurrentWorking = 0;
    const deadline = Date.now() + timeoutMs;
    while (pending.size && Date.now() < deadline) {
      const ids = [...pending.keys()];
      const reads = await Promise.allSettled(ids.map((id) => client.workflow(id)));
      let workingNow = 0;
      reads.forEach((result, index) => {
        const id = ids[index];
        if (result.status === 'rejected') {
          readFailures.set(id, String(result.reason?.message || result.reason));
          return;
        }
        const workflow = result.value;
        if (workflow.status === 'working') workingNow++;
        readFailures.delete(workflow.id);
        if (['completed', 'failed', 'cancelled', 'input_required'].includes(workflow.status)) {
          completed.push({ id: workflow.id, employeeName: pending.get(workflow.id)?.employeeName, caseId: pending.get(workflow.id)?.caseId, status: workflow.status, error: workflow.error || null });
          pending.delete(workflow.id);
        }
      });
      maxConcurrentWorking = Math.max(maxConcurrentWorking, workingNow);
      if (pending.size) await sleep(pollMs);
    }
    const summary = {
      requested: count,
      created: count - creates.filter((result) => result.status === 'rejected').length,
      completed: completed.filter((workflow) => workflow.status === 'completed').length,
      otherTerminal: completed.filter((workflow) => workflow.status !== 'completed').length,
      maxConcurrentWorking,
      overlapConfirmed: maxConcurrentWorking >= 2,
      timedOut: [...pending.keys()],
      elapsedMs: Date.now() - startedAt,
      workflows: completed,
      errors: [...failures, ...readFailures.values()],
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (summary.created !== count || summary.completed !== count || !summary.overlapConfirmed) process.exitCode = 1;
  } finally {
    await client.logout().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
