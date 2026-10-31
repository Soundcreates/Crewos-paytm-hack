import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { ingestSignedWebhook } from '../backend/src/services/webhook-ingress.mjs';
import { createDurableDelivery } from '../backend/src/services/durable-delivery.mjs';

test('invalid webhook signature is rejected before transaction and fixture cannot use production connection', async () => {
  let transactions = 0;
  const base = { rawBody:Buffer.from('{"order":1}'),signature:'sha256='+'0'.repeat(64),secret:'fixture-secret',connection:{id:'c1',org_id:'org1',provider:'fixture',environment:'simulation'},eventId:'evt1',eventType:'order.created',transaction:async fn=>{transactions++;return fn()},repository:{},newId:()=> 'x',timestamp:()=>new Date().toISOString() };
  await assert.rejects(ingestSignedWebhook(base), {code:'signature_invalid'});
  assert.equal(transactions,0);
  const signed = {...base,connection:{...base.connection,environment:'production',fixture:true},signature:'sha256='+createHmac('sha256','fixture-secret').update(base.rawBody).digest('hex')};
  await assert.rejects(ingestSignedWebhook(signed), {code:'fixture_production_blocked'});
});

test('outbox leases are generation fenced and bounded retries dead-letter', async () => {
  let row={id:'o1',state:'pending',lease_generation:0,attempts:8};
  const repository={claimOutbox:async(_id)=>{row={...row,state:'leased',lease_generation:row.lease_generation+1};return {changes:1};},findOutboxById:async()=>row,finishOutboxLease:async(_id,generation)=>generation===row.lease_generation?{changes:1}:{changes:0},retryOutboxLease:async(_id,generation,_at,_error,state)=>generation===row.lease_generation?(row={...row,state},{changes:1}):{changes:0}};
  const delivery=createDurableDelivery({repository,timestamp:()=>new Date(0).toISOString()});
  const lease=await delivery.claimOutbox('o1');
  assert.equal(lease.lease_generation,1);
  assert.equal((await delivery.finishOutbox('o1',0)).changes,0);
  assert.equal((await delivery.failOutbox('o1',1,8,'retry exhausted')).changes,1);
  assert.equal(row.state,'dead_letter');
});
