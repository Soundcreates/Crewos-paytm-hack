import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`:JSON.stringify(value);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const allowedScopes=new Set(['read_products','write_products','read_inventory','write_inventory','read_publications','write_publications']);
const fail=(message,code='commerce_unavailable',status=503)=>{throw Object.assign(new Error(message),{code,status});};

export function validateShopifyContext(context, expected={}) {
  if(context?.provider!=='shopify'||context?.environment!=='simulation'||context?.verified!==true) fail('A verified simulation Shopify connection is required.');
  const domain=String(context.providerAccountId||'').toLowerCase();
  if(!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)||expected.storeDomain&&expected.storeDomain.toLowerCase()!==domain) fail('The exact verified Shopify store identity does not match.','store_identity_mismatch',409);
  const scopes=new Set(context.scopes||[]);
  if([...new Set(expected.requiredScopes||[])].some(scope=>!allowedScopes.has(scope)||!scopes.has(scope))) fail('The Shopify connection is missing a required catalog scope.','scope_missing',403);
  return {orgId:context.orgId,connectionId:context.connectionId,providerAccountId:domain,environment:'simulation',scopes:[...scopes]};
}

function validateProduct(product) {
  if(!product||typeof product.title!=='string'||!product.title.trim()||!Array.isArray(product.variants)||!product.variants.length) fail('Product title and at least one variant are required.','product_invalid',422);
  const skus=new Set();
  for(const variant of product.variants){
    if(!Number.isSafeInteger(variant.priceMinor)||variant.priceMinor<0||! /^[A-Z]{3}$/.test(variant.currency||'')||(variant.inventory!==undefined&&(!Number.isSafeInteger(variant.inventory)||variant.inventory<0))) fail('Variant price must use nonnegative integer minor units and currency; optional inventory must be a nonnegative integer.','variant_invalid',422);
    if(variant.sku&&skus.has(variant.sku)) fail('Variant SKUs must be unique within a product.','sku_conflict',422);
    if(variant.sku)skus.add(variant.sku);
  }
}

/** Local fixture only. The object deliberately implements the CommerceProvider interface without network access. */
export function createShopifyFixtureAdapter({context,fixture={},requiredScopes=['read_products','write_products','read_inventory','write_inventory']}) {
  validateShopifyContext(context,{requiredScopes});
  const products=new Map(Object.entries(fixture.products||{})), operations=new Map(), orders=new Map(Object.entries(fixture.orders||{}));
  return {
    provider:'shopify',mode:'simulation',
    async identifyStore(expectedDomain){ validateShopifyContext(context,{storeDomain:expectedDomain});return {domain:context.providerAccountId,verified:true,scopes:[...context.scopes],environment:'simulation',simulated:true}; },
    async upsertCatalog({products:items,idempotencyKey}) {
      if(typeof idempotencyKey!=='string'||!idempotencyKey.trim()) fail('An idempotency key is required.','idempotency_required',400);
      if(!Array.isArray(items)||items.length<1||items.length>100) fail('Catalog requests must contain 1 to 100 products.','catalog_invalid',422);
      items.forEach(validateProduct);const inputHash=hash(items);const prior=operations.get(idempotencyKey);
      if(prior&&prior.inputHash!==inputHash)fail('The idempotency key is already bound to different catalog input.','idempotency_conflict',409);
      if(prior)return structuredClone(prior.result);
      const userErrors=items.filter(item=>fixture.userErrors?.some(error=>error.productTitle===item.title)).map(item=>({field:['products',item.title],message:'Fixture mutation userError.'}));
      if(userErrors.length)return {ok:false,userErrors,verified:false,simulated:true};
      const resultItems=[];
      for(const item of items){const remoteId=item.remoteId||`gid://shopify/Product/${hash([context.connectionId,item.title]).slice(0,20)}`;const remote={...structuredClone(item),remoteId,variants:item.variants.map((v,index)=>({...structuredClone(v),remoteId:v.remoteId||`gid://shopify/ProductVariant/${hash([remoteId,index,v.sku]).slice(0,20)}`}))};products.set(remoteId,remote);resultItems.push(structuredClone(remote));}
      const readback=resultItems.map(item=>structuredClone(products.get(item.remoteId)));
      if(fixture.readbackMismatch===true&&readback[0])readback[0].title=`${readback[0].title} (fixture mismatch)`;
      const verified=readback.length===items.length&&readback.every((row,index)=>{const {remoteId:_remoteId,...normalized}=row;normalized.variants=normalized.variants.map(({remoteId:_variantId,...v})=>v);return isDeepStrictEqual(normalized,items[index]);});
      if(!verified)fail('Shopify fixture read-back did not match the requested catalog.','verification_failed',409);
      const result={ok:true,products:readback,verified:true,simulated:true,environment:'simulation'};operations.set(idempotencyKey,{inputHash,result:structuredClone(result)});return result;
    },
    async readOrder(remoteOrderId){const order=orders.get(String(remoteOrderId));return order?{...structuredClone(order),simulated:true,environment:'simulation'}:null;},
    async recordFixtureOrder(order){if(!order?.remoteOrderId)fail('Fixture order id is required.','order_invalid',422);orders.set(String(order.remoteOrderId),structuredClone(order));return this.readOrder(order.remoteOrderId);},
    async listOrders(){return [...orders.values()].map(order=>({...structuredClone(order),simulated:true,environment:'simulation'}));},
    async verifyCatalog(productsToVerify){const result=[];for(const item of productsToVerify){const stored=products.get(item.remoteId);result.push({remoteId:item.remoteId,verified:Boolean(stored&&isDeepStrictEqual(stored,item)),simulated:true});}return result;},
    async createProduct(){fail('Live Shopify catalog writes are setup-required and disabled.');},
    async publish(){fail('Shopify publication is disabled; manager approval and a verified live connection are required.','approval_required',403);},
    status(){return {state:'simulation_ready',simulated:true,liveActions:'setup_required'};},
  };
}

/** Representative read/write/readback readiness case. It runs against an isolated local fixture only. */
export async function runShopifyCatalogWriteProbation(context) {
  const fixture=createShopifyFixtureAdapter({context,fixture:{},requiredScopes:['read_products','write_products']});
  const product={title:'CrewOS fixture probation product',variants:[{sku:'CREWOS-PROBATION-1',priceMinor:100,currency:'USD'}]};
  const result=await fixture.upsertCatalog({products:[product],idempotencyKey:`probation:${context.connectionId}`});
  if(result.ok!==true||result.verified!==true||result.simulated!==true||result.products?.length!==1)throw Object.assign(new Error('Shopify fixture write probation did not pass readback.'),{code:'probation_failed'});
  const readback=await fixture.verifyCatalog(result.products);
  if(readback.length!==1||readback[0].verified!==true)throw Object.assign(new Error('Shopify fixture write probation readback failed.'),{code:'probation_failed'});
  return {passed:true,caseId:'shopify.product.set.fixture_readback.v1',simulated:true};
}

/** Validates a trusted CLI invocation; callers may inspect it but this module never spawns a process. */
export async function buildShopifyCliInvocation({cliPath,cliRoot,homePath,homeRoot,workdir,workRoot,args}) {
  const fs=await import('node:fs/promises');
  const resolveInside=async(path,root)=>{if(!path||!root)throw new Error('CLI path, home and workdir must be configured.');const realPath=await fs.realpath(path),realRoot=await fs.realpath(root),separator=process.platform==='win32'?'\\':'/';if(realPath!==realRoot&&!realPath.startsWith(realRoot+separator))throw Object.assign(new Error('Configured Shopify CLI path escapes its trusted root.'),{code:'cli_path_untrusted'});return realPath;};
  const [file,home,cwd]=await Promise.all([resolveInside(cliPath,cliRoot),resolveInside(homePath,homeRoot),resolveInside(workdir,workRoot)]);
  const safeDomain=value=>/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(value||'');
  const safeRelative=value=>typeof value==='string'&&value.length<300&&!value.startsWith('-')&&!value.startsWith('/')&&!value.split(/[\\/]/).includes('..')&&!value.includes('\0');
  const valid=Array.isArray(args)&&(
    args.length===3&&args[0]==='shop'&&args[1]==='list'&&args[2]==='--json'||
    args.length===5&&args[0]==='shop'&&args[1]==='info'&&args[2]==='--json'&&args[3]==='--store'&&safeDomain(args[4])||
    args.length===5&&args[0]==='theme'&&args[1]==='check'&&args[2]==='--path'&&safeRelative(args[3])&&args[4]==='--json'||
    args.length===7&&args[0]==='theme'&&args[1]==='push'&&args[2]==='--unpublished'&&args[3]==='--json'&&args[4]==='--path'&&safeRelative(args[5])&&args[6]==='--store'&&false||
    args.length===8&&args[0]==='theme'&&args[1]==='push'&&args[2]==='--unpublished'&&args[3]==='--json'&&args[4]==='--path'&&safeRelative(args[5])&&args[6]==='--store'&&safeDomain(args[7])
  );
  if(!valid||args.some(arg=>typeof arg!=='string'||arg.includes('\0')))throw Object.assign(new Error('Shopify CLI argv contains an unsupported command or option.'),{code:'cli_argv_rejected'});
  return {file,args:[...args],options:{cwd,shell:false,env:{HOME:home,SHOPIFY_CLI_HOME:home},windowsHide:true}};
}
