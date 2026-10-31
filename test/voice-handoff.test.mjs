import assert from 'node:assert/strict';
import test from 'node:test';
import { DEMO_STORES, inferDemoStoreType, resolveVoiceHandoff } from '../frontend/src/lib/demo-store.js';

test('a finished connected interview advances even when transcript callbacks are missing', () => {
  assert.deepEqual(resolveVoiceHandoff({ handoff: true, connected: true, transcript: [] }), {
    action: 'complete-demo-interview', storeType: 'clothing',
  });
  assert.deepEqual(resolveVoiceHandoff({ handoff: true, connected: true, transcript: [{ role: 'user', en_text: 'We sell shoes.' }] }), {
    action: 'complete-demo-interview', storeType: 'footwear',
  });
});

test('interview answers select the matching catalog for all five store types', () => {
  for (const [answer, type, product] of [
    ['We make running shoes and sneakers', 'footwear', 'Stride Run One'],
    ['We sell clothing and shirts', 'clothing', 'Everyday Cotton Tee'],
    ['Our company sells bags for laptops', 'bags', 'Transit 16-inch Laptop Bag'],
    ['We build laptops and computers', 'technology', 'Aster Air 14 Laptop'],
    ['We sell leather belts', 'belts', 'Classic Leather Belt'],
  ]) {
    const result = inferDemoStoreType([{ role: 'agent', en_text: 'Do you sell shoes?' }, { role: 'user', en_text: answer }]);
    assert.equal(result, type);
    assert.equal(DEMO_STORES[result].products[0].name, product);
  }
  assert.equal(inferDemoStoreType([{ role: 'user', en_text: 'We used to sell belts.' }, { role: 'user', en_text: 'Now we make laptops.' }]), 'technology');
});

test('failed setup and cleanup do not advance, and an escalation returns to its store', () => {
  assert.equal(resolveVoiceHandoff({ handoff: true, connected: false, transcript: [] }), null);
  assert.equal(resolveVoiceHandoff({ handoff: false, connected: true, transcript: [] }), null);
  assert.deepEqual(resolveVoiceHandoff({ handoff: true, connected: true, callContext: { storeType: 'bags' }, transcript: [] }), {
    action: 'return-chief-call', storeType: 'bags',
  });
});
