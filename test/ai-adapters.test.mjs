import assert from 'node:assert/strict';
import test from 'node:test';
import { describeImage, embed, llmJson, transcribeAudio } from '../backend/lib/ai.mjs';

test('OpenRouter adapters parse planner, embedding, image, and audio responses', async () => {
  const originalFetch = globalThis.fetch;
  const previousEmbeddingModel = process.env.OPENROUTER_EMBEDDING_MODEL;
  const previousEmbeddingDimensions = process.env.OPENROUTER_EMBEDDING_DIMENSIONS;
  const previousOpenRouterModel = process.env.OPENROUTER_MODEL;
  const previousTranscriptionModel = process.env.OPENROUTER_TRANSCRIPTION_MODEL;
  const usage = [];
  process.env.OPENROUTER_EMBEDDING_MODEL = 'embedding-test';
  process.env.OPENROUTER_EMBEDDING_DIMENSIONS = '1024';
  process.env.OPENROUTER_MODEL = 'openai/image-test';
  process.env.OPENROUTER_TRANSCRIPTION_MODEL = 'openai/whisper-test';
  globalThis.fetch = async (input, options = {}) => {
    const endpoint = String(input);
    assert.ok(endpoint.startsWith('https://openrouter.ai/api/v1/'), endpoint);
    assert.equal(options.headers.authorization, 'Bearer test-key');
    if (endpoint.endsWith('/chat/completions')) {
      const request = JSON.parse(options.body);
      assert.equal(request.max_tokens, 4096, 'chat completions must cap max_tokens so a constrained account cannot be rejected with a 402');
      const description = request.messages[0].content.startsWith('Describe');
      if (description) assert.equal(request.model, 'openai/image-test');
      if (description) {
        const imageUrl = request.messages[1].content[1].image_url.url;
        assert.equal(imageUrl, 'data:image/png;base64,QQ==');
      }
      const content = description ? '{"description":"An annotated receipt."}' : '{"steps":[]}';
      return new Response(JSON.stringify({ model: request.model, usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }, choices: [{ message: { content } }] }));
    }
    if (endpoint.endsWith('/embeddings')) {
      const request = JSON.parse(options.body);
      assert.equal(request.model, 'embedding-test');
      assert.equal(request.dimensions, 1024);
      return new Response(JSON.stringify({ model: 'embedding-test', usage: { prompt_tokens: 3, total_tokens: 3 }, data: [{ embedding: [0.1, 0.2] }] }));
    }
    if (endpoint.endsWith('/audio/transcriptions')) {
      const file = options.body.get('file');
      assert.equal(file.name, 'meeting.wav');
      assert.equal(options.body.get('model'), 'openai/whisper-test');
      return new Response(JSON.stringify({ text: 'Refunds above the limit need approval.' }));
    }
    throw new Error(`Unexpected provider URL ${endpoint}`);
  };
  try {
    assert.deepEqual(await llmJson('plan', 'task', { fallback: true }, null), { fallback: true });
    assert.deepEqual(await llmJson('plan', 'task', { fallback: true }, 'test-key', (record) => usage.push(record), 'planner-test'), { steps: [] });
    assert.deepEqual(await embed('policy text', 'test-key', (record) => usage.push(record)), [0.1, 0.2]);
    assert.equal(await describeImage(Buffer.from([65]), 'image/png', 'test-key', (record) => usage.push(record)), 'An annotated receipt.');
    assert.equal(await transcribeAudio(new Uint8Array([1, 2]), 'meeting.wav', 'test-key'), 'Refunds above the limit need approval.');
    assert.deepEqual(usage.map((item) => item.model), ['planner-test', 'embedding-test', 'openai/image-test']);
    assert.equal(usage[0].totalTokens, 6);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousEmbeddingModel === undefined) delete process.env.OPENROUTER_EMBEDDING_MODEL;
    else process.env.OPENROUTER_EMBEDDING_MODEL = previousEmbeddingModel;
    if (previousEmbeddingDimensions === undefined) delete process.env.OPENROUTER_EMBEDDING_DIMENSIONS;
    else process.env.OPENROUTER_EMBEDDING_DIMENSIONS = previousEmbeddingDimensions;
    if (previousOpenRouterModel === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = previousOpenRouterModel;
    if (previousTranscriptionModel === undefined) delete process.env.OPENROUTER_TRANSCRIPTION_MODEL;
    else process.env.OPENROUTER_TRANSCRIPTION_MODEL = previousTranscriptionModel;
  }
});
