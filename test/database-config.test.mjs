import assert from 'node:assert/strict';
import test from 'node:test';
import { validateDatabaseConfiguration } from '../backend/lib/database-config.mjs';

test('local Postgres permits development password auth only on explicit local hosts',()=>{
  assert.equal(validateDatabaseConfiguration({databaseUrl:'postgresql://crewos:dev@postgres:5432/crewos',nodeEnv:'development'}).kind,'local_postgres');
  assert.equal(validateDatabaseConfiguration({databaseUrl:'postgres://crewos:dev@127.0.0.1:5432/crewos',nodeEnv:'development'}).kind,'local_postgres');
  assert.throws(()=>validateDatabaseConfiguration({databaseUrl:'postgres://u:p@db.example.com/app',nodeEnv:'development'}),/only in development and only on a configured local host/);
  assert.throws(()=>validateDatabaseConfiguration({databaseUrl:'postgres://u:p@postgres/app',nodeEnv:'production'}),/only in development and only on a configured local host/);
});

test('production and remote Postgres still require a matching Neon Auth pair',()=>{
  assert.throws(()=>validateDatabaseConfiguration({databaseUrl:'postgres://u:p@db.example.com/app',nodeEnv:'production'}),/only in development and only on a configured local host/);
  assert.throws(()=>validateDatabaseConfiguration({neonAuthBaseUrl:'https://example.neonauth.region.aws.neon.tech/app/auth',nodeEnv:'development'}),/requires DATABASE_URL/);
  assert.equal(validateDatabaseConfiguration({databaseUrl:'',neonAuthBaseUrl:'',nodeEnv:'development'}).kind,'sqlite');
});
