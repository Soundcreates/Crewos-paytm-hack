import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';
import { formatMediaEvidence, memoryMediaType, provenanceForEditedFields } from 'solari-crew-core';

const directory = mkdtempSync(join(tmpdir(), 'crewos-hire-meeting-'));
const envKeys = ['NODE_ENV', 'DATABASE_URL', 'DATABASE_FILE', 'NEON_AUTH_BASE_URL', 'APP_ORIGIN', 'APP_MASTER_KEY', 'SOLARI_BROWSER_BASE_URL', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'OPENROUTER_EMBEDDING_MODEL', 'OPENROUTER_TRANSCRIPTION_MODEL', 'OPENROUTER_EVALUATOR_MODEL', 'PINECONE_INDEX_HOST', 'PINECONE_API_KEY'];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys) delete process.env[key];
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.DATABASE_FILE = join(directory, 'hire-meeting-flow.sqlite');
process.env.NEON_AUTH_BASE_URL = '';
process.env.APP_ORIGIN = 'http://127.0.0.1:4173';
process.env.APP_MASTER_KEY = 'offline-acceptance-test-master-key';
process.env.SOLARI_BROWSER_BASE_URL = 'https://solari.mock';

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => { throw new Error(`Unexpected external request in offline acceptance test: ${String(input)}`); };
const { handleHttpRequest } = await import('../backend/server.mjs');
const { closeDatabase, get: getDb, run: runDb } = await import('../backend/lib/db.mjs');
const { storeSecret } = await import('../backend/lib/secrets.mjs');

after(async () => {
  await closeDatabase();
  rmSync(directory, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

function mockResponse() {
  const headers = new Map();
  const listeners = new Map();
  return {
    headersSent: false,
    statusCode: 0,
    body: '',
    destroyed: false,
    writableEnded: false,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    writeHead(status, values = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(values)) this.setHeader(name, value);
      this.headersSent = true;
      return this;
    },
    end(body = '') { this.body = String(body); this.headersSent = true; },
    write(chunk) { this.body += String(chunk); this.headersSent = true; return true; },
    on(event, listener) { listeners.set(event, [...(listeners.get(event) || []), listener]); return this; },
    emit(event) { for (const listener of listeners.get(event) || []) listener(); return true; },
    destroy() { this.destroyed = true; },
    json() { return this.body ? JSON.parse(this.body) : null; },
  };
}

async function request(method, path, { body, cookie } = {}) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
  const req = Readable.from(payload ? [payload] : []);
  req.method = method;
  req.url = path;
  req.headers = {
    host: '127.0.0.1:4173',
    ...(method !== 'GET' ? { origin: process.env.APP_ORIGIN } : {}),
    ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
    ...(cookie ? { cookie } : {}),
  };
  req.socket = { encrypted: false, remoteAddress: '127.0.0.1' };
  const res = mockResponse();
  await handleHttpRequest(req, res);
  return res;
}

function sessionCookie(response) {
  const cookies = response.getHeader('set-cookie');
  const cookie = (Array.isArray(cookies) ? cookies : [cookies]).find((value) => value?.startsWith('crewos_session='));
  assert.ok(cookie, 'expected an app session cookie');
  return cookie.split(';', 1)[0];
}

function samplePdf(text) {
  const literal = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const content = Buffer.from(`BT /F1 12 Tf 72 720 Td (${literal}) Tj ET`, 'ascii');
  const stream = Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('\nendstream')]);
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    stream,
  ];
  const chunks = [Buffer.from('%PDF-1.4\n')];
  const offsets = [];
  let offset = chunks[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(offset);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
    chunks.push(chunk);
    offset += chunk.length;
  }
  const crossReferenceOffset = offset;
  chunks.push(Buffer.from(`xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${offsets.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${crossReferenceOffset}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

function employeeBody(draft, name, provenance = draft.provenance) {
  return {
    name,
    title: draft.identity.title,
    department: draft.identity.departmentId,
    mission: draft.mission,
    responsibilities: draft.responsibilities,
    successMetrics: draft.successMetrics,
    capabilities: draft.capabilities,
    tools: ['payments.refund'],
    policies: draft.policies,
    coworkers: [],
    evaluationPolicy: draft.evaluationPolicy,
    provenance,
  };
}

async function createEmployee(cookie, draft, name) {
  const created = await request('POST', '/api/employees', {
    cookie,
    body: employeeBody(draft, name),
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().spec.version, 1);
  assert.deepEqual(created.json().spec.tools, ['payments.refund']);
  assert.ok(created.json().spec.provenance.some((item) => item.field === 'responsibilities' && item.source === 'Customer Refund SOP.txt'));
  return created.json();
}

async function waitForWorkflow(cookie, workflowId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let workflow;
  while (Date.now() < deadline) {
    const response = await request('GET', `/api/workflows/${workflowId}`, { cookie });
    assert.equal(response.statusCode, 200, response.body);
    workflow = response.json();
    if (['completed', 'failed', 'cancelled', 'input_required'].includes(workflow.status)) return workflow;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`workflow did not reach a terminal state within ${timeoutMs}ms: ${JSON.stringify(workflow)}`);
}

async function waitForMemory(cookie, query, employeeId, source, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let memories = [];
  while (Date.now() < deadline) {
    const response = await request('GET', `/api/memory/search?q=${encodeURIComponent(query)}&employeeId=${encodeURIComponent(employeeId)}`, { cookie });
    assert.equal(response.statusCode, 200, response.body);
    memories = response.json();
    const memory = memories.find((item) => item.source === source);
    if (memory) return memory;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`memory ${source} was not retrievable within ${timeoutMs}ms: ${JSON.stringify(memories)}`);
}

test('offline hiring, refund probation, deployment, meeting outcome, and tenant isolation work end to end', async () => {
  const ownerSignup = await request('POST', '/api/auth/signup', {
    body: { name: 'Workspace Owner', email: 'flow-owner@example.test', password: 'owner-password-123', organization: 'Hire Meeting Flow' },
  });
  assert.equal(ownerSignup.statusCode, 201, ownerSignup.body);
  const ownerCookie = sessionCookie(ownerSignup);
  const orgId = ownerSignup.json().organization.id;

  const sop = [
    'Customer Refund Standard Operating Procedure',
    'Review the original payment and verify the customer case before taking action.',
    'Refund requests over $500 require manager approval; do not issue the refund before approval.',
    'Record the evidence, approval, and final decision in the customer case notes.',
  ].join('\n');
  const upload = await request('POST', '/api/documents', {
    cookie: ownerCookie,
    body: { filename: 'Customer Refund SOP.txt', contentBase64: Buffer.from(sop).toString('base64') },
  });
  assert.equal(upload.statusCode, 201, upload.body);
  assert.ok(upload.json().characters >= 20);
  const jobDescription = 'Customer Support Specialist job description: Resolve customer refund questions, verify payment details, and document case outcomes.';
  const jobDescriptionUpload = await request('POST', '/api/documents', {
    cookie: ownerCookie,
    body: { filename: 'Customer Support JD.pdf', contentBase64: samplePdf(jobDescription).toString('base64') },
  });
  assert.equal(jobDescriptionUpload.statusCode, 201, jobDescriptionUpload.body);
  assert.ok(jobDescriptionUpload.json().characters >= 20);

  assert.deepEqual(memoryMediaType('whiteboard.PNG'), { kind: 'image', mimeType: 'image/png' });
  assert.deepEqual(memoryMediaType('meeting.wav'), { kind: 'audio', mimeType: 'audio/wav' });
  assert.equal(memoryMediaType('clip.mp4'), null);
  assert.match(formatMediaEvidence('image', 'Quarterly revenue chart'), /^Image description:/);
  const unsupportedMedia = await request('POST', '/api/documents', { cookie: ownerCookie, body: { filename: 'diagram.svg', contentBase64: Buffer.from('<svg/>').toString('base64') } });
  assert.equal(unsupportedMedia.statusCode, 415);
  const missingMediaKey = await request('POST', '/api/documents', { cookie: ownerCookie, body: { filename: 'diagram.png', contentBase64: Buffer.from('test-image').toString('base64') } });
  assert.equal(missingMediaKey.statusCode, 503);

  const priorMediaFetch = globalThis.fetch;
  process.env.OPENROUTER_API_KEY = 'offline-media-test-key';
  globalThis.fetch = async (input, options = {}) => {
    const endpoint = String(input);
    if (endpoint.endsWith('/chat/completions')) {
      const requestBody = JSON.parse(options.body);
      const imageUrl = requestBody.messages[1].content.find((item) => item.type === 'image_url')?.image_url.url;
      assert.match(imageUrl || '', /^data:image\/png;base64,/);
      return { ok: true, status: 200, json: async () => ({ model: 'gpt-4o-mini', usage: { prompt_tokens: 12, completion_tokens: 18, total_tokens: 30 }, choices: [{ message: { content: JSON.stringify({ description: 'A blue chart shows quarterly revenue rising 18 percent.' }) } }] }) };
    }
    if (endpoint.endsWith('/audio/transcriptions')) {
      assert.equal(options.body.get('model'), 'openai/whisper-1');
      assert.equal(options.body.get('file').name, 'refund-review.wav');
      return { ok: true, status: 200, json: async () => ({ text: 'Refunds above five hundred dollars require manager approval.' }) };
    }
    if (endpoint.endsWith('/embeddings')) return { ok: true, status: 200, json: async () => ({ model: 'text-embedding-3-small', data: [{ embedding: Array(1536).fill(0) }] }) };
    throw new Error(`Unexpected media test request: ${endpoint}`);
  };
  try {
    const imageMemoryUpload = await request('POST', '/api/documents', { cookie: ownerCookie, body: { filename: 'quarterly-chart.png', contentBase64: Buffer.from('test-image').toString('base64') } });
    assert.equal(imageMemoryUpload.statusCode, 201, imageMemoryUpload.body);
    const audioMemoryUpload = await request('POST', '/api/documents', { cookie: ownerCookie, body: { filename: 'refund-review.wav', contentBase64: Buffer.from('test-audio').toString('base64') } });
    assert.equal(audioMemoryUpload.statusCode, 201, audioMemoryUpload.body);
    const savedMediaMemories = (await request('GET', '/api/memories', { cookie: ownerCookie })).json();
    const imageMemory = savedMediaMemories.find((item) => item.source === `document:${imageMemoryUpload.json().id}:quarterly-chart.png`);
    const audioMemory = savedMediaMemories.find((item) => item.source === `document:${audioMemoryUpload.json().id}:refund-review.wav`);
    assert.match(imageMemory?.body || '', /Image description:\nA blue chart shows quarterly revenue rising 18 percent\./);
    assert.match(audioMemory?.body || '', /Audio transcript:\nRefunds above five hundred dollars require manager approval\./);
    const removedMedia = await request('DELETE', `/api/documents/${imageMemoryUpload.json().id}`, { cookie: ownerCookie });
    assert.equal(removedMedia.statusCode, 200, removedMedia.body);
    assert.equal((await request('GET', '/api/memories', { cookie: ownerCookie })).json().some((item) => item.source === imageMemory.source), false);
  } finally {
    globalThis.fetch = priorMediaFetch;
    delete process.env.OPENROUTER_API_KEY;
  }

  const compilation = await request('POST', '/api/specs/compile', {
    cookie: ownerCookie,
    body: { name: 'Refund Operations Specialist', title: 'Refund Operations Specialist', department: 'Support', documentIds: [upload.json().id, jobDescriptionUpload.json().id] },
  });
  assert.equal(compilation.statusCode, 200, compilation.body);
  const draft = compilation.json().draft;
  assert.deepEqual(compilation.json().sources, ['Customer Refund SOP.txt', 'Customer Support JD.pdf']);
  assert.ok(draft.responsibilities.some((item) => item.includes('Refund requests over $500')));
  assert.ok(draft.responsibilities.some((item) => item.includes('Resolve customer refund questions')));
  assert.deepEqual(draft.tools, [], 'compiler suggestions must not become tool grants');
  assert.ok(compilation.json().toolSuggestions.some((item) => item.tool === 'payments.refund'));

  const forgedProvenance = draft.provenance.map((item) => item.field === 'responsibilities'
    ? { ...item, source: 'Invented policy.txt', evidence: 'Refund requests over $500 require manager approval.' }
    : item);
  const forgedEmployee = await request('POST', '/api/employees', { cookie: ownerCookie, body: employeeBody(draft, 'Forged citation', forgedProvenance) });
  assert.equal(forgedEmployee.statusCode, 400);
  assert.match(forgedEmployee.json().message, /does not match a document in this workspace/);

  const mismatchedProvenance = draft.provenance.map((item) => item.field === 'mission'
    ? { field: 'mission', source: 'Customer Refund SOP.txt', evidence: 'Refund requests over $500 require manager approval; do not issue the refund before approval.' }
    : item);
  const mismatchedEmployee = await request('POST', '/api/employees', { cookie: ownerCookie, body: employeeBody(draft, 'Mismatched citation', mismatchedProvenance) });
  assert.equal(mismatchedEmployee.statusCode, 400);
  assert.match(mismatchedEmployee.json().message, /does not support EmployeeSpec field: mission/);

  const editedDraft = { ...draft, mission: `${draft.mission} Escalate weekly exceptions to the operations manager.` };
  const editedDraftBody = employeeBody(editedDraft, 'Manager-edited draft', draft.provenance);
  editedDraftBody.identity = { ...editedDraft.identity, name: 'Manager-edited draft' };
  editedDraftBody.provenance = provenanceForEditedFields(draft, editedDraftBody, draft.provenance);
  const editedDraftEmployee = await request('POST', '/api/employees', { cookie: ownerCookie, body: editedDraftBody });
  assert.equal(editedDraftEmployee.statusCode, 201, editedDraftEmployee.body);
  assert.ok(editedDraftEmployee.json().spec.provenance.some((item) => item.field === 'mission' && item.source === 'Manager input'));
  assert.ok(editedDraftEmployee.json().spec.provenance.some((item) => item.field === 'responsibilities' && item.source === 'Customer Refund SOP.txt'));

  const employees = await Promise.all([
    createEmployee(ownerCookie, draft, 'Refund Specialist A'),
    createEmployee(ownerCookie, draft, 'Refund Specialist B'),
  ]);
  const edited = await request('PUT', `/api/employees/${employees[0].id}/spec`, {
    cookie: ownerCookie,
    body: {
      identity: employees[0].spec.identity,
      profileId: employees[0].spec.profileId,
      mission: `${employees[0].spec.mission} Review escalations weekly.`,
      responsibilities: [...employees[0].spec.responsibilities, 'Publish a review checklist after each above-limit refund decision.'],
      successMetrics: employees[0].spec.successMetrics,
      capabilities: employees[0].spec.capabilities,
      tools: employees[0].spec.tools,
      policies: employees[0].spec.policies,
      coworkers: employees[0].spec.coworkers,
      evaluationPolicy: employees[0].spec.evaluationPolicy,
      provenance: employees[0].spec.provenance,
    },
  });
  assert.equal(edited.statusCode, 201, edited.body);
  assert.equal(edited.json().version, 2);
  assert.ok(edited.json().provenance.some((item) => item.field === 'mission' && item.source === 'Manager edit'));
  assert.ok(edited.json().provenance.some((item) => item.field === 'responsibilities' && item.source === 'Manager edit'));
  assert.ok(edited.json().responsibilities.some((item) => item.includes('Publish a review checklist')));
  const versionHistory = await request('GET', `/api/employees/${employees[0].id}`, { cookie: ownerCookie });
  assert.equal(versionHistory.statusCode, 200, versionHistory.body);
  assert.deepEqual(versionHistory.json().versions.map((version) => version.version), [2, 1]);
  assert.ok(versionHistory.json().versions[0].responsibilities.some((item) => item.includes('Publish a review checklist')));
  assert.ok(!versionHistory.json().versions[1].responsibilities.some((item) => item.includes('Publish a review checklist')));
  employees[0].spec = edited.json();
  const policies = await request('GET', '/api/policies', { cookie: ownerCookie });
  assert.equal(policies.statusCode, 200, policies.body);
  const refundPolicy = policies.json().policies.find((item) => item.tool === 'payments.refund' && item.name === 'Escalate refunds over $500');
  assert.ok(refundPolicy?.active);
  assert.deepEqual(refundPolicy.condition, { amount: { gt: 500 } });
  const createdPolicy = await request('POST', '/api/policies', { cookie: ownerCookie, body: { name: 'Route migration check', tool: 'jira.create_issue', effect: 'DENY', condition: {} } });
  assert.equal(createdPolicy.statusCode, 201, createdPolicy.body);
  assert.deepEqual(createdPolicy.json().condition, {});
  const disabledPolicy = await request('PATCH', `/api/policies/${createdPolicy.json().id}`, { cookie: ownerCookie, body: { active: false } });
  assert.equal(disabledPolicy.statusCode, 200, disabledPolicy.body);
  assert.equal(disabledPolicy.json().active, false);
  const invalidPolicy = await request('POST', '/api/policies', { cookie: ownerCookie, body: { name: '', tool: 'jira.create_issue', effect: 'INVALID' } });
  assert.equal(invalidPolicy.statusCode, 400);

  const suites = await request('GET', '/api/simulations', { cookie: ownerCookie });
  assert.equal(suites.statusCode, 200, suites.body);
  const updatedSpecSuite = suites.json().find((item) => item.name === `Probation v2 · ${employees[0].name}`);
  assert.ok(updatedSpecSuite, 'a responsibility/authority edit should create a fresh probation suite');
  assert.equal(updatedSpecSuite.scenario.actions[0].expectedDecision, 'REQUIRE_APPROVAL');
  const updatedSpecRun = await request('POST', `/api/simulations/${updatedSpecSuite.id}/run`, { cookie: ownerCookie, body: { employeeId: employees[0].id } });
  assert.equal(updatedSpecRun.statusCode, 201, updatedSpecRun.body);
  assert.equal(updatedSpecRun.json().passed, true);
  assert.equal(updatedSpecRun.json().specVersion, 2);
  const simulation = suites.json().find((item) => item.name === 'Refund over limit');
  assert.ok(simulation, 'workspace should contain its seeded $1,000 vs $500 probation scenario');
  assert.equal(simulation.scenario.actions[0].input.amount, 1000);
  assert.equal(simulation.scenario.actions[0].expectedDecision, 'REQUIRE_APPROVAL');

  const simulationRuns = [];
  for (const employee of employees) {
    const run = await request('POST', `/api/simulations/${simulation.id}/run`, { cookie: ownerCookie, body: { employeeId: employee.id } });
    assert.equal(run.statusCode, 201, run.body);
    assert.equal(run.json().status, 'completed');
    assert.equal(run.json().passed, true);
    assert.equal(run.json().specVersion, employee.spec.version);
    assert.equal(run.json().evidence[0].actionMatched, true);
    assert.equal(run.json().evidence[0].observedDecision, 'REQUIRE_APPROVAL');
    simulationRuns.push(run.json());
  }

  for (const employee of employees) {
    const deployed = await request('POST', `/api/employees/${employee.id}/deploy`, { cookie: ownerCookie, body: {} });
    assert.equal(deployed.statusCode, 200, deployed.body);
    assert.equal(deployed.json().state, 'active');
  }

  const delegationEvidence = (await request('GET', '/api/memories', { cookie: ownerCookie })).json()[0];
  assert.ok(delegationEvidence, 'delegation evidence should come from a saved workspace memory');
  const missingDelegationGoal = await request('POST', '/api/messages', { cookie: ownerCookie, body: { type: 'delegation_request', fromEmployeeId: employees[0].id, toEmployeeId: employees[1].id, body: 'A task needs review.' } });
  assert.equal(missingDelegationGoal.statusCode, 400);
  const selfDelegation = await request('POST', '/api/messages', { cookie: ownerCookie, body: { type: 'delegation_request', fromEmployeeId: employees[0].id, toEmployeeId: employees[0].id, body: 'A task needs review.', requestedGoal: 'Review the task.' } });
  assert.equal(selfDelegation.statusCode, 400);
  const delegation = await request('POST', '/api/messages', {
    cookie: ownerCookie,
    body: {
      type: 'delegation_request',
      fromEmployeeId: employees[0].id,
      toEmployeeId: employees[1].id,
      content: 'Please process the approved case and record the outcome.',
      requestedGoal: 'Process the approved $500 refund for case DELEGATED-500 and record the verified outcome.',
      evidenceIds: [delegationEvidence.id],
    },
  });
  assert.equal(delegation.statusCode, 201, delegation.body);
  assert.equal(delegation.json().type, 'delegation_request');
  assert.equal(delegation.json().content, 'Please process the approved case and record the outcome.');
  assert.equal(delegation.json().status, 'pending');
  const recordedDelegation = (await request('GET', '/api/messages', { cookie: ownerCookie })).json().find((item) => item.id === delegation.json().id);
  assert.equal(recordedDelegation.delegationGoal, 'Process the approved $500 refund for case DELEGATED-500 and record the verified outcome.');
  assert.equal(recordedDelegation.content, 'Please process the approved case and record the outcome.');
  assert.deepEqual(recordedDelegation.evidenceIds, [delegationEvidence.id]);
  const priorDelegationFetch = globalThis.fetch;
  const priorDelegationKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'offline-delegation-workflow-key';
  globalThis.fetch = async (input, options = {}) => {
    const endpoint = String(input);
    if (endpoint.endsWith('/embeddings')) return new Response(JSON.stringify({ data: [{ embedding: Array(1536).fill(0) }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    assert.equal(endpoint, 'https://openrouter.ai/api/v1/chat/completions');
    const payload = JSON.parse(options.body);
    const message = payload.messages.some((item) => item.role === 'tool')
      ? { content: 'The approved simulated refund was recorded and verified.' }
      : {
        content: '',
        tool_calls: [{ id: 'delegation_refund', type: 'function', function: {
          name: payload.tools.find((item) => item.function.description.includes('simulated customer refund')).function.name,
          arguments: JSON.stringify({ amount: 500, currency: 'USD', caseId: 'DELEGATED-500' }),
        } }],
      };
    return new Response(JSON.stringify({ model: 'offline-delegation-model', choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  let acceptedDelegation, delegatedCompletion;
  try {
    acceptedDelegation = await request('POST', `/api/messages/${delegation.json().id}/respond`, { cookie: ownerCookie, body: { decision: 'accept' } });
    assert.equal(acceptedDelegation.statusCode, 202, acceptedDelegation.body);
    assert.equal(acceptedDelegation.json().status, 'accepted');
    assert.equal(acceptedDelegation.json().employeeId, employees[1].id);
    const linkedDelegation = (await request('GET', '/api/messages', { cookie: ownerCookie })).json().find((item) => item.id === delegation.json().id);
    assert.equal(linkedDelegation.workflowId, acceptedDelegation.json().workflowId);
    assert.equal(linkedDelegation.delegationStatus, 'accepted');
    const delegatedWorkflow = await request('GET', `/api/workflows/${acceptedDelegation.json().workflowId}`, { cookie: ownerCookie });
    assert.equal(delegatedWorkflow.statusCode, 200, delegatedWorkflow.body);
    assert.equal(delegatedWorkflow.json().employee_id, employees[1].id);
    assert.equal(delegatedWorkflow.json().goal, 'Process the approved $500 refund for case DELEGATED-500 and record the verified outcome.');
    delegatedCompletion = await waitForWorkflow(ownerCookie, acceptedDelegation.json().workflowId);
    assert.equal(delegatedCompletion.status, 'completed', delegatedCompletion.error || JSON.stringify(delegatedCompletion));
    assert.equal(delegatedCompletion.result.verified, true);
    assert.equal(delegatedCompletion.plan[0].tool, 'payments.refund');
  } finally {
    globalThis.fetch = priorDelegationFetch;
    if (priorDelegationKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = priorDelegationKey;
  }
  const employeeMetrics = (await request('GET', '/api/employees', { cookie: ownerCookie })).json();
  const requesterMetrics = employeeMetrics.find((employee) => employee.id === employees[0].id);
  const recipientMetrics = employeeMetrics.find((employee) => employee.id === employees[1].id);
  assert.equal(requesterMetrics.resolvedTasks, 0);
  assert.equal(requesterMetrics.taskSuccessRate, null);
  assert.equal(recipientMetrics.completedTasks, 1);
  assert.equal(recipientMetrics.failedTasks, 0);
  assert.equal(recipientMetrics.resolvedTasks, 1);
  assert.equal(recipientMetrics.taskSuccessRate, 100);
  const overview = await request('GET', '/api/overview', { cookie: ownerCookie });
  assert.equal(overview.statusCode, 200, overview.body);
  assert.equal(Number(overview.json().completedTasks), 1);
  assert.equal(Number(overview.json().failedTasks), 0);
  assert.equal(overview.json().taskSuccessRate, 100);
  const duplicateAcceptance = await request('POST', `/api/messages/${delegation.json().id}/respond`, { cookie: ownerCookie, body: { decision: 'accept' } });
  assert.equal(duplicateAcceptance.statusCode, 409);

  const scheduled = await request('POST', '/api/meetings', {
    cookie: ownerCookie,
    body: {
      title: 'Refund policy readiness',
      agenda: ['Review the SOP for refunds above $500.'],
      participantIds: employees.map((employee) => employee.id),
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
  });
  assert.equal(scheduled.statusCode, 201, scheduled.body);
  assert.equal(scheduled.json().status, 'scheduled');

  const staleTimestamp = new Date(Date.now() - 120_000).toISOString();
  await runDb('UPDATE meetings SET status=?,meeting_worker_id=NULL,meeting_lease_expires_at=NULL,updated_at=? WHERE id=?', 'preparing', staleTimestamp, scheduled.json().id);
  const prepared = await request('POST', `/api/meetings/${scheduled.json().id}/prepare`, { cookie: ownerCookie, body: {} });
  assert.equal(prepared.statusCode, 200, prepared.body);
  assert.equal(prepared.json().briefs.length, 2);
  assert.ok(prepared.json().briefs.every((brief) => brief.brief.includes('Refund requests over $500')));

  await runDb('UPDATE meetings SET status=?,meeting_worker_id=NULL,meeting_lease_expires_at=NULL,updated_at=? WHERE id=?', 'discussing', staleTimestamp, scheduled.json().id);
  const priorDiscussionFetch = globalThis.fetch;
  const priorDiscussionKey = process.env.OPENROUTER_API_KEY;
  let discussionCall = 0;
  process.env.OPENROUTER_API_KEY = 'offline-delegation-test-key';
  globalThis.fetch = async (input, options = {}) => {
    const endpoint = String(input);
    if (!endpoint.endsWith('/chat/completions')) throw new Error(`Unexpected delegation test request: ${endpoint}`);
    const context = JSON.parse(JSON.parse(options.body).messages[1].content);
    const answer = discussionCall++ === 0
      ? { type: 'delegation_request', toEmployeeId: employees[1].id, content: 'Please process this already approved test refund.', requestedGoal: 'Process the approved $500 refund for case DELEGATED-AI-500 and record the verified outcome.', evidenceIds: context.privateBrief.memoryIds }
      : { type: 'message', toEmployeeId: employees[0].id, content: 'I will review the cited refund policy.', evidenceIds: context.privateBrief.memoryIds };
    return { ok: true, status: 200, json: async () => ({ model: 'gpt-4o-mini', usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }, choices: [{ message: { content: JSON.stringify(answer) } }] }) };
  };
  let discussion;
  try { discussion = await request('POST', `/api/meetings/${scheduled.json().id}/discuss`, { cookie: ownerCookie, body: {} }); }
  finally {
    globalThis.fetch = priorDiscussionFetch;
    if (priorDiscussionKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = priorDiscussionKey;
  }
  assert.equal(discussion.statusCode, 200, discussion.body);
  assert.equal(discussion.json().generated, 2);
  assert.equal(discussion.json().messages.length, 2);
  const proposedDelegation = discussion.json().messages.find((message) => message.type === 'delegation_request');
  assert.equal(proposedDelegation.to_employee_id, employees[1].id);
  assert.equal(proposedDelegation.delegationGoal, 'Process the approved $500 refund for case DELEGATED-AI-500 and record the verified outcome.');
  assert.ok(proposedDelegation.evidenceIds.length > 0);

  await runDb('UPDATE meetings SET status=?,meeting_worker_id=NULL,meeting_lease_expires_at=NULL,updated_at=? WHERE id=?', 'in_meeting', staleTimestamp, scheduled.json().id);
  await runDb("CREATE TRIGGER fail_meeting_memory BEFORE INSERT ON memories WHEN NEW.source LIKE 'meeting:%' BEGIN SELECT RAISE(ABORT, 'injected meeting memory write failure'); END");
  const interruptedMeeting = await request('POST', `/api/meetings/${scheduled.json().id}/run`, { cookie: ownerCookie, body: {} });
  assert.equal(interruptedMeeting.statusCode, 500);
  assert.equal((await getDb('SELECT id FROM memories WHERE source=?', `meeting:${scheduled.json().id}`)), undefined);
  const retryableMeeting = await request('GET', `/api/meetings/${scheduled.json().id}`, { cookie: ownerCookie });
  assert.equal(retryableMeeting.json().status, 'briefing');
  await runDb('DROP TRIGGER fail_meeting_memory');
  const meetingRun = await request('POST', `/api/meetings/${scheduled.json().id}/run`, { cookie: ownerCookie, body: {} });
  assert.equal(meetingRun.statusCode, 200, meetingRun.body);
  assert.equal(meetingRun.json().positions.length, 2);
  assert.ok(meetingRun.json().positions.every((position) => position.position === 'No model-generated position was available for this turn.'));

  const persistedMeeting = await request('GET', `/api/meetings/${scheduled.json().id}`, { cookie: ownerCookie });
  assert.equal(persistedMeeting.statusCode, 200, persistedMeeting.body);
  assert.equal(persistedMeeting.json().status, 'completed');
  assert.equal(persistedMeeting.json().decisions.positions.length, 2);
  assert.deepEqual(new Set(persistedMeeting.json().decisions.positions.map((position) => position.employeeId)), new Set(employees.map((employee) => employee.id)));
  assert.equal(persistedMeeting.json().messages.filter((message) => message.kind === 'pre_meeting').length, 2);
  assert.equal(persistedMeeting.json().messages.filter((message) => message.kind === 'meeting_turn').length, 2);
  const priorMeetingMemory = (await request('GET', '/api/memories', { cookie: ownerCookie })).json().find((memory) => memory.kind === 'meeting' && memory.source === `meeting:${scheduled.json().id}`);
  assert.ok(priorMeetingMemory, 'completed meeting should persist a source-grounded meeting memory');
  assert.equal(priorMeetingMemory.id, `mem_${scheduled.json().id}`, 'meeting memory uses a stable, idempotent record ID');
  assert.ok(priorMeetingMemory.body.includes('Delegation request awaiting manager review: Process the approved $500 refund for case DELEGATED-AI-500'));

  const followupActions = await Promise.all(employees.map(async (employee, index) => request('POST', `/api/meetings/${scheduled.json().id}/actions`, {
    cookie: ownerCookie,
    body: { title: `Issue the approved $500 refund for case FOLLOWUP-500-${index + 1} and record the outcome.`, employeeId: employee.id },
  })));
  for (const [index, followupAction] of followupActions.entries()) {
    assert.equal(followupAction.statusCode, 201, followupAction.body);
    assert.equal(followupAction.json().status, 'open');
    assert.equal(followupAction.json().employee_id, employees[index].id);
  }

  const priorFollowupFetch = globalThis.fetch;
  const priorFollowupKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'offline-followup-workflow-key';
  globalThis.fetch = async (input, options = {}) => {
    const endpoint = String(input);
    if (endpoint.endsWith('/embeddings')) return new Response(JSON.stringify({ data: [{ embedding: Array(1536).fill(0) }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    assert.equal(endpoint, 'https://openrouter.ai/api/v1/chat/completions');
    const payload = JSON.parse(options.body);
    const userMessage = payload.messages.find((message) => message.role === 'user')?.content || '';
    const caseId = userMessage.match(/FOLLOWUP-500-\d+/)?.[0] || 'FOLLOWUP-500-1';
    const message = payload.messages.some((item) => item.role === 'tool')
      ? { content: `The simulated refund for ${caseId} was recorded and verified.` }
      : {
        content: '',
        tool_calls: [{ id: `followup_${caseId}`, type: 'function', function: {
          name: payload.tools.find((item) => item.function.description.includes('simulated customer refund')).function.name,
          arguments: JSON.stringify({ amount: 500, currency: 'USD', caseId }),
        } }],
      };
    return new Response(JSON.stringify({ model: 'offline-followup-model', choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  let workflows;
  try {
    const actionStarts = await Promise.all(followupActions.map((followupAction) => request('POST', `/api/action-items/${followupAction.json().id}/start`, { cookie: ownerCookie, body: {} })));
    for (const [index, actionStart] of actionStarts.entries()) {
      assert.equal(actionStart.statusCode, 202, actionStart.body);
      assert.equal(actionStart.json().actionItemId, followupActions[index].json().id);
      assert.equal(actionStart.json().status, 'queued');
    }

    workflows = await Promise.all(actionStarts.map((actionStart) => waitForWorkflow(ownerCookie, actionStart.json().workflowId)));
    for (const [index, workflow] of workflows.entries()) {
      assert.equal(workflow.status, 'completed', workflow.error || JSON.stringify(workflow));
      assert.equal(workflow.result.verified, true);
      assert.equal(workflow.plan.length, 1);
      assert.equal(workflow.plan[0].tool, 'payments.refund');
      assert.equal(workflow.toolRuns.length, 1);
      assert.equal(workflow.toolRuns[0].tool, 'payments.refund');
      assert.equal(workflow.toolRuns[0].status, 'completed');
      assert.equal(workflow.result.steps[0].output.status, 'simulated');
      assert.equal(workflow.result.steps[0].evidence.status, 'simulated');
      assert.equal(workflow.result.steps[0].evidence.amount, 500);
      assert.equal(workflow.result.steps[0].evidence.caseId, `FOLLOWUP-500-${index + 1}`);
      const memory = await waitForMemory(ownerCookie, `FOLLOWUP-500-${index + 1}`, employees[index].id, `workflow:${workflow.id}`);
      assert.equal(memory.kind, 'episodic');
      assert.equal(memory.title, workflow.goal.slice(0, 160));
      assert.match(memory.body, /Outcome: verified\./);
      assert.match(memory.body, new RegExp(`FOLLOWUP-500-${index + 1}`));
    }
  } finally {
    globalThis.fetch = priorFollowupFetch;
    if (priorFollowupKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = priorFollowupKey;
  }

  const persistedAction = await request('GET', `/api/meetings/${scheduled.json().id}`, { cookie: ownerCookie });
  for (const [index, followupAction] of followupActions.entries()) {
    const linkedAction = persistedAction.json().actionItems.find((item) => item.id === followupAction.json().id);
    assert.equal(linkedAction.workflow_id, workflows[index].id);
    assert.equal(linkedAction.workflow_status, 'completed');
    assert.equal(linkedAction.status, 'done');
  }
  const refunds = await request('GET', '/api/refunds', { cookie: ownerCookie });
  assert.equal(refunds.statusCode, 200, refunds.body);
  for (const [index, workflow] of workflows.entries()) {
    assert.ok(refunds.json().some((refund) => refund.workflow_id === workflow.id && refund.case_id === `FOLLOWUP-500-${index + 1}` && Number(refund.amount) === 500 && refund.status === 'simulated'));
  }

  const followupMeeting = await request('POST', '/api/meetings', {
    cookie: ownerCookie,
    body: {
      title: 'Refund policy readiness follow-up',
      agenda: ['Review the outcome of Refund policy readiness and complete pending refund actions.'],
      participantIds: employees.map((employee) => employee.id),
      startsAt: new Date(Date.now() + 172_800_000).toISOString(),
    },
  });
  assert.equal(followupMeeting.statusCode, 201, followupMeeting.body);
  const followupBriefs = await request('POST', `/api/meetings/${followupMeeting.json().id}/prepare`, { cookie: ownerCookie, body: {} });
  assert.equal(followupBriefs.statusCode, 200, followupBriefs.body);
  assert.equal(followupBriefs.json().briefs.length, 2);
  assert.ok(followupBriefs.json().briefs.every((brief) => brief.memoryIds.includes(priorMeetingMemory.id)), 'each prepared brief should retrieve the prior meeting memory');

  const otherSignup = await request('POST', '/api/auth/signup', {
    body: { name: 'Other Owner', email: 'other-owner@example.test', password: 'other-password-123', organization: 'Separate Workspace' },
  });
  assert.equal(otherSignup.statusCode, 201, otherSignup.body);
  const otherCookie = sessionCookie(otherSignup);
  assert.notEqual(otherSignup.json().organization.id, orgId);
  assert.deepEqual((await request('GET', '/api/employees', { cookie: otherCookie })).json(), []);
  assert.equal((await request('GET', `/api/employees/${employees[0].id}`, { cookie: otherCookie })).statusCode, 404);
  const otherSimulations = await request('GET', '/api/simulations', { cookie: otherCookie });
  assert.equal(otherSimulations.statusCode, 200, otherSimulations.body);
  assert.ok(!otherSimulations.json().some((item) => item.id === simulation.id));
  assert.equal((await request('GET', `/api/simulations/${simulation.id}/runs`, { cookie: otherCookie })).statusCode, 404);
  assert.equal((await request('GET', `/api/simulation-runs/${simulationRuns[0].id}`, { cookie: otherCookie })).statusCode, 404);
  assert.equal((await request('POST', `/api/simulations/${simulation.id}/run`, { cookie: otherCookie, body: { employeeId: employees[0].id } })).statusCode, 404);
  const otherMeetings = await request('GET', '/api/meetings', { cookie: otherCookie });
  assert.equal(otherMeetings.statusCode, 200, otherMeetings.body);
  assert.ok(!otherMeetings.json().some((item) => item.id === scheduled.json().id));
  assert.equal((await request('GET', `/api/meetings/${scheduled.json().id}`, { cookie: otherCookie })).statusCode, 404);

  await storeSecret(orgId, ownerSignup.json().user.id, 'solari', 'offline-solari-test-key');
  const replayWorkflowId = 'workflow_failed_browser_interaction_replay';
  const replayTimestamp = new Date().toISOString();
  await runDb('INSERT INTO workflows(id,org_id,employee_id,created_by,goal,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', replayWorkflowId, orgId, employees[0].id, ownerSignup.json().user.id, 'Open and interact with a browser', 'failed', replayTimestamp, replayTimestamp);
  for (const [stepIndex, sessionId] of [[0, 'browser-session-old'], [2, 'browser-session-current']]) {
    await runDb('INSERT INTO tool_runs(id,org_id,workflow_id,step_index,tool,input,output,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)', `browser-open-${stepIndex}`, orgId, replayWorkflowId, stepIndex, 'solari.browser.open', '{}', JSON.stringify({ sessionId }), 'completed', replayTimestamp);
  }
  await runDb('INSERT INTO tool_runs(id,org_id,workflow_id,step_index,tool,input,output,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)', 'browser-interact-failed', orgId, replayWorkflowId, 3, 'solari.browser.interact', JSON.stringify({ actions: [{ action: 'click', selector: '#save' }] }), JSON.stringify({ error: 'Expected text was not visible.' }), 'failed', replayTimestamp);
  const replayRequests = [];
  globalThis.fetch = async (input) => {
    replayRequests.push(new URL(input));
    return new Response(JSON.stringify({ url: 'https://replay.example/session' }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const replay = await request('GET', '/api/tool-runs/browser-interact-failed/replay', { cookie: ownerCookie });
    assert.equal(replay.statusCode, 302, replay.body);
    assert.equal(replay.getHeader('location'), 'https://replay.example/session');
    assert.equal(replayRequests[0].pathname, '/sessions/browser-session-current/replay-url');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('meeting orchestration persists assigned actions and queues follow-up work for an active employee', async () => {
  const signup = await request('POST', '/api/auth/signup', {
    body: { name: 'Meeting Owner', email: 'meeting-owner@example.test', password: 'owner-password-123', organization: 'Meeting Follow-up Flow' },
  });
  assert.equal(signup.statusCode, 201, signup.body);
  const cookie = sessionCookie(signup);

  const document = await request('POST', '/api/documents', {
    cookie,
    body: { filename: 'Customer Refund SOP.txt', contentBase64: Buffer.from('Refund requests over $500 require manager approval. Record the approval in the customer case.').toString('base64') },
  });
  assert.equal(document.statusCode, 201, document.body);
  const compiled = await request('POST', '/api/specs/compile', {
    cookie,
    body: { name: 'Meeting Refund Specialist', title: 'Meeting Refund Specialist', department: 'Support', documentIds: [document.json().id] },
  });
  assert.equal(compiled.statusCode, 200, compiled.body);
  const draft = compiled.json().draft;
  const employees = await Promise.all([
    createEmployee(cookie, draft, 'Active Meeting Specialist'),
    createEmployee(cookie, draft, 'Meeting Colleague'),
  ]);

  const suites = await request('GET', '/api/simulations', { cookie });
  assert.equal(suites.statusCode, 200, suites.body);
  const suite = suites.json().find((item) => item.name === 'Refund over limit');
  assert.ok(suite);
  const probation = await request('POST', `/api/simulations/${suite.id}/run`, { cookie, body: { employeeId: employees[0].id } });
  assert.equal(probation.statusCode, 201, probation.body);
  assert.equal(probation.json().passed, true);
  const deployed = await request('POST', `/api/employees/${employees[0].id}/deploy`, { cookie, body: {} });
  assert.equal(deployed.statusCode, 200, deployed.body);
  assert.equal(deployed.json().state, 'active');

  const meeting = await request('POST', '/api/meetings', {
    cookie,
    body: { title: 'Refund approval planning', agenda: ['Confirm the approval requirement and assign documentation.'], participantIds: employees.map((employee) => employee.id) },
  });
  assert.equal(meeting.statusCode, 201, meeting.body);
  const prepared = await request('POST', `/api/meetings/${meeting.json().id}/prepare`, { cookie, body: {} });
  assert.equal(prepared.statusCode, 200, prepared.body);
  const discussion = await request('POST', `/api/meetings/${meeting.json().id}/discuss`, { cookie, body: {} });
  assert.equal(discussion.statusCode, 200, discussion.body);

  const decision = 'Refunds above $500 require manager approval.';
  const actionTitle = 'Document the manager approval checklist for refunds above $500.';
  const orchestrationEmployeeIds = [];
  const previousFetch = globalThis.fetch;
  const previousApiKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'mock-openrouter-key-for-meeting-test';
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith('/chat/completions')) {
      const requestBody = JSON.parse(options.body);
      assert.match(requestBody.messages[0].content, /Facilitate exactly one structured meeting turn/);
      const context = JSON.parse(requestBody.messages[1].content);
      const employeeId = context.participant.employeeId;
      orchestrationEmployeeIds.push(employeeId);
      return new Response(JSON.stringify({
        model: 'mock-meeting-model',
        choices: [{ message: { content: JSON.stringify({
          position: { employeeId, position: 'The approval threshold is documented in the source policy.', evidenceIds: [], risks: [] },
          decisions: [decision],
          actions: employeeId === employees[0].id ? [{ employeeId, title: actionTitle }] : [],
        }) } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/embeddings')) return new Response('', { status: 503 });
    throw new Error(`Unexpected request in mocked meeting flow: ${url}`);
  };

  let completed;
  try {
    completed = await request('POST', `/api/meetings/${meeting.json().id}/run`, { cookie, body: {} });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousApiKey;
  }

  assert.equal(completed.statusCode, 200, completed.body);
  assert.deepEqual(new Set(orchestrationEmployeeIds), new Set(employees.map((employee) => employee.id)));
  assert.deepEqual(completed.json().decisions, [decision]);
  assert.deepEqual(completed.json().actions, [{ employeeId: employees[0].id, title: actionTitle }]);
  assert.equal(completed.json().followupWorkflows.length, 1);

  const persisted = await request('GET', `/api/meetings/${meeting.json().id}`, { cookie });
  assert.equal(persisted.statusCode, 200, persisted.body);
  assert.equal(persisted.json().status, 'completed');
  assert.deepEqual(persisted.json().decisions.decisions, [decision]);
  const [actionItem] = persisted.json().actionItems;
  assert.equal(actionItem.title, actionTitle);
  assert.equal(actionItem.employee_id, employees[0].id);
  assert.equal(actionItem.employee_state, 'active');
  assert.equal(actionItem.status, 'open');
  assert.equal(actionItem.workflow_id, completed.json().followupWorkflows[0]);

  const workflow = await request('GET', `/api/workflows/${actionItem.workflow_id}`, { cookie });
  assert.equal(workflow.statusCode, 200, workflow.body);
  assert.equal(workflow.json().employee_id, employees[0].id);
  assert.ok(workflow.json().goal.includes(actionTitle));

  const workflowOutcome = await waitForWorkflow(cookie, actionItem.workflow_id);
  assert.equal(workflowOutcome.employee_id, employees[0].id);
  if (workflowOutcome.status === 'completed' || workflowOutcome.status === 'failed') {
    const source = workflowOutcome.status === 'completed' ? `workflow:${actionItem.workflow_id}` : `workflow-failure:${actionItem.workflow_id}`;
    await waitForMemory(cookie, actionTitle, employees[0].id, source);
  } else {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
});

test('spec compilation bounds long documents and keeps full stored text available for provenance checks', async () => {
  const signup = await request('POST', '/api/auth/signup', {
    body: { name: 'Long Source Owner', email: 'long-source@example.test', password: 'owner-password-123', organization: 'Long Source Workspace' },
  });
  assert.equal(signup.statusCode, 201, signup.body);
  const cookie = sessionCookie(signup);
  const tailEvidence = 'Resolve escalated refund cases within two business days.';
  const fullText = `${'Review each refund case and record supporting evidence before approval.\n'.repeat(700)}${tailEvidence}`;
  assert.ok(fullText.length > 30_000);
  const upload = await request('POST', '/api/documents', {
    cookie,
    body: { filename: 'Long Refund SOP.txt', contentBase64: Buffer.from(fullText).toString('base64') },
  });
  assert.equal(upload.statusCode, 201, upload.body);

  const compilation = await request('POST', '/api/specs/compile', {
    cookie,
    body: { title: 'Refund Operations Specialist', department: 'Support', documentIds: [upload.json().id] },
  });
  assert.equal(compilation.statusCode, 200, compilation.body);
  assert.equal(compilation.json().sourceWasTrimmed, true);
  assert.deepEqual(compilation.json().trimmedSources, ['Long Refund SOP.txt']);
  assert.ok(compilation.json().sourceCharacters <= compilation.json().sourceBudget);
  assert.equal(compilation.json().sourceBudget, 30_000);

  const draft = compilation.json().draft;
  const provenance = draft.provenance.filter((item) => item.field !== 'mission');
  provenance.push({ field: 'mission', source: 'Long Refund SOP.txt', evidence: tailEvidence });
  const employee = await request('POST', '/api/employees', {
    cookie,
    body: employeeBody({ ...draft, mission: tailEvidence, provenance }, 'Long Source Specialist'),
  });
  assert.equal(employee.statusCode, 201, employee.body);
  assert.ok(employee.json().spec.provenance.some((item) => item.field === 'mission' && item.evidence === tailEvidence));
});

test('independent evaluator grades a live workflow from verified tool evidence with a distinct model', async () => {
  const signup = await request('POST', '/api/auth/signup', {
    body: { name: 'Evaluator Owner', email: 'evaluator-owner@example.test', password: 'owner-password-123', organization: 'Independent Evaluation Flow' },
  });
  assert.equal(signup.statusCode, 201, signup.body);
  const cookie = sessionCookie(signup);
  const created = await request('POST', '/api/employees', {
    cookie,
    body: {
      name: 'Evidence Refund Specialist', title: 'Refund Specialist', department: 'Support',
      mission: 'Process eligible simulated refunds and record the outcome.', responsibilities: ['Review each refund case.'],
      successMetrics: [], capabilities: [], tools: ['payments.refund'], policies: [], coworkers: [],
      evaluationPolicy: 'Pass the assigned probation simulations at the configured threshold.',
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const employee = created.json();
  const suites = await request('GET', '/api/simulations', { cookie });
  const probation = await request('POST', `/api/simulations/${suites.json().find((item) => item.name === 'Refund over limit').id}/run`, { cookie, body: { employeeId: employee.id } });
  assert.equal(probation.statusCode, 201, probation.body);
  assert.equal(probation.json().passed, true);
  const deployed = await request('POST', `/api/employees/${employee.id}/deploy`, { cookie, body: {} });
  assert.equal(deployed.statusCode, 200, deployed.body);

  const priorFetch = globalThis.fetch;
  const priorOpenAiKey = process.env.OPENROUTER_API_KEY;
  const priorOpenAiModel = process.env.OPENROUTER_MODEL;
  const priorEvaluatorModel = process.env.OPENROUTER_EVALUATOR_MODEL;
  const models = [];
  process.env.OPENROUTER_API_KEY = 'mock-openrouter-key-for-evaluator-test';
  process.env.OPENROUTER_MODEL = 'mock-planner-model';
  process.env.OPENROUTER_EVALUATOR_MODEL = 'mock-independent-grader';
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith('/embeddings')) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    const payload = JSON.parse(options.body);
    models.push(payload.model);
    if (payload.model === 'mock-planner-model') {
      if (payload.messages.some((message) => message.role === 'tool')) {
        return new Response(JSON.stringify({
          model: payload.model,
          choices: [{ message: { content: 'The simulated refund was recorded and verified.' } }],
          usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const refundTool = payload.tools.find((tool) => tool.function.description.includes('simulated customer refund'));
      return new Response(JSON.stringify({
        model: payload.model,
        choices: [{ message: { content: '', tool_calls: [{ id: 'evaluator_refund', type: 'function', function: { name: refundTool.function.name, arguments: JSON.stringify({ amount: 42, currency: 'USD', caseId: 'EVAL-001' }) } }] } }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    assert.equal(payload.model, 'mock-independent-grader');
    assert.match(payload.messages[0].content, /Independently evaluate/);
    const evaluationInput = JSON.parse(payload.messages[1].content);
    assert.equal(evaluationInput.verifiedResults.length, 1);
    assert.equal(evaluationInput.verifiedResults[0].tool, 'payments.refund');
    assert.equal(evaluationInput.verifiedResults[0].evidence.status, 'simulated');
    return new Response(JSON.stringify({
      model: payload.model,
      choices: [{ message: { content: JSON.stringify({ score: 0.93, summary: 'The recorded simulated refund matches the task goal.' }) } }],
      usage: { prompt_tokens: 24, completion_tokens: 9, total_tokens: 33 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const createdWorkflow = await request('POST', '/api/workflows', {
      cookie,
      body: { employeeId: employee.id, goal: 'Issue the simulated $42 refund for case EVAL-001 and record the result.' },
    });
    assert.equal(createdWorkflow.statusCode, 202, createdWorkflow.body);
    const deadline = Date.now() + 5000;
    let workflow;
    do {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const response = await request('GET', `/api/workflows/${createdWorkflow.json().taskId}`, { cookie });
      assert.equal(response.statusCode, 200, response.body);
      workflow = response.json();
    } while (Date.now() < deadline && (!['completed', 'failed'].includes(workflow.status) || !workflow.result?.evaluation));

    assert.equal(workflow.status, 'completed', workflow.error || JSON.stringify(workflow));
    assert.equal(workflow.result.verified, true);
    assert.deepEqual(models, ['mock-planner-model', 'mock-planner-model', 'mock-planner-model', 'mock-independent-grader']);
    assert.deepEqual(workflow.result.evaluation, {
      model: 'mock-independent-grader', score: 0.93, passed: true,
      summary: 'The recorded simulated refund matches the task goal.', evaluatedAt: workflow.result.evaluation.evaluatedAt,
    });
    const snapshotDeadline = Date.now() + 2000;
    let trace;
    do {
      trace = await request('GET', `/api/workflows/${createdWorkflow.json().taskId}/trace`, { cookie });
      if (trace.json()?.snapshot) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < snapshotDeadline);
    assert.equal(trace.statusCode, 200, trace.body);
    assert.equal(trace.json().snapshot.version, 1);
    assert.equal(trace.json().toolRuns.length, 1);
    assert.ok(trace.json().events.some((event) => event.kind === 'workflow.evaluation.completed'));
    const stream = await request('GET', `/api/workflows/stream?selectedWorkflowId=${createdWorkflow.json().taskId}`, { cookie });
    assert.equal(stream.statusCode, 200);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(stream.body, /"final":true/);
    assert.match(stream.body, /"snapshot":\{"version":1,"capturedAt":/);
    stream.emit('close');
  } finally {
    globalThis.fetch = priorFetch;
    if (priorOpenAiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = priorOpenAiKey;
    if (priorOpenAiModel === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = priorOpenAiModel;
    if (priorEvaluatorModel === undefined) delete process.env.OPENROUTER_EVALUATOR_MODEL;
    else process.env.OPENROUTER_EVALUATOR_MODEL = priorEvaluatorModel;
  }
});
