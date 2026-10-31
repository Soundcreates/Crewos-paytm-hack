import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// A passing deployment cannot silently survive a change to the execution or
// probation contract. Legacy runtime routing remains a separate stable label.
const hash=createHash('sha256');
for (const path of ['langgraph/graph.mjs','langgraph/tool-registry.mjs','outcome.mjs','probation.mjs']) hash.update(readFileSync(new URL(path,import.meta.url)));
export const runtimeRevision=`langgraph-react-v1:${hash.digest('hex').slice(0,24)}`;
