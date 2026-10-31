function minorUnits(value,currency) {
  const places=new Set(['JPY','KRW']).has(currency)?0:2;const match=String(value??'').trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);if(!match)throw Object.assign(new Error('Order amount is not an exact decimal value.'),{code:'order_amount_invalid'});
  const fraction=(match[2]||'').padEnd(places,'0');if(match[2]?.length>places)throw Object.assign(new Error('Order amount has too many decimal places.'),{code:'order_amount_invalid'});
  const result=BigInt(match[1])*BigInt(10**places)+BigInt(fraction||'0');if(result>BigInt(Number.MAX_SAFE_INTEGER))throw Object.assign(new Error('Order amount exceeds the safe integer range.'),{code:'order_amount_invalid'});return Number(result);
}
export function normalizeShopifyOrderEvent(eventType,payload,environment='simulation') {
  if(!['orders/create','orders/paid','orders/updated','orders/cancelled','refunds/create','order.created','order.paid','order.updated','order.cancelled','order.refunded'].includes(eventType))return null;
  const order=payload.order||payload;const remoteOrderId=String(order.id||'').trim();const currency=String(order.currency||order.presentment_currency||'').toUpperCase();
  if(!remoteOrderId||! /^[A-Z]{3}$/.test(currency))throw Object.assign(new Error('Shopify order identity or currency is invalid.'),{code:'order_invalid'});
  const totalMinor=minorUnits(order.total_price??order.current_total_price??order.total,currency);
  const kind=eventType.replace(/^orders\//,'order.').replace(/^order\./,'');
  const financial=String(order.financial_status||'pending').toLowerCase();const cancelled=Boolean(order.cancelled_at)||kind==='cancelled';const refunded=financial==='refunded'||financial==='partially_refunded'||kind==='refunded';
  return {remoteOrderId,currency,totalMinor,eventType,occurredAt:String(payload.occurred_at||order.updated_at||order.created_at||new Date(0).toISOString()),paymentState:refunded?'refunded':financial==='paid'||kind==='paid'?'paid':'pending',orderState:cancelled?'cancelled':String(order.fulfillment_status||'open').toLowerCase()==='fulfilled'?'fulfilled':'open',environment,simulated:environment==='simulation',evidenceRefs:Array.isArray(payload.evidenceRefs)?payload.evidenceRefs.filter(ref=>typeof ref==='string').slice(0,20):[]};
}

/** Project a canonical per-connection order state, with server-side read-back before paid is counted. */
export async function projectVerifiedShopifyOrder({connection,eventId,normalized,readOrder,repository,timestamp}) {
  if(!connection?.org_id||!connection?.id||connection.provider!=='shopify'||!normalized)throw Object.assign(new Error('Verified Shopify event binding is required.'),{code:'order_binding_invalid'});
  const remote=await readOrder(normalized.remoteOrderId);const matches=remote&&String(remote.remoteOrderId||remote.id)===normalized.remoteOrderId&&String(remote.currency).toUpperCase()===normalized.currency&&Number(remote.totalMinor)===normalized.totalMinor&&remote.environment===normalized.environment;
  const paidVerified=normalized.paymentState==='paid'&&matches&&String(remote.paymentState||remote.financial_status).toLowerCase()==='paid';
  const prior=await repository.findCanonicalOrder(connection.org_id,connection.id,normalized.remoteOrderId);
  if(prior&&Date.parse(normalized.occurredAt)<Date.parse(prior.occurred_at))return {duplicate:false,stale:true,order:prior,paidVerified:false};
  const order={...normalized,paymentState:normalized.paymentState==='paid'?(paidVerified?'paid':'pending'):normalized.paymentState,verified:paidVerified};
  const id=prior?.id||`order_${connection.id}_${normalized.remoteOrderId}`;const at=timestamp();
  await repository.upsertCanonicalOrder(id,connection.org_id,connection.id,normalized.environment,normalized.remoteOrderId,normalized.currency,normalized.totalMinor,order.paymentState,normalized.orderState,normalized.occurredAt,at,normalized.simulated?1:0,eventId);
  const receipt=await repository.insertOrderEventReceipt(connection.id,eventId,id,normalized.eventType,at);
  return {duplicate:receipt?.changes!==1,stale:false,order:{...order,id},paidVerified:receipt?.changes===1&&paidVerified};
}
