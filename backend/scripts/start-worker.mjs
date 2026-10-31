import { fileURLToPath } from 'node:url';
process.env.PROCESS_ROLE='worker';
process.argv[1]=fileURLToPath(new URL('../server.mjs',import.meta.url));
await import('../server.mjs');
