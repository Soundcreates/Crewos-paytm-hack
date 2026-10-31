import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const directory=mkdtempSync(join(tmpdir(),'crewos-shopify-server-load-'));
const envKeys=['NODE_ENV','PILOT_MODE','DATABASE_URL','DATABASE_FILE','NEON_AUTH_BASE_URL','APP_ORIGIN','APP_MASTER_KEY'];
const originalEnv=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
Object.assign(process.env,{NODE_ENV:'test',PILOT_MODE:'false',DATABASE_URL:'',DATABASE_FILE:join(directory,'load.sqlite'),NEON_AUTH_BASE_URL:'',APP_ORIGIN:'http://localhost:4173',APP_MASTER_KEY:'fixture-import-test-key-123456789'});
const {handleHttpRequest}=await import('../backend/server.mjs');
const {closeDatabase}=await import('../backend/lib/db.mjs');

after(async()=>{
  await closeDatabase();
  rmSync(directory,{recursive:true,force:true});
  for(const key of envKeys){if(originalEnv[key]===undefined)delete process.env[key];else process.env[key]=originalEnv[key];}
});

test('server module loads with Shopify product approval validator and canonical approval fingerprint',()=>{
  assert.equal(typeof handleHttpRequest,'function');
});
