#!/usr/bin/env node
import { CrewOSClient } from '../lib/client.mjs';

const usage = `CrewOS CLI

Environment: CREWOS_URL (default http://127.0.0.1:4173), CREWOS_EMAIL, CREWOS_PASSWORD

Commands:
  crewos me
  crewos employees list
  crewos employees create '<employee JSON>'
  crewos workflows list
  crewos workflows show <workflow-id>
  crewos workflows create <employee-id> <goal>
  crewos simulations list
  crewos simulations run <simulation-id> <employee-id>
  crewos refunds list`;

async function main() {
  const [resource, action, ...args] = process.argv.slice(2);
  if (!resource || resource === 'help' || resource === '--help' || resource === '-h') return console.log(usage);
  const email = process.env.CREWOS_EMAIL;
  const password = process.env.CREWOS_PASSWORD;
  if (!email || !password) throw new Error('Set CREWOS_EMAIL and CREWOS_PASSWORD for this command.');
  const client = new CrewOSClient();
  await client.login({ email, password });
  try {
    let result;
    if (resource === 'me') result = await client.me();
    else if (resource === 'employees' && action === 'list') result = await client.employees();
    else if (resource === 'employees' && action === 'create') result = await client.createEmployee(JSON.parse(args[0] || '{}'));
    else if (resource === 'workflows' && action === 'list') result = await client.workflows();
    else if (resource === 'workflows' && action === 'show' && args[0]) result = await client.workflow(args[0]);
    else if (resource === 'workflows' && action === 'create' && args.length >= 2) result = await client.createWorkflow({ employeeId: args[0], goal: args.slice(1).join(' ') });
    else if (resource === 'simulations' && action === 'list') result = await client.simulations();
    else if (resource === 'simulations' && action === 'run' && args.length >= 2) result = await client.runSimulation(args[0], { employeeId: args[1] });
    else if (resource === 'refunds' && action === 'list') result = await client.refunds();
    else throw new Error(`Unknown command.\n\n${usage}`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.logout().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
