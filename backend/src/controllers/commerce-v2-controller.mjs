import { organizationEngineV2Status } from '../services/feature-flags.mjs';
import { runShopifyCatalogWriteProbation } from '../integrations/shopify-commerce.mjs';
import { buildLocalShopifyTheme } from '../services/shopify-theme.mjs';
import { capabilityGrantFingerprint } from '../services/event-dispatcher.mjs';
import { createShopifyAdminGraphqlAdapter } from '../integrations/shopify-admin-graphql.mjs';

const SCOPES=['read_products','write_products','read_inventory','write_inventory','read_publications','read_orders'];
function parseJson(value,fallback={}){try{return JSON.parse(value||'{}')}catch{return fallback}}
const safeDomain=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(value);

export function createCommerceV2Controller({repositories,HttpError,requireRole,transaction,id,now,sendJson,env=process.env,pilotMode=()=>false,currentPolicyRevision,shopifyLifecycle=null,shopifyCatalogApi=null,shopifyCallbackBridge=null,shopifyDevStores=null,shopifyDevThemes=null}) {
  async function connectionFor(orgId,connectionId){const connection=await repositories.foundation.findConnectionById(connectionId);if(!connection||connection.org_id!==orgId||connection.provider!=='shopify')throw new HttpError(404,'Commerce connection not found.');return connection;}
  function ensureEnabled(orgId){const status=organizationEngineV2Status(orgId,env);if(!status.enabled)throw new HttpError(404,'Organization Engine V2 is disabled for this workspace.');return status;}
  function ensureOutsidePilot(){if(pilotMode())throw new HttpError(403,'Commerce simulation writes are disabled by PILOT_MODE.','pilot_mode_blocked');}
  function ensureLiveReadAllowed(){if(pilotMode())throw new HttpError(403,'Shopify live catalog reads are disabled by PILOT_MODE.','pilot_mode_blocked');}
  function catalogPageInput(request){
    const params=new URL(request?.url||'/', 'http://localhost').searchParams;
    const values={};
    for(const key of params.keys()){
      if(!['first','after'].includes(key)||params.getAll(key).length!==1)throw new HttpError(422,'Shopify catalog page query is invalid.','shopify_pagination_invalid');
    }
    if(params.has('first')){const raw=params.get('first');if(!/^\d+$/.test(raw))throw new HttpError(422,'Shopify catalog page size must be an integer.','shopify_pagination_invalid');values.first=Number(raw);}
    if(params.has('after'))values.after=params.get('after');
    return values;
  }
  return { async handle({path,method,response,body,context,org,user,request}) {
    if(!path.startsWith('/api/commerce/v2'))return false;
    requireRole(context,'manager');ensureEnabled(org.id);
    if(path==='/api/commerce/v2/status'&&method==='GET')return sendJson(response,200,{enabled:true,providers:{shopify:{simulation:'available',oauth:shopifyLifecycle?.ready?'available':'setup_required',callbackUrl:shopifyLifecycle?.ready?env.SHOPIFY_OAUTH_CALLBACK_URL:null,live:'setup_required'}},theme:{build:'local_only',push:'development_preview_only',publish:'disabled'},environment:'simulation',pilotMode:Boolean(pilotMode())});
    if(path==='/api/commerce/v2/shopify/dev-store-theme'&&(method==='GET'||method==='POST')){
      ensureOutsidePilot();
      if(!shopifyDevThemes)throw new HttpError(503,'Development storefront previews are unavailable.','dev_theme_unavailable');
      const sessionId=method==='GET'?new URL(request.url,'http://localhost').searchParams.get('voiceSessionId'):body.voiceSessionId;
      if(typeof sessionId!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId))throw new HttpError(400,'A voice session ID is required.','voice_session_invalid');
      const result=method==='GET'?await shopifyDevThemes.read(org.id,sessionId):await shopifyDevThemes.create({orgId:org.id,userId:user.id,voiceSessionId:sessionId,category:body.category});
      return sendJson(response,method==='POST'&&result?.status==='creating'?202:200,{theme:result});
    }
    if(path==='/api/commerce/v2/shopify/dev-stores'&&(method==='GET'||method==='POST')){
      ensureOutsidePilot();
      if(!shopifyDevStores)throw new HttpError(503,'Development store creation is unavailable.','dev_store_unavailable');
      const sessionId=method==='GET'?new URL(request.url,'http://localhost').searchParams.get('voiceSessionId'):body.voiceSessionId;
      if(typeof sessionId!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(sessionId))throw new HttpError(400,'A voice session ID is required.','voice_session_invalid');
      const result=method==='GET'?await shopifyDevStores.read(org.id,sessionId):await shopifyDevStores.create({orgId:org.id,userId:user.id,voiceSessionId:sessionId,name:body.name});
      return sendJson(response,method==='POST'&&result?.status==='creating'?202:200,{store:result});
    }
    if(path==='/api/commerce/v2/shopify/connections'&&method==='GET')return sendJson(response,200,shopifyLifecycle?await shopifyLifecycle.list(org.id):[]);
    if(path==='/api/commerce/v2/shopify/connections/connect'&&method==='POST'){
      ensureOutsidePilot();
      if(!shopifyLifecycle?.ready)throw new HttpError(503,'Shopify authorization requires server app credentials, a public HTTPS callback URL, and credential encryption setup.','shopify_oauth_setup_required');
      const result=await shopifyLifecycle.begin({orgId:org.id,managerUserId:user.id,storeDomain:body.storeDomain,environment:body.environment||'staging',request});
      response.setHeader('cache-control','no-store');
      const bridgeCookie=shopifyCallbackBridge?.issue(context);
      if(shopifyCallbackBridge&&!bridgeCookie)throw new HttpError(503,'Shopify callback session could not be prepared.','shopify_callback_session_unavailable');
      const cookies=[...(Array.isArray(result.setCookie)?result.setCookie:result.setCookie?[result.setCookie]:[]),...(bridgeCookie?[bridgeCookie]:[])];
      if(cookies.length)response.setHeader('set-cookie',cookies);
      return sendJson(response,200,{authorizationUrl:result.authorizationUrl,connection:result.connection,expiresAt:result.expiresAt,tokenReturned:false});
    }
    if(path==='/api/commerce/v2/shopify/oauth/callback'&&method==='GET'){
      ensureOutsidePilot();
      if(!shopifyLifecycle?.ready)throw new HttpError(503,'Shopify callback is unavailable until server authorization and credential encryption are configured.','shopify_oauth_setup_required');
      await shopifyLifecycle.complete({orgId:org.id,managerUserId:user.id,request,response});
      return true;
    }
    const disconnectRoute=path.match(/^\/api\/commerce\/v2\/shopify\/connections\/([^/]+)$/);
    if(disconnectRoute&&method==='DELETE'){
      ensureOutsidePilot();
      if(!shopifyLifecycle?.ready)throw new HttpError(503,'Shopify credential lifecycle is not configured.','shopify_oauth_setup_required');
      const result=await transaction(()=>shopifyLifecycle.disconnect({orgId:org.id,connectionId:disconnectRoute[1]}));
      return sendJson(response,200,{...result,tokenReturned:false});
    }
    if(path==='/api/commerce/v2/shopify/simulation-connections'&&method==='GET'){
      const connections=await repositories.foundation.findSimulationShopifyConnections(org.id);
      return sendJson(response,200,connections.filter(connection=>parseJson(connection.config).fixture===true).map(connection=>({id:connection.id,provider:'shopify',storeDomain:connection.provider_account_id,environment:connection.environment,status:connection.status,scopes:parseJson(connection.granted_scopes,[]),simulated:true,live:'setup_required'})));
    }
    if(path==='/api/commerce/v2/shopify/simulation-connections'&&method==='POST'){
      ensureOutsidePilot();
      if(!safeDomain(body.storeDomain))throw new HttpError(422,'Enter an exact myshopify.com domain.');
      if(Array.isArray(body.scopes)&&body.scopes.some(scope=>!SCOPES.includes(scope)))throw new HttpError(422,'Requested Shopify simulation scopes contain unsupported values.');
      const scopes=Array.isArray(body.scopes)?[...new Set(body.scopes)]:['read_products','write_products','read_inventory','write_inventory','read_orders'];
      if(!scopes.includes('read_products')||!scopes.includes('write_products'))throw new HttpError(422,'Simulation catalog needs read_products and write_products scopes.');
      const connectionId=id('conn'),at=now(),config=JSON.stringify({fixture:true,identityVerified:true,setupSource:'local_fixture',verifiedStoreDomain:body.storeDomain.toLowerCase(),fixtureData:{}});
      const inserted=await transaction(()=>repositories.foundation.insertSimulationShopifyConnection(connectionId,org.id,body.storeDomain.toLowerCase(),JSON.stringify(scopes),config,at,at));
      const connection=await repositories.foundation.findSimulationShopifyConnection(org.id,body.storeDomain.toLowerCase());
      const readinessContext={orgId:org.id,connectionId:connection.id,provider:'shopify',providerAccountId:connection.provider_account_id,environment:'simulation',scopes:parseJson(connection.granted_scopes,[]),verified:parseJson(connection.config).identityVerified===true};
      try {
        const probation=await runShopifyCatalogWriteProbation(readinessContext);
        const revision=await currentPolicyRevision(org.id);
        await transaction(()=>repositories.foundation.upsertProviderToolReadiness(org.id,'shopify.product.set',connection.id,'shopify.product.set',JSON.stringify(['read_products','write_products']),'shopify-fixture-product-set-v1','shopify-fixture-readback-v1','ready',probation.passed?'passed':'failed',at,revision));
      } catch {
        await transaction(()=>repositories.foundation.setProviderToolReadinessUnavailable(at,org.id,'shopify.product.set',connection.id));
      }
      return sendJson(response,inserted?.changes?201:200,{id:connection.id,provider:'shopify',storeDomain:connection.provider_account_id,environment:'simulation',status:'connected',scopes:parseJson(connection.granted_scopes,[]),simulated:true,live:'setup_required'});
    }
    if(path==='/api/commerce/v2/shopify/simulation-subscriptions'&&method==='POST'){
      ensureOutsidePilot();
      const connection=await connectionFor(org.id,String(body.connectionId||''));const config=parseJson(connection.config);
      if(connection.environment!=='simulation'||connection.status!=='connected'||!config.fixture||config.identityVerified!==true)throw new HttpError(409,'Only a verified local simulation connection can receive fixture subscriptions.');
      if(body.eventType!=='orders/paid'||body.capability!=='commerce.order.analyze')throw new HttpError(422,'Only the read-only simulated paid-order analysis subscription is available.');
      const employee=await repositories.foundation.findEmployeeDeploymentForDispatch(org.id,String(body.employeeId||''));
      if(!employee||employee.state!=='active'||!employee.deployment_id)throw new HttpError(409,'Deploy the selected employee before authorizing an event subscription.');
      const spec=parseJson(employee.spec_data,{});const capability=Array.isArray(spec.capabilities)&&spec.capabilities.some(item=>(typeof item==='string'?item:item?.key||item?.name)==='commerce.order.analyze');
      if(!capability)throw new HttpError(403,'The employee does not have the commerce.order.analyze capability grant.');
      const readiness=await repositories.foundation.findReadinessForEventCapability(org.id,'commerce.order.analyze',connection.id);
      const revision=await currentPolicyRevision(org.id);
      if(!readiness||readiness.readiness_state!=='ready'||readiness.probation_state!=='passed'||readiness.policy_revision!==revision||!readiness.handler_id||!readiness.verifier_id)throw new HttpError(409,'Read-only capability readiness and representative probation are required before subscribing.','readiness_required');
      const requiredScopes=['read_orders'];const grantedScopes=parseJson(connection.granted_scopes,[]);
      if(requiredScopes.some(scope=>!grantedScopes.includes(scope)))throw new HttpError(403,'The simulation connection lacks read_orders scope.','scope_missing');
      const existing=await repositories.foundation.findEventSubscription(org.id,connection.id,employee.id,'orders/paid');
      const principal=await repositories.foundation.findOrInsertEventServicePrincipal(existing?.principal_id||id('principal'),org.id,'CrewOS event dispatcher',now());
      const subscriptionId=existing?.id||id('subscription');
      await transaction(()=>repositories.foundation.insertEventSubscription(subscriptionId,org.id,principal.id,employee.id,connection.id,'orders/paid','commerce.order.analyze',user.id,JSON.stringify(requiredScopes),capabilityGrantFingerprint('commerce.order.analyze',employee.version),now(),now()));
      const subscription=await repositories.foundation.findEventSubscription(org.id,connection.id,employee.id,'orders/paid');
      return sendJson(response,existing?200:201,{id:subscription.id,connectionId:connection.id,employeeId:employee.id,eventType:'orders/paid',capability:'commerce.order.analyze',principal:{id:principal.id,kind:principal.kind},authorizedBy:user.id,enabled:Boolean(subscription.enabled),environment:'simulation',simulated:true});
    }
    const route=path.match(/^\/api\/commerce\/v2\/shopify\/connections\/([^/]+)(?:\/(catalog|themes|orders))?$/);
    if(!route)throw new HttpError(404,'Commerce route not found.');
    const [,connectionId,resource]=route;const connection=await connectionFor(org.id,connectionId);const config=parseJson(connection.config);
    if(method==='GET'&&!resource)return sendJson(response,200,{id:connection.id,provider:'shopify',storeDomain:connection.provider_account_id,environment:connection.environment,status:connection.status,scopes:parseJson(connection.granted_scopes,[]),simulated:Boolean(config.fixture),live:'setup_required'});
    if(resource==='catalog'&&method==='POST'){
      ensureOutsidePilot();
      if(connection.environment==='simulation'&&config.fixture===true){
        const products=Array.isArray(body.products)?body.products:body.product?[body.product]:null;
        if(!products||products.length<1||products.length>20)throw new HttpError(422,'Provide 1 to 20 products.','catalog_invalid');
        const key=String(request?.headers?.['idempotency-key']||body.idempotencyKey||'').trim();
        if(key.length>128)throw new HttpError(422,'Idempotency key must be at most 128 characters.','idempotency_invalid');
        const normalized=products.map((product,index)=>{
          if(!product||typeof product!=='object'||Array.isArray(product))throw new HttpError(422,`Product ${index+1} must be an object.`,'catalog_invalid');
          const title=String(product.title||'').trim(),variants=product.variants;
          if(!title||title.length>120||!Array.isArray(variants)||variants.length<1||variants.length>20)throw new HttpError(422,`Product ${index+1} needs a title and 1 to 20 variants.`,'catalog_invalid');
          const cleanVariants=variants.map(v=>{if(!v||typeof v.sku!=='string'||!v.sku.trim()||v.sku.length>64||!Number.isSafeInteger(v.priceMinor)||v.priceMinor<0||!/^[A-Z]{3}$/.test(v.currency||''))throw new HttpError(422,'Each variant needs a SKU, non-negative integer priceMinor, and three-letter currency.','catalog_invalid');return {sku:v.sku.trim(),priceMinor:v.priceMinor,currency:v.currency};});
          return {id:String(product.id||`sim-${index}-${cleanVariants[0].sku}`).slice(0,128),title,variants:cleanVariants};
        });
        const existing=(await repositories.foundation.findCommerceCatalogByConnection(org.id,connection.id)).map(row=>parseJson(row.product_json));
        const incomingHash=JSON.stringify(normalized);
        const prior=config.fixtureData?.catalogWrites?.[key];
        if(key&&prior){if(prior!==incomingHash)throw new HttpError(409,'Idempotency key is already bound to different catalog input.','idempotency_conflict');return sendJson(response,200,{products:existing,source:'local_projection',simulated:true,replayed:true});}
        const at=now();
        await transaction(async()=>{for(const p of normalized)await repositories.foundation.upsertCommerceCatalogProjection(id('product'),org.id,connection.id,'simulation',p.id,JSON.stringify(p),at);});
        const saved=(await repositories.foundation.findCommerceCatalogByConnection(org.id,connection.id)).map(row=>parseJson(row.product_json));
        return sendJson(response,201,{products:saved,source:'local_projection',simulated:true});
      }
      throw new HttpError(409,'Product writes must run through a deployed employee workflow and manager approval; this route is read-only.','workflow_approval_required');
    }
    if(resource==='themes'&&method==='POST'){
      ensureOutsidePilot();
      const built=buildLocalShopifyTheme({files:body.files,brand:body.brand||{},products:Array.isArray(body.products)?body.products:[]});const prior=await repositories.foundation.findLatestStorefrontRevision(org.id,connection.id);const revision=Number(prior?.revision||0)+1;const revisionId=id('theme');
      const inserted=await repositories.foundation.insertStorefrontRevision(revisionId,org.id,connection.id,built.templateId,revision,built.artifactHash,JSON.stringify(built.files),JSON.stringify(built.localChecks),context.user.id,now());
      if(inserted?.changes!==1)throw new HttpError(409,'Theme revision was not created. Retry with a new request.');
      return sendJson(response,201,{id:revisionId,revision,artifactHash:built.artifactHash,files:Object.keys(built.files),localChecks:built.localChecks,preview:built.preview,publishing:built.publishing,simulated:true});
    }
    if(resource==='themes'&&method==='GET')return sendJson(response,200,await repositories.foundation.findStorefrontRevisions(org.id,connection.id));
    if(resource==='orders'&&method==='GET')return sendJson(response,200,{orders:await repositories.foundation.findCanonicalOrdersByConnection(org.id,connection.id),source:'canonical_order_projection',simulated:connection.environment==='simulation'});
    if(resource==='catalog'&&method==='GET'){
      if(connection.environment==='simulation'||config.fixture===true)return sendJson(response,200,{products:(await repositories.foundation.findCommerceCatalogByConnection(org.id,connection.id)).map(row=>({...parseJson(row.product_json),verifiedAt:row.verified_at,environment:row.environment,simulated:Boolean(row.simulated)})),source:'local_projection'});
      ensureLiveReadAllowed();
      if(!shopifyCatalogApi?.credentialResolver||typeof shopifyCatalogApi.fetch!=='function')throw new HttpError(503,'Verified Shopify catalog reads are setup-required on this server.','shopify_catalog_setup_required');
      const verifiedConnection=await repositories.foundation.findShopifyConnectionByOrgAndId(org.id,connection.id,now());
      const verifiedConfig=parseJson(verifiedConnection?.config,{});
      if(!verifiedConnection||verifiedConnection.org_id!==org.id||verifiedConnection.id!==connection.id||verifiedConnection.provider!=='shopify'||
          verifiedConnection.status!=='connected'||Number(verifiedConnection.credential_ready)!==1||verifiedConfig.identityVerified!==true||verifiedConfig.verifiedStoreDomain!==verifiedConnection.provider_account_id||
          !Array.isArray(parseJson(verifiedConnection.granted_scopes,[]))||!parseJson(verifiedConnection.granted_scopes,[]).includes('read_products')){
        throw new HttpError(503,'Shopify connection is not verified and ready for read_products.','shopify_catalog_not_ready');
      }
      const adapter=createShopifyAdminGraphqlAdapter({orgId:org.id,expectedOrgId:org.id,expectedConnectionId:connection.id,connection:verifiedConnection,
        environment:verifiedConnection.environment,apiVersion:shopifyCatalogApi.apiVersion,credentialResolver:shopifyCatalogApi.credentialResolver,
        transport:{mode:'live_read_only',request:({url,method,headers,body:requestBody,signal})=>shopifyCatalogApi.fetch(url,{method,headers,body:JSON.stringify(requestBody),signal,redirect:'error',cache:'no-store'})}});
      try{return sendJson(response,200,await adapter.readVerifiedCatalogPage(catalogPageInput(request)));}
      catch(error){throw new HttpError(error.status||502,error.message||'Shopify catalog read failed.',error.code||'shopify_catalog_read_failed');}
    }
    throw new HttpError(404,'Commerce route not found.');
  }};
}
