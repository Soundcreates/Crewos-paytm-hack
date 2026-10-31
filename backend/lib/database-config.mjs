import { validateNeonBranchPair } from './neon-auth.mjs';

const localDevelopmentHosts=new Set(['localhost','127.0.0.1','::1','postgres','crewos-postgres','host.docker.internal']);
export function validateDatabaseConfiguration({databaseUrl='',neonAuthBaseUrl='',nodeEnv='development'}={}) {
  const db=String(databaseUrl||'').trim(),auth=String(neonAuthBaseUrl||'').trim();
  if(nodeEnv==='production'&&!db)throw new Error('DATABASE_URL is required in production; SQLite is for local development.');
  if(auth&&!db)throw new Error('NEON_AUTH_BASE_URL requires DATABASE_URL so auth and app data use the same Neon project.');
  if(!db)return {kind:'sqlite',databaseUrl:'',neonAuthBaseUrl:''};
  let parsed;try{parsed=new URL(db);}catch{throw new Error('DATABASE_URL must be a valid PostgreSQL URL.');}
  if(!['postgres:','postgresql:'].includes(parsed.protocol))throw new Error('DATABASE_URL must use PostgreSQL.');
  if(auth){validateNeonBranchPair(db,auth);return {kind:'neon',databaseUrl:db,neonAuthBaseUrl:auth};}
  const hostname=parsed.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(nodeEnv!=='development'||!localDevelopmentHosts.has(hostname))throw new Error('PostgreSQL without Neon Auth is allowed only in development and only on a configured local host.');
  return {kind:'local_postgres',databaseUrl:db,neonAuthBaseUrl:''};
}
