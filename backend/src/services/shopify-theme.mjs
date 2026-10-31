import { createHash } from 'node:crypto';

const allowedPaths=new Set(['layout/theme.liquid','templates/index.json','config/settings_data.json','assets/crewos.css','sections/crewos-hero.liquid']);
const digest=value=>createHash('sha256').update(value).digest('hex');
const defaultFiles={
  'layout/theme.liquid':'<!doctype html><html lang="en"><head>{{ content_for_header }}</head><body>{{ content_for_layout }}{{ content_for_footer }}</body></html>',
  'templates/index.json':'{"sections":{"main":{"type":"crewos-hero","settings":{}}},"order":["main"]}',
  'config/settings_data.json':'{"current":{},"presets":{}}',
  'assets/crewos.css':'.crewos-hero{max-width:72rem;margin:0 auto;padding:3rem 1.5rem}',
  'sections/crewos-hero.liquid':'<section class="crewos-hero"><h1>{{ section.settings.heading | escape }}</h1></section>',
};

export function validateThemeFiles(files) {
  if(!files||typeof files!=='object'||Array.isArray(files)||!Object.keys(files).length||Object.keys(files).length>20)throw Object.assign(new Error('Theme revision must contain 1 to 20 files.'),{code:'theme_files_invalid'});
  const normalized={};
  for(const [path,content] of Object.entries(files)){
    if(!allowedPaths.has(path)||path.startsWith('/')||path.split('/').includes('..')||typeof content!=='string'||content.length>200000)throw Object.assign(new Error(`Theme file is outside the local template allowlist: ${path}`),{code:'theme_path_rejected'});
    if(path.endsWith('.json'))try{JSON.parse(content);}catch{throw Object.assign(new Error(`Theme JSON is invalid: ${path}`),{code:'theme_syntax_invalid'});}
    if(path.endsWith('.liquid')){const opens=[...content.matchAll(/\{%\s*(if|unless|for|case|form|capture|paginate|comment)\b/g)].length;const closes=[...content.matchAll(/\{%\s*end(if|unless|for|case|form|capture|paginate|comment)\s*%\}/g)].length;if(opens!==closes)throw Object.assign(new Error(`Liquid block balance failed: ${path}`),{code:'theme_syntax_invalid'});}
    normalized[path]=content;
  }
  const localChecks={passed:true,checks:['allowlisted_paths','json_parse','liquid_block_balance'],files:Object.keys(normalized).sort(),executedLocally:true,providerCalls:0};
  return {files:normalized,localChecks,artifactHash:digest(JSON.stringify(Object.keys(normalized).sort().map(path=>[path,normalized[path]])))};
}

export function buildLocalShopifyTheme({files=defaultFiles,brand={},products=[]}={}) {
  const source=structuredClone(files);
  if(source['sections/crewos-hero.liquid']&&brand.name)source['sections/crewos-hero.liquid']=source['sections/crewos-hero.liquid'].replace('section.settings.heading',`'${String(brand.name).replaceAll("'","&#39;")}'`);
  const result=validateThemeFiles(source);
  return {...result,templateId:'crewos-local-storefront-v1',preview:{kind:'local_artifact',url:null,simulated:true},catalogContext:products.map(({localId,title})=>({localId,title})),publishing:{available:false,reason:'setup_required: verified live connection and immutable manager approval required'}};
}

export function approvalMatchesThemeRevision(approval,revision) {
  return Boolean(approval&&revision&&approval.orgId===revision.orgId&&approval.connectionId===revision.connectionId&&approval.environment===revision.environment&&approval.artifactHash===revision.artifactHash&&approval.revision===revision.revision&&approval.state==='approved');
}
