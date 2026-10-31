import assert from 'node:assert/strict';
import { test } from 'node:test';

const { OPENROUTER_API_KEY, OPENROUTER_EMBEDDING_DIMENSIONS } = process.env;
const skip = !OPENROUTER_API_KEY ? 'OPENROUTER_API_KEY is not set; configure it to run this check.' : false;

test('live OpenRouter: planner completion and embedding adapters respond', { skip }, async () => {
  const { embed, llmJson } = await import('../backend/lib/ai.mjs');
  const plan = await llmJson(
    'Return JSON with one field "ok" set to true. Nothing else.',
    'Confirm you are reachable.',
    { ok: false },
    OPENROUTER_API_KEY,
  );
  assert.equal(plan.ok, true, `expected a live completion, got ${JSON.stringify(plan)}`);

  const vector = await embed('Live acceptance embedding probe.', OPENROUTER_API_KEY);
  assert.ok(Array.isArray(vector) && vector.length > 0, 'expected a non-empty embedding vector');
  if (OPENROUTER_EMBEDDING_DIMENSIONS) {
    assert.equal(vector.length, Number(OPENROUTER_EMBEDDING_DIMENSIONS), 'the embedding size must match OPENROUTER_EMBEDDING_DIMENSIONS so it fits the configured Pinecone index');
  }
});
