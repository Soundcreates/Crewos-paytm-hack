import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectSolariUsageSessionIds } from '../backend/build/solari-usage-route.js';

test('Solari usage session aggregation deduplicates sources, keeps latest timestamps, and skips malformed IDs', () => {
  assert.deepEqual(collectSolariUsageSessionIds(
    [
      { provider_id: 'session-a', created_at: '2026-01-01T00:00:00Z' },
      { provider_id: 'session-b', created_at: '2026-03-01T00:00:00Z' },
      { provider_id: '', created_at: '2026-05-01T00:00:00Z' },
      { provider_id: 'x'.repeat(2049), created_at: '2026-05-01T00:00:00Z' },
    ],
    [
      { output: JSON.stringify({ sessionId: 'session-a' }), created_at: '2026-02-01T00:00:00Z' },
      { output: JSON.stringify({ sessionId: 'session-b' }), created_at: '2026-02-01T00:00:00Z' },
      { output: '{bad json', created_at: '2026-06-01T00:00:00Z' },
    ],
    [
      { evidence: JSON.stringify([{ replaySessionId: 'session-c' }]), created_at: '2026-04-01T00:00:00Z' },
      { evidence: JSON.stringify([{ replaySessionId: 'session-b' }]), created_at: '2026-03-15T00:00:00Z' },
      { evidence: JSON.stringify({ replaySessionId: 'not-an-array-entry' }), created_at: '2026-07-01T00:00:00Z' },
      { evidence: 'null', created_at: '2026-08-01T00:00:00Z' },
    ],
  ), ['session-c', 'session-b', 'session-a']);
});
