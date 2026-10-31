import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

if (!process.argv.includes('--confirm-disposable-postgres')) throw new Error('This check creates and removes an isolated local Docker test database. Pass --confirm-disposable-postgres to run.');
const suffix=`${process.pid}-${Date.now()}`, network=`crewos-check-${suffix}`, postgres=`crewos-pg-${suffix}`, model=`crewos-model-${suffix}`;
const workers=[`crewos-worker-a-${suffix}`,`crewos-worker-b-${suffix}`];
const root=resolve(import.meta.dirname,'..');
const appImage=process.env.CREWOS_ACCEPTANCE_IMAGE || 'crewos:completion';
const dbImage='postgres:17-bookworm';
const databaseUrl='postgresql://crewos:acceptance-only-password@ep-local.us-east-1.aws.neon.tech:5432/crewos';
const env={NODE_ENV:'development',DATABASE_URL:databaseUrl,NEON_AUTH_BASE_URL:'https://ep-local.neonauth.us-east-1.aws.neon.tech/crewos/auth',APP_ORIGIN:'http://localhost:4173',PILOT_MODE:'false',REQUEST_TRACE:'false',DEV_LLM_API_KEY:'local-fixture-only',DEV_LLM_MODEL:'controlled-acceptance',DEV_LLM_BASE_URL:'http://crewos-model:8080/v1',OPENROUTER_API_KEY:'',SOLARI_API_KEY:'',PINECONE_API_KEY:'',TINY_FISH_API_KEY:''};
const envArgs=Object.entries(env).flatMap(([key,value])=>['-e',`${key}=${value}`]);
const mount=['--mount',`type=bind,source=${resolve(root,'test-postgres/acceptance.mjs')},target=/app/test-postgres/acceptance.mjs,readonly`];
function docker(args,{allowFailure=false}={}) {
  const result=spawnSync('docker',args,{encoding:'utf8',timeout:90000,maxBuffer:1024*1024});
  if (!allowFailure && result.status!==0) throw new Error(`Docker operation ${args[0]} failed: ${result.stderr || result.error?.message || result.stdout}`);
  return result;
}
function acceptanceArgs(mode) { return ['run','--rm','--pull=never','--network',network,...envArgs,...mount,appImage,'node','test-postgres/acceptance.mjs',mode]; }
function concurrent(args) { return new Promise((resolvePromise,reject)=>{const child=spawn('docker',args,{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);child.on('error',reject);child.on('close',code=>code===0?resolvePromise(output):reject(new Error(output)));}); }
try {
  docker(['image','inspect',appImage]); docker(['image','inspect',dbImage]);
  docker(['network','create','--internal',network]);
  docker(['run','-d','--pull=never','--name',postgres,'--network',network,'--network-alias','ep-local.us-east-1.aws.neon.tech','-e','POSTGRES_USER=crewos','-e','POSTGRES_PASSWORD=acceptance-only-password','-e','POSTGRES_DB=crewos','--mount',`type=bind,source=${resolve(root,'backend/scripts')},target=/scripts,readonly`,dbImage]);
  for(let i=0;i<60;i++){if(docker(['exec',postgres,'pg_isready','-U','crewos'],{allowFailure:true}).status===0)break;if(i===59)throw new Error('Disposable PostgreSQL did not start.');await new Promise(resolvePromise=>setTimeout(resolvePromise,500));}
  console.log(docker(acceptanceArgs('seed')).stdout.trim());
  await Promise.all([concurrent(acceptanceArgs('schedule')),concurrent(acceptanceArgs('schedule'))]);
  console.log(docker(acceptanceArgs('pause')).stdout.trim());
  docker(['run','-d','--pull=never','--name',model,'--network',network,'--network-alias','crewos-model',...mount,appImage,'node','test-postgres/acceptance.mjs','model']);
  for(const worker of workers) docker(['run','-d','--pull=never','--name',worker,'--network',network,...envArgs,appImage,'node','backend/scripts/start-worker.mjs']);
  console.log(docker(acceptanceArgs('verify')).stdout.trim());
  for(const worker of workers) docker(['stop','--time','35',worker]);
  console.log(docker(acceptanceArgs('checkpoint-first')).stdout.trim());
  console.log(docker(acceptanceArgs('checkpoint-resume')).stdout.trim());
  docker(['exec','-e',`DATABASE_URL=${databaseUrl}`,postgres,'sh','/scripts/backup-postgres.sh','/tmp/crewos.dump']);
  docker(['exec',postgres,'createdb','-U','crewos','crewos_restore']);
  const recoveryUrl=databaseUrl.replace(/\/crewos$/,'/crewos_restore');
  const restoreArgs=['exec','-e',`DATABASE_URL=${recoveryUrl}`,postgres,'sh','/scripts/restore-postgres.sh','--confirm-empty-database','/tmp/crewos.dump'];
  docker(restoreArgs);
  const restored=docker(['exec',postgres,'psql','-U','crewos','-d','crewos_restore','-tAc','SELECT (SELECT COUNT(*) FROM workflows),(SELECT COUNT(*) FROM simulated_refunds),(SELECT COUNT(*) FROM schedule_runs)']).stdout.trim();
  assert.equal(restored,'13|13|1');
  const refused=docker(restoreArgs,{allowFailure:true});
  assert.notEqual(refused.status,0); assert.match(refused.stderr,/not empty/);
  console.log(JSON.stringify({backupRestore:'pass',workflows:13,refunds:13,scheduleRuns:1,overwriteRefused:true}));
} finally {
  for(const container of [...workers,model,postgres]) docker(['rm','-f','-v',container],{allowFailure:true});
  docker(['network','rm',network],{allowFailure:true});
}
