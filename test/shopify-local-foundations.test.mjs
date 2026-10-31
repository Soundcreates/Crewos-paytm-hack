import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createShopifyFixtureAdapter, buildShopifyCliInvocation } from '../backend/src/integrations/shopify-commerce.mjs';
import { buildLocalShopifyTheme, approvalMatchesThemeRevision } from '../backend/src/services/shopify-theme.mjs';
import { normalizeShopifyOrderEvent, projectVerifiedShopifyOrder } from '../backend/src/integrations/shopify-events.mjs';

const context={orgId:'org_a',connectionId:'conn_a',provider:'shopify',providerAccountId:'acme.myshopify.com',environment:'simulation',scopes:['read_products','write_products','read_inventory','write_inventory'],verified:true};
const product={title:'Mug',variants:[{sku:'MUG-1',priceMinor:1299,currency:'USD',inventory:4}]};

test('fixture catalog uses integer minor units, userErrors and idempotent read-back',async()=>{
  const adapter=createShopifyFixtureAdapter({context});const saved=await adapter.upsertCatalog({products:[product],idempotencyKey:'catalog-1'});
  assert.equal(saved.verified,true);assert.equal(saved.simulated,true);assert.equal(saved.products[0].variants[0].priceMinor,1299);
  assert.deepEqual(await adapter.upsertCatalog({products:[product],idempotencyKey:'catalog-1'}),saved);
  await assert.rejects(adapter.upsertCatalog({products:[{...product,title:'Other'}],idempotencyKey:'catalog-1'}),{code:'idempotency_conflict'});
  const withError=createShopifyFixtureAdapter({context,fixture:{userErrors:[{productTitle:'Mug'}]}});
  assert.deepEqual((await withError.upsertCatalog({products:[product],idempotencyKey:'catalog-error'})).userErrors[0].message,'Fixture mutation userError.');
  await assert.rejects(adapter.upsertCatalog({products:[{title:'Bad',variants:[{priceMinor:12.5,currency:'USD',inventory:0}]}],idempotencyKey:'bad'}),{code:'variant_invalid'});
});

test('CLI invocation rejects argv injection and resolves trusted paths without launching',async()=>{
  const root=await mkdtemp(join('/tmp','crewos-shopify-cli-'));
  try{const cliRoot=join(root,'cli'),homeRoot=join(root,'home'),workRoot=join(root,'work');await Promise.all([mkdir(cliRoot),mkdir(homeRoot),mkdir(workRoot)]);const cli=join(cliRoot,'shopify');await writeFile(cli,'fixture');
    const invocation=await buildShopifyCliInvocation({cliPath:cli,cliRoot,homePath:homeRoot,homeRoot,workdir:workRoot,workRoot,args:['shop','list','--json']});
    assert.equal(invocation.options.shell,false);assert.deepEqual(invocation.args,['shop','list','--json']);
    await assert.rejects(buildShopifyCliInvocation({cliPath:cli,cliRoot,homePath:homeRoot,homeRoot,workdir:workRoot,workRoot,args:['shop','create','--name','x'] }),{code:'cli_argv_rejected'});
    await assert.rejects(buildShopifyCliInvocation({cliPath:cli,cliRoot,homePath:homeRoot,homeRoot,workdir:root,workRoot,args:['shop','list','--json']}),{code:'cli_path_untrusted'});
  }finally{await rm(root,{recursive:true,force:true});}
});

test('theme revisions are local, immutable by hash and approval is bound to exact revision',()=>{
  const built=buildLocalShopifyTheme({brand:{name:'Acme'}});assert.equal(built.publishing.available,false);assert.equal(built.preview.simulated,true);
  const rev={orgId:'org_a',connectionId:'conn_a',environment:'simulation',revision:2,artifactHash:built.artifactHash};
  assert.equal(approvalMatchesThemeRevision({...rev,state:'approved'},rev),true);
  assert.equal(approvalMatchesThemeRevision({...rev,revision:1,state:'approved'},rev),false);
  assert.throws(()=>buildLocalShopifyTheme({files:{'../secrets':'x'}}),{code:'theme_path_rejected'});
  assert.throws(()=>buildLocalShopifyTheme({files:{'templates/index.json':'{'}}),{code:'theme_syntax_invalid'});
});

test('canonical orders deduplicate events, preserve exact minor units, require read-back and ignore stale transitions',async()=>{
  const normalized=normalizeShopifyOrderEvent('orders/paid',{id:44,currency:'USD',total_price:'19.95',financial_status:'paid',updated_at:'2026-10-31T00:00:00.000Z'},'simulation');
  assert.equal(normalized.totalMinor,1995);
  let prior=null;const receipts=new Set();const repo={findCanonicalOrder:async()=>prior,upsertCanonicalOrder:async(...args)=>{prior={id:args[0],org_id:args[1],connection_id:args[2],environment:args[3],remote_order_id:args[4],currency:args[5],total_minor:args[6],payment_state:args[7],order_state:args[8],occurred_at:args[9]};},insertOrderEventReceipt:async(_c,event)=>{if(receipts.has(event))return{changes:0};receipts.add(event);return{changes:1};}};
  const connection={id:'conn_a',org_id:'org_a',provider:'shopify'};const readOrder=async remoteOrderId=>({remoteOrderId,currency:'USD',totalMinor:1995,paymentState:'paid',environment:'simulation'});
  const first=await projectVerifiedShopifyOrder({connection,eventId:'e1',normalized,readOrder,repository:repo,timestamp:()=>normalized.occurredAt});assert.equal(first.paidVerified,true);
  const duplicate=await projectVerifiedShopifyOrder({connection,eventId:'e1',normalized,readOrder,repository:repo,timestamp:()=>normalized.occurredAt});assert.equal(duplicate.duplicate,true);
  const later=normalizeShopifyOrderEvent('orders/cancelled',{id:44,currency:'USD',total_price:'19.95',cancelled_at:'2026-10-31T01:00:00.000Z',updated_at:'2026-10-31T01:00:00.000Z'},'simulation');
  const cancelled=await projectVerifiedShopifyOrder({connection,eventId:'e2',normalized:later,readOrder,repository:repo,timestamp:()=>later.occurredAt});assert.equal(cancelled.order.orderState,'cancelled');
  const older={...normalized,occurredAt:'2026-10-30T00:00:00.000Z'};assert.equal((await projectVerifiedShopifyOrder({connection,eventId:'e3',normalized:older,readOrder,repository:repo,timestamp:()=>older.occurredAt})).stale,true);
});
