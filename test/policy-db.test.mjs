import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildMeetingMemoryBody } from 'solari-crew-core';

const directory = mkdtempSync(join(tmpdir(), 'solari-policy-test-'));
process.env.DATABASE_FILE = join(directory, 'test.sqlite');
delete process.env.DATABASE_URL;
delete process.env.OPENROUTER_API_KEY;
delete process.env.PINECONE_API_KEY;
delete process.env.PINECONE_INDEX_HOST;

const database = await import('../backend/lib/db.mjs');
const { checkPolicy, savePolicy, seedPolicies } = await import('../backend/build/policy.js');
const { retrieveMemories, storeMemory } = await import('../backend/build/memory.js');
const orgId = 'org_test';

after(async () => {
  await database.closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

test('policy engine returns ALLOW, REQUIRE_APPROVAL, and DENY', async () => {
  await database.run(
    'INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)',
    orgId,
    'Policy test',
    database.now(),
  );
  await seedPolicies(orgId);
  const spec = { tools: ['payments.refund', 'payments.transfer', 'jira.create_issue', 'account.delete'] };

  assert.equal((await checkPolicy(orgId, spec, 'payments.refund', { amount: 500 })).decision, 'ALLOW');
  assert.equal((await checkPolicy(orgId, spec, 'payments.refund', { amount: 501 })).decision, 'REQUIRE_APPROVAL');
  for (const amount of ['not-a-number', '500', null]) assert.equal((await checkPolicy(orgId, spec, 'payments.refund', { amount })).decision, 'REQUIRE_APPROVAL', 'invalid policy inputs must not bypass a conditional approval');
  await assert.rejects(savePolicy(orgId, {
    name: 'Malformed threshold', tool: 'payments.refund', effect: 'REQUIRE_APPROVAL', condition: { amount: { gt: 'not-a-number' } },
  }), /thresholds must be finite numbers/);
  const allowRule = await savePolicy(orgId, {
    name: 'Allow small transfers', tool: 'payments.transfer', effect: 'ALLOW', condition: { amount: { lte: 500 } },
  });
  assert.equal((await checkPolicy(orgId, spec, 'payments.transfer', { amount: 100 })).reason, allowRule.name);
  await savePolicy(orgId, {
    name: 'Block issue creation',
    tool: 'jira.create_issue',
    effect: 'DENY',
  });
  assert.equal((await checkPolicy(orgId, spec, 'jira.create_issue')).decision, 'DENY');
  assert.equal((await checkPolicy(orgId, spec, 'account.delete')).decision, 'DENY');

  await database.run(
    'INSERT INTO users(id,name,email,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)',
    'user_test', 'Policy tester', 'policy@example.test', 'salt', 'hash', database.now(),
  );
  await database.run(
    'INSERT INTO employees(id,org_id,name,title,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    'emp_refund', orgId, 'Refund agent', 'Support', database.now(), database.now(),
  );
  await database.run(
    'INSERT INTO workflows(id,org_id,employee_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
    'task_refund', orgId, 'emp_refund', 'user_test', 'Check decimal refund', 'completed', database.now(), database.now(),
  );
  await database.run(
    'INSERT INTO simulated_refunds(id,org_id,workflow_id,step_index,employee_id,case_id,amount,currency,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    'refund_decimal', orgId, 'task_refund', 0, 'emp_refund', 'CASE-1', 123.45, 'USD', 'simulated', database.now(),
  );
  const refund = await database.get('SELECT amount FROM simulated_refunds WHERE id=?', 'refund_decimal');
  assert.equal(Number(refund.amount), 123.45);
});

test('transaction rolls back writes when its callback throws', async () => {
  const rolledBackOrgId = 'org_rollback';
  await assert.rejects(database.transaction(async () => {
    await database.run(
      'INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)',
      rolledBackOrgId,
      'Must roll back',
      database.now(),
    );
    throw new Error('force rollback');
  }), /force rollback/);

  assert.equal(await database.get('SELECT id FROM organizations WHERE id=?', rolledBackOrgId), undefined);
});

test('memory retrieval ranks policy evidence and verifies document excerpts', async () => {
  const memoryOrgId = 'org_memory';
  const userId = 'user_memory';
  await database.run(
    'INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)',
    memoryOrgId,
    'Memory test',
    database.now(),
  );
  await database.run(
    'INSERT INTO users(id,name,email,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)',
    userId,
    'Memory tester',
    'memory@example.test',
    'salt',
    'hash',
    database.now(),
  );
  await database.run(
    'INSERT INTO documents(id,org_id,filename,mime_type,extracted_text,created_by,created_at) VALUES(?,?,?,?,?,?,?)',
    'doc_memory',
    memoryOrgId,
    'refund-sop.txt',
    'text/plain',
    'Refunds up to 500 dollars may be processed after verification.',
    userId,
    database.now(),
  );

  await storeMemory({
    orgId: memoryOrgId,
    kind: 'policy',
    title: 'Refund limit',
    body: 'Refunds up to 500 dollars may be processed after verification.',
    source: 'document:doc_memory:refund-sop.txt',
  });
  await storeMemory({
    orgId: memoryOrgId,
    kind: 'episodic',
    title: 'Refund discussion',
    body: 'Refunds up to 500 dollars may be processed after verification.',
    source: 'manager:meeting-notes',
  });
  const ranked = await retrieveMemories({ orgId: memoryOrgId, query: 'refunds 500 verification' });
  assert.equal(ranked[0]?.kind, 'policy');
  assert.equal(ranked[0]?.source, 'document:doc_memory:refund-sop.txt');

  await assert.rejects(storeMemory({
    orgId: memoryOrgId,
    title: 'Unverified refund limit',
    body: 'Refunds above 500 dollars can be processed without approval.',
    source: 'document:doc_memory:refund-sop.txt',
  }), /must quote text from a stored document/);
});

test('failure memories require a failed workflow and its recorded reason', async () => {
  const orgId = 'org_failure_memory';
  const userId = 'user_failure_memory';
  const employeeId = 'emp_failure_memory';
  const workflowId = 'task_failure_memory';
  const goal = 'Check failed memory provenance';
  const reason = 'The provider call failed.';
  await database.run('INSERT INTO organizations(id,name,created_at) VALUES(?,?,?)', orgId, 'Failure memory test', database.now());
  await database.run('INSERT INTO users(id,name,email,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?)', userId, 'Failure tester', 'failure-memory@example.test', 'salt', 'hash', database.now());
  await database.run('INSERT INTO employees(id,org_id,name,title,created_at,updated_at) VALUES(?,?,?,?,?,?)', employeeId, orgId, 'Failure agent', 'Support', database.now(), database.now());
  await database.run('INSERT INTO workflows(id,org_id,employee_id,created_by,goal,status,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', workflowId, orgId, employeeId, userId, goal, 'failed', reason, database.now(), database.now());
  const memory = await storeMemory({ orgId, employeeId, title: goal, body: `Failed task: ${goal}\nOutcome: failed.\nReason: ${reason}`, source: `workflow-failure:${workflowId}` });
  assert.equal(memory.source, `workflow-failure:${workflowId}`);
  await assert.rejects(storeMemory({ orgId, title: goal, body: `Failed task: ${goal}\nOutcome: failed.\nReason: fabricated`, source: `workflow-failure:${workflowId}` }), /recorded reason/);
  await assert.rejects(storeMemory({ orgId, title: goal, body: `Failed task: ${goal}\nOutcome: failed.\nReason: ${reason}`, source: 'workflow-failure:missing' }), /recorded reason/);

  const steps = [{ step: 0, tool: 'payments.refund', evidence: { caseId: 'CASE-OK', amount: 500 } }];
  const result = { goal, steps, verified: true };
  await database.run('UPDATE workflows SET status=?,error=NULL,result=? WHERE id=? AND org_id=?', 'completed', JSON.stringify(result), workflowId, orgId);
  const successBody = `Completed task: ${goal}\nOutcome: verified.\nEvidence: ${JSON.stringify(steps)}`;
  const success = await storeMemory({ orgId, title: goal, body: successBody, source: `workflow:${workflowId}` });
  assert.equal(success.source, `workflow:${workflowId}`);
  await assert.rejects(storeMemory({ orgId, title: goal, body: `${successBody}\nFabricated: refund approved`, source: `workflow:${workflowId}` }), /recorded evidence/);

  const meetingId = 'meeting_memory';
  const agenda = ['Review refund outcomes'];
  const positions = [{ agendaItem: agenda[0], employeeId, position: 'Keep refunds above $500 in manager review.', evidenceIds: [] }];
  const decisions = ['Manager approval remains required above $500.'];
  const actions = [{ employeeId, title: 'Update the refund checklist.' }];
  await database.run('INSERT INTO meetings(id,org_id,title,agenda,participant_ids,status,decisions,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', meetingId, orgId, 'Refund memory meeting', JSON.stringify(agenda), JSON.stringify([employeeId]), 'completed', JSON.stringify({ positions, decisions, actions }), userId, database.now(), database.now());
  const meetingBody = buildMeetingMemoryBody({ agenda, positions, decisions, actions });
  const meetingMemory = await storeMemory({ orgId, kind: 'meeting', title: 'Meeting: Refund memory meeting', body: meetingBody, source: `meeting:${meetingId}` });
  assert.equal(meetingMemory.source, `meeting:${meetingId}`);
  await assert.rejects(storeMemory({ orgId, kind: 'meeting', title: 'Meeting: Refund memory meeting', body: `${meetingBody}\nFabricated decision`, source: `meeting:${meetingId}` }), /recorded agenda, decisions/);
  await assert.rejects(storeMemory({ orgId, kind: 'policy', title: 'Meeting: Refund memory meeting', body: meetingBody, source: `meeting:${meetingId}` }), /recorded agenda, decisions/);
});
