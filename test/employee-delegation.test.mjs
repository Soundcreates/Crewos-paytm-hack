import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createFoundationRepository } from '../backend/src/repositories/foundation-repository.mjs';
import { createEmployeeDelegationService } from '../backend/src/services/employee-delegation.mjs';

const stamp = '2026-10-31T00:00:00.000Z';
const selector = createEmployeeDelegationService();

function candidate(id, patch = {}) {
  return {
    id, employeeId: id, profileId: `profile-${id}`, orgId: 'org_a', state: 'active', spec: { capabilities: ['reports.read'] }, specRevision: 's1', deploymentRevision: 'd1',
    readinessState: 'ready', probationState: 'passed', policyAllowed: true, riskAllowed: true,
    grant: { state: 'active', managerAuthorized: true, authorizedByUserId: 'manager', managerSignerUserId: 'manager', scope: 'employee', sourceEmployeeId: 'source', targetEmployeeId: id, capability: 'reports.read', sourceSpecRevision: 's1', sourceDeploymentRevision: 'd1', targetSpecRevision: 's1', targetDeploymentRevision: 'd1' },
    ...patch,
  };
}
const source = { id: 'source', orgId: 'org_a', state: 'active', spec: { capabilities: ['reports.read'], coworkers: ['profile-target-b', 'profile-target-a'] }, specRevision: 's1', deploymentRevision: 'd1' };

test('profile membership does not grant capability and unauthorized or stale grants are rejected', () => {
  assert.equal(selector.selectCoworker({ source, capability: 'reports.read', candidates: [candidate('outside')] }).outcome, 'unavailable');
  assert.equal(selector.selectCoworker({ source, capability: 'reports.write', candidates: [candidate('target-a')] }).outcome, 'unavailable');
  assert.equal(selector.selectCoworker({ source, capability: 'reports.read', candidates: [candidate('target-a', { spec: { capabilities: ['reports.write'] } })] }).outcome, 'unavailable');
  assert.equal(selector.selectCoworker({ source, capability: 'reports.read', candidates: [candidate('target-a', { grant: { ...candidate('target-a').grant, state: 'revoked' } })] }).outcome, 'unavailable');
  assert.equal(selector.selectCoworker({ source, capability: 'reports.read', candidates: [candidate('target-a', { specRevision: 's2' })] }).outcome, 'unavailable');
  assert.equal(selector.selectCoworker({ source, capability: 'reports.read', candidates: [candidate('target-a', { grant: { ...candidate('target-a').grant, managerAuthorized: false } })] }).outcome, 'unavailable', 'a revoked manager membership must not authorize delegation');
});

test('coworker profile IDs authorize the profile while grants bind the distinct employee ID', () => {
  const coworker = candidate('employee-42', {
    profileId: 'coworker-profile-7',
    grant: { ...candidate('employee-42').grant, targetEmployeeId: 'employee-42' },
  });
  const profileSource = { ...source, spec: { ...source.spec, coworkers: ['coworker-profile-7'] } };
  assert.equal(coworker.profileId, 'coworker-profile-7');
  assert.notEqual(coworker.profileId, coworker.employeeId);
  assert.equal(selector.selectCoworker({ source: profileSource, capability: 'reports.read', candidates: [coworker] }).candidate.employeeId, 'employee-42');
  assert.equal(selector.selectCoworker({ source: profileSource, capability: 'reports.read', candidates: [candidate('employee-42', { profileId: 'employee-42' })] }).outcome, 'unavailable');
});

test('manager grants must match event scope and current readiness, policy, and risk facts', () => {
  const eventScope = { scope: 'event', subscriptionId: 'sub-1', principalId: 'principal-1', connectionId: 'conn-1', environment: 'simulation' };
  const eventCandidate = candidate('target-a', { grant: { ...candidate('target-a').grant, scope: 'event', subscriptionId: 'sub-1', principalId: 'principal-1', connectionId: 'conn-1', environment: 'simulation' } });
  assert.equal(selector.selectCoworker({ source, capability: 'reports.read', scope: eventScope, candidates: [eventCandidate] }).outcome, 'selected');
  assert.equal(selector.selectCoworker({ source, capability: 'reports.read', scope: { ...eventScope, connectionId: 'conn-2' }, candidates: [eventCandidate] }).outcome, 'unavailable');
  assert.equal(selector.selectCoworker({ source, capability: 'reports.read', candidates: [candidate('target-a', { readinessState: 'blocked' })] }).outcome, 'unavailable');
  assert.equal(selector.selectCoworker({ source, capability: 'reports.read', candidates: [candidate('target-a', { probationState: 'failed' })] }).outcome, 'unavailable');
  assert.equal(selector.selectCoworker({ source, capability: 'reports.read', candidates: [candidate('target-a', { policyAllowed: false })] }).outcome, 'unavailable');
  assert.equal(selector.selectCoworker({ source, capability: 'reports.read', candidates: [candidate('target-a', { riskAllowed: false })] }).outcome, 'unavailable');
});

test('selection tie-break is stable and a busy winner remains pending without reassignment', () => {
  const a = candidate('target-a');
  const b = candidate('target-b');
  assert.equal(selector.selectCoworker({ source, capability: 'reports.read', candidates: [b, a] }).candidate.id, 'target-a');
  const busy = selector.selectCoworker({ source, capability: 'reports.read', candidates: [b, candidate('target-a', { busy: true })] });
  assert.deepEqual({ outcome: busy.outcome, id: busy.candidate.id }, { outcome: 'pending_busy', id: 'target-a' });
  assert.equal(selector.selectCoworker({ source, capability: 'reports.read', goal: 'refund report', candidates: [candidate('target-a', { expertise: ['refund reporting'] }), candidate('target-b', { expertise: ['inventory'] })] }).candidate.id, 'target-a');
});

function migratedDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'crewos-delegation-'));
  const filename = join(directory, 'test.sqlite');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import {closeDatabase} from './backend/lib/db.mjs'; await closeDatabase();"], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, DATABASE_FILE: filename, DATABASE_URL: '', NODE_ENV: 'test' },
  });
  assert.equal(result.status, 0, result.stderr);
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys=ON');
  return { db, directory };
}

function setupRows(db) {
  for (const id of ['org_a', 'org_b']) db.prepare('INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)').run(id, id, stamp);
  db.prepare('INSERT INTO users(id,name,email,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)').run('manager', 'Manager', 'm@x.test', 'salt', 'hash', stamp);
  db.prepare('INSERT INTO memberships(org_id,user_id,role,created_at) VALUES(?,?,?,?)').run('org_a', 'manager', 'owner', stamp);
  const insertEmployee = db.prepare('INSERT INTO employees(id,org_id,name,title,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
  for (const [id,org] of [['source','org_a'],['target','org_a'],['foreign','org_b']]) insertEmployee.run(id, org, id, 'Analyst', 'active', stamp, stamp);
  const insertTask = db.prepare(`INSERT INTO crew_tasks(id,org_id,workflow_id,owner_employee_id,capability,goal,state,idempotency_key,correlation_id,spec_version,runtime_version,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  db.prepare(`INSERT INTO workflows(id,org_id,employee_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
    .run('real-workflow', 'org_a', 'target', 'manager', 'completed delegation', 'completed', stamp, stamp);
  insertTask.run('parent', 'org_a', null, 'source', 'reports.read', 'parent', 'running', 'parent-key', 'parent-corr', 1, 'test', stamp, stamp);
  insertTask.run('fake', 'org_a', null, 'target', 'reports.read', 'fake synthetic', 'completed', 'fake-key', 'fake-corr', 1, 'test', stamp, stamp);
  insertTask.run('real', 'org_a', 'real-workflow', 'target', 'reports.read', 'child result', 'completed', 'real-key', 'real-corr', 1, 'test', stamp, stamp);
}

test('SQLite delegation grants default deny, bind exact scope, revoke with CAS, and reject cross-org lookups', async () => {
  const { db, directory } = migratedDatabase();
  try {
    setupRows(db);
    const repository = createFoundationRepository({
      all: async (sql, ...params) => db.prepare(sql).all(...params),
      get: async (sql, ...params) => db.prepare(sql).get(...params),
      run: async (sql, ...params) => db.prepare(sql).run(...params),
    });
    assert.deepEqual(await repository.findActiveEmployeeDelegationGrants({ orgId: 'org_a', sourceEmployeeId: 'source', capability: 'reports.read' }), []);
    assert.equal(await repository.createEmployeeDelegationGrant('general','org_a','employee','source','target','reports.read',null,null,null,null,'manager','manager','{}','s1','d1','s1','d1',stamp,stamp), 1);
    assert.equal((await repository.findActiveEmployeeDelegationGrants({ orgId: 'org_a', sourceEmployeeId: 'source', capability: 'reports.read' })).length, 1);
    assert.equal(await repository.findEmployeeDelegationGrant('org_b', 'general'), undefined);
    assert.equal(await repository.revokeEmployeeDelegationGrant('org_a','general',0,'manager',stamp), 0);
    assert.equal(await repository.revokeEmployeeDelegationGrant('org_a','general',1,'manager',stamp), 1);
    assert.equal(await repository.revokeEmployeeDelegationGrant('org_a','general',1,'manager',stamp), 0);
    assert.equal((await repository.findEmployeeDelegationGrant('org_a','general')).version, 2);
    db.prepare(`INSERT INTO service_principals(id,org_id,kind,name,status,created_at) VALUES('principal','org_a','event','test','active',?)`).run(stamp);
    db.prepare(`INSERT INTO provider_connections(id,org_id,provider,provider_account_id,environment,status,granted_scopes,config,created_at,updated_at) VALUES('connection','org_a','test','acct','simulation','connected','[]','{}',?,?)`).run(stamp,stamp);
    db.prepare(`INSERT INTO event_subscriptions(id,org_id,principal_id,employee_id,connection_id,event_type,filter_json,required_capability,authorized_by,enabled,created_at,updated_at)
      VALUES('subscription','org_a','principal','source','connection','test.event','{}','reports.read','manager',1,?,?)`).run(stamp,stamp);
    assert.equal(await repository.createEmployeeDelegationGrant('event-grant','org_a','event','source','target','reports.read','subscription','principal','connection','simulation','manager','manager','{}','s1','d1','s1','d1',stamp,stamp), 1);
    const eventQuery = { orgId: 'org_a', sourceEmployeeId: 'source', capability: 'reports.read', scope: 'event', subscriptionId: 'subscription', principalId: 'principal', connectionId: 'connection', environment: 'simulation' };
    assert.deepEqual((await repository.findActiveEmployeeDelegationGrants(eventQuery)).map((row) => row.id), ['event-grant']);
    assert.deepEqual(await repository.findActiveEmployeeDelegationGrants({ ...eventQuery, connectionId: 'other' }), []);
    assert.throws(() => db.prepare(`INSERT INTO employee_delegation_grants(id,org_id,grant_scope,source_employee_id,target_employee_id,capability,manager_signer_user_id,authorized_by_user_id,source_spec_revision,source_deployment_revision,target_spec_revision,target_deployment_revision,created_at,updated_at)
      VALUES('bad-event','org_a','event','source','target','reports.read','manager','manager','s1','d1','s1','d1',?,?)`).run(stamp,stamp));
    assert.throws(() => db.prepare(`INSERT INTO task_delegations(id,org_id,parent_task_id,child_task_id,delegation_slot,request_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run('cross','org_b','parent','real','slot','hash',stamp,stamp));
  } finally {
    db.close(); rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite delegation slots are idempotent, hash fenced, and reject synthetic completed evidence', async () => {
  const { db, directory } = migratedDatabase();
  try {
    setupRows(db);
    const repository = createFoundationRepository({
      all: async (sql, ...params) => db.prepare(sql).all(...params),
      get: async (sql, ...params) => db.prepare(sql).get(...params),
      run: async (sql, ...params) => db.prepare(sql).run(...params),
    });
    assert.equal(await repository.createTaskDelegation('d-fake','org_a','parent','fake','slot-1','hash-1',null,stamp,stamp), 1);
    assert.equal(await repository.createTaskDelegation('d-other','org_a','parent','real','slot-1','hash-2',null,stamp,stamp), 0);
    assert.equal((await repository.findTaskDelegationBySlot('org_a','parent','slot-1')).request_hash, 'hash-1');
    assert.equal(await repository.findTaskDelegationById('org_b','d-fake'), undefined);
    assert.equal(await repository.resolveTaskDelegation('org_a','parent','slot-1','hash-1','reports.read','{}','{}',stamp), 0);
    assert.equal(await repository.failTaskDelegation('org_a','parent','slot-1','wrong-hash','{}',stamp), 0);
    assert.equal(await repository.createTaskDelegation('d-real','org_a','parent','real','slot-2','hash-2',null,stamp,stamp), 1);
    assert.equal(await repository.resolveTaskDelegation('org_a','parent','slot-2','wrong-hash','reports.read','{}','{}',stamp), 0);
    assert.equal(await repository.resolveTaskDelegation('org_a','parent','slot-2','hash-2','reports.write','{"proof":"real"}','{}',stamp), 0);
    assert.equal(await repository.resolveTaskDelegation('org_a','parent','slot-2','hash-2','reports.read','{"proof":"real"}','{}',stamp), 1);
    assert.equal(await repository.resolveTaskDelegation('org_a','parent','slot-2','hash-2','reports.read','{}','{}',stamp), 0);
    assert.equal((await repository.findTaskDelegationBySlot('org_a','parent','slot-2')).state, 'resolved');
  } finally {
    db.close(); rmSync(directory, { recursive: true, force: true });
  }
});
