import { enqueueMemoryIndexBackfill } from '../build/services/memory.js';

try {
  const { runId, queued } = await enqueueMemoryIndexBackfill();
  console.log(`Queued ${queued} memory record(s) for Pinecone indexing (backfill ${runId}).`);
} catch (error) {
  console.error(error.message || 'Memory vector backfill could not be queued.');
  process.exitCode = 1;
}
