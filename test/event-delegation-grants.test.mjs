import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFoundationRepository } from '../backend/src/repositories/foundation-repository.mjs';

const at='2026-10-31T00:00:00.000Z';

test('event delegation grants default to none, bind the delegated capability and exact subscription scope, and revoke by version CAS', async()=>{
  const directory=mkdtempSync(join(tmpdir(),'crewos-event-grants-'));
  const filename=join(directory,'test.sqlite');
  try {
    const init=spawnSync(process.execPath,['--input-type=module','-e',"import {closeDatabase} from './backend/lib/db.mjs'; await closeDatabase();"],{
      cwd:process.cwd(),encoding:'utf8',env:{...process.env,DATABASE_FILE:filename,DATABASE_URL:'',NODE_ENV:'test'},
    });
    assert.equal(init.status,0,init.stderr);
    const db=new DatabaseSync(filename);db.exec('PRAGMA foreign_keys=ON');
    try {
      db.prepare('INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)').run('org','Org',at);
      db.prepare('INSERT INTO users(id,name,email,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)').run('manager','Manager','manager@example.test','salt','hash',at);
      db.prepare('INSERT INTO memberships(org_id,user_id,role,created_at) VALUES(?,?,?,?)').run('org','manager','owner',at);
      const insertEmployee=db.prepare('INSERT INTO employees(id,org_id,name,title,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
      insertEmployee.run('source','org','Source','Analyst','active',at,at);insertEmployee.run('target','org','Target','Support','active',at,at);
      db.prepare("INSERT INTO provider_connections(id,org_id,provider,provider_account_id,environment,status,granted_scopes,config,created_at,updated_at) VALUES('conn','org','shopify','fixture.myshopify.com','simulation','connected','[]','{}',?,?)").run(at,at);
      db.prepare("INSERT INTO service_principals(id,org_id,kind,name,status,created_at) VALUES('principal','org','org_service','events','active',?)").run(at);
      db.prepare("INSERT INTO event_subscriptions(id,org_id,principal_id,employee_id,connection_id,event_type,filter_json,required_capability,authorized_by,enabled,created_at,updated_at) VALUES('sub','org','principal','source','conn','orders/paid','{}','commerce.order.analyze','manager',1,?,?)").run(at,at);
      const repository=createFoundationRepository({
        all:async(sql,...params)=>db.prepare(sql).all(...params),
        get:async(sql,...params)=>db.prepare(sql).get(...params),
        run:async(sql,...params)=>db.prepare(sql).run(...params),
      });
      const scope={orgId:'org',sourceEmployeeId:'source',capability:'commerce.order.analyze',delegatedCapability:'support.case.triage',scope:'event',subscriptionId:'sub',principalId:'principal',connectionId:'conn',environment:'simulation'};
      assert.deepEqual(await repository.findActiveEmployeeDelegationGrants(scope),[]);
      assert.equal(await repository.createEventDelegationGrant('grant','org','source','target','commerce.order.analyze','support.case.triage','sub','principal','conn','simulation','manager','manager','{}','source-spec-3','source-deploy-a','target-spec-2','target-deploy-b',at,at),1);
      const [grant]=await repository.findActiveEmployeeDelegationGrants(scope);
      assert.equal(grant.target_employee_id,'target');
      assert.equal(grant.delegated_capability,'support.case.triage');
      assert.deepEqual(await repository.findActiveEmployeeDelegationGrants({...scope,connectionId:'other'}),[]);
      assert.deepEqual(await repository.findActiveEmployeeDelegationGrants({...scope,subscriptionId:'other'}),[]);
      assert.equal(await repository.revokeEmployeeDelegationGrant('org','grant',0,'manager',at),0);
      assert.equal(await repository.revokeEmployeeDelegationGrant('org','grant',1,'manager',at),1);
      assert.deepEqual(await repository.findActiveEmployeeDelegationGrants(scope),[]);
      assert.equal((await repository.findEmployeeDelegationGrant('org','grant')).version,2);
    } finally { db.close(); }
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
