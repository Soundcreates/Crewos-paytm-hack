import { inspectConfiguration } from '../lib/config-check.mjs';

const result = inspectConfiguration(process.env, { production: process.argv.includes('--production') || process.env.NODE_ENV === 'production' });
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
else {
  console.log('CrewOS configuration check (no network requests or database writes)');
  for (const check of result.checks) console.log(`${check.status.toUpperCase()} ${check.id}: ${check.message}`);
  console.log(result.ready ? 'Static configuration checks passed. Live acceptance is still required.' : 'Fix the configuration errors before release.');
}
if (!result.ready) process.exitCode = 1;
