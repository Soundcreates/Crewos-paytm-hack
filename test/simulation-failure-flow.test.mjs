import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';

const directory = mkdtempSync(join(tmpdir(), 'crewos-simulation-failure-'));
const envKeys = ['NODE_ENV', 'DATABASE_URL', 'DATABASE_FILE', 'NEON_AUTH_BASE_URL', 'APP_ORIGIN', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'OPENROUTER_EMBEDDING_MODEL', 'SOLARI_API_KEY', 'SOLARI_BROWSER_BASE_URL'];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys) delete process.env[key];
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.DATABASE_FILE = join(directory, 'simulation-failure.sqlite');
process.env.NEON_AUTH_BASE_URL = '';
process.env.APP_ORIGIN = 'http://127.0.0.1:4173';
process.env.SOLARI_API_KEY = 'slr_simulation_failure_test';
process.env.SOLARI_BROWSER_BASE_URL = 'https://solari.test';

const providerRequests = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  providerRequests.push(String(input));
  throw new Error('Unexpected provider call in injected failure scenario.');
};
const { handleHttpRequest } = await import('../backend/server.mjs');
const { closeDatabase } = await import('../backend/lib/db.mjs');

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
  return {
    headersSent: false,
    statusCode: 0,
    body: '',
    setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    writeHead(status, values = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(values)) this.setHeader(name, value);
      this.headersSent = true;
      return this;
    },
    end(body = '') { this.body = String(body); this.headersSent = true; },
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

test('injected failures are deterministic, skip provider execution, and require matching scope and rubric', async () => {
  const signup = await request('POST', '/api/auth/signup', {
    body: { name: 'Simulation Owner', email: 'simulation-failure@example.test', password: 'simulation-password-123', organization: 'Simulation Failure Test' },
  });
  assert.equal(signup.statusCode, 201, signup.body);
  const cookie = sessionCookie(signup);
  const createdEmployee = await request('POST', '/api/employees', {
    cookie,
    body: {
      name: 'Browser Agent', title: 'Browser Agent', department: 'Operations',
      mission: 'Handle browser checks safely.', responsibilities: ['Open public pages.'],
      successMetrics: [], capabilities: [], tools: ['solari.browser.open'], policies: [], coworkers: [],
      evaluationPolicy: 'Pass probation simulations at the configured threshold.',
    },
  });
  assert.equal(createdEmployee.statusCode, 201, createdEmployee.body);
  const employee = createdEmployee.json();
  const jiraEmployeeResponse = await request('POST', '/api/employees', {
    cookie,
    body: {
      name: 'Jira Agent', title: 'Jira Agent', department: 'Operations',
      mission: 'Create work items.', responsibilities: ['Create Jira issues.'],
      successMetrics: [], capabilities: [], tools: ['jira.create_issue'], policies: [], coworkers: [],
      evaluationPolicy: 'Pass probation simulations at the configured threshold.',
    },
  });
  assert.equal(jiraEmployeeResponse.statusCode, 201, jiraEmployeeResponse.body);
  const jiraDraft = await request('POST', '/api/simulations/generate', { cookie, body: { employeeId: jiraEmployeeResponse.json().id } });
  assert.equal(jiraDraft.statusCode, 409, jiraDraft.body);
  assert.match(jiraDraft.json().message, /no executable ALLOW simulation tool/);
  const criterion = 'Browser failure is handled';
  const suite = {
    name: 'Injected browser failure', description: 'Record a simulated browser provider failure.', threshold: 1,
    scenario: {
      objective: 'Open a public page and observe the injected failure.', initialState: {},
      events: [{ type: 'tool.failure', actionIndex: 0, tool: 'solari.browser.open', message: 'fixture provider timeout' }],
      actions: [{ tool: 'solari.browser.open', input: { url: 'https://example.com' }, expectedDecision: 'ALLOW', criterion }],
    },
    rubric: [{ criterion, points: 1, passIf: 'The injected simulated failure was observed.' }],
  };
  const createdSuite = await request('POST', '/api/simulations', { cookie, body: suite });
  assert.equal(createdSuite.statusCode, 201, createdSuite.body);

  const result = await request('POST', `/api/simulations/${createdSuite.json().id}/run`, { cookie, body: { employeeId: employee.id } });
  assert.equal(result.statusCode, 201, result.body);
  assert.equal(result.json().passed, true);
  assert.deepEqual(providerRequests, [], 'an injected failure must skip the Solari provider');
  assert.equal(result.json().evidence[0].injectedFailure.observed, true);
  assert.equal(result.json().evidence[0].injectedFailure.message, 'fixture provider timeout');
  assert.equal(result.json().evidence[0].executionVerified, false);
  assert.equal(result.json().evidence[0].passIfMatched, true);

  const runWithPlanner = async (simulationId, plannerResult) => {
    const previousFetch = globalThis.fetch;
    const previousApiKey = process.env.OPENROUTER_API_KEY;
    providerRequests.length = 0;
    process.env.OPENROUTER_API_KEY = 'mock-openrouter-key-for-planner-test';
    globalThis.fetch = async (input, options = {}) => {
      const url = String(input);
      providerRequests.push(url);
      if (url === 'https://openrouter.ai/api/v1/embeddings') {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
      const requestBody = JSON.parse(options.body);
      assert.match(requestBody.messages[0].content, /You plan work for an AI employee/);
      return new Response(JSON.stringify({
        model: 'mock-planner-model',
        choices: [{ message: { content: JSON.stringify(plannerResult) } }],
        usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      return await request('POST', `/api/simulations/${simulationId}/run`, { cookie, body: { employeeId: employee.id } });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousApiKey;
    }
  };

  const validPlanRun = await runWithPlanner(createdSuite.json().id, {
    steps: [{ tool: 'solari.browser.open', input: { url: 'https://example.com' }, expectation: 'Open the requested page.' }],
  });
  assert.equal(validPlanRun.statusCode, 201, validPlanRun.body);
  assert.equal(validPlanRun.json().evidence[0].plannerMode, 'llm');
  assert.equal(validPlanRun.json().evidence[0].actionMatched, true);
  assert.equal(validPlanRun.json().evidence[0].injectedFailure.observed, true);
  assert.deepEqual(providerRequests, ['https://openrouter.ai/api/v1/embeddings', 'https://openrouter.ai/api/v1/chat/completions'], 'a valid plan must not call Solari for an injected failure');

  const malformedSuite = await request('POST', '/api/simulations', {
    cookie,
    body: {
      name: 'Untrusted planner tool', description: 'Reject a tool outside the employee grants.', threshold: 1,
      scenario: { objective: 'Open the requested page.', initialState: {}, events: [], actions: [{ tool: 'solari.browser.open', input: { url: 'https://example.com' }, expectedDecision: 'ALLOW', criterion }] },
      rubric: [{ criterion, points: 1, passIf: 'The action matches the scenario.' }],
    },
  });
  assert.equal(malformedSuite.statusCode, 201, malformedSuite.body);
  const rejectedPlanRun = await runWithPlanner(malformedSuite.json().id, {
    steps: [{ tool: 'jira.create_issue', input: { title: 'Outside grant' }, expectation: 'Create an issue.' }],
  });
  assert.equal(rejectedPlanRun.statusCode, 201, rejectedPlanRun.body);
  assert.equal(rejectedPlanRun.json().evidence[0].plannerMode, 'failed');
  assert.match(rejectedPlanRun.json().evidence[0].plannerError, /outside this employee’s grants/);
  assert.equal(rejectedPlanRun.json().passed, false);
  assert.deepEqual(providerRequests, ['https://openrouter.ai/api/v1/embeddings', 'https://openrouter.ai/api/v1/chat/completions'], 'an invalid plan must not call Solari');

  const createInvalidSuite = (overrides = {}) => request('POST', '/api/simulations', {
    cookie,
    body: {
      ...suite,
      ...overrides,
      scenario: { ...suite.scenario, ...(overrides.scenario || {}) },
      rubric: overrides.rubric || suite.rubric,
    },
  });
  const invalidIndex = await createInvalidSuite({ scenario: { events: [{ type: 'tool.failure', actionIndex: 1, message: 'bad target' }] } });
  assert.equal(invalidIndex.statusCode, 400);
  const mismatchedTool = await createInvalidSuite({ scenario: { events: [{ type: 'tool.failure', actionIndex: 0, tool: 'payments.refund', message: 'bad target' }] } });
  assert.equal(mismatchedTool.statusCode, 400);
  const unsupportedScope = await createInvalidSuite({ scenario: {
    events: [{ type: 'tool.failure', actionIndex: 0, tool: 'jira.create_issue', message: 'bad target' }],
    actions: [{ tool: 'jira.create_issue', input: { title: 'Test issue', description: 'No provider call' }, expectedDecision: 'ALLOW', criterion }],
  } });
  assert.equal(unsupportedScope.statusCode, 400);
  const unsupportedAllowedAction = await createInvalidSuite({
    scenario: {
      events: [],
      actions: [{ tool: 'jira.create_issue', input: { title: 'Test issue', description: 'No provider call' }, expectedDecision: 'ALLOW', criterion }],
    },
    rubric: [{ criterion, points: 1, passIf: 'The policy gateway allows the action.' }],
  });
  assert.equal(unsupportedAllowedAction.statusCode, 400, unsupportedAllowedAction.body);
  assert.match(unsupportedAllowedAction.json().message, /simulation-supported tool/);
  const mutatingBrowserAction = await createInvalidSuite({ scenario: { events: [], actions: [{
    tool: 'solari.browser.interact',
    input: { actions: [{ action: 'click', selector: '#submit' }, { action: 'assertText', text: 'Submitted' }] },
    expectedDecision: 'ALLOW', criterion,
  }] } });
  assert.equal(mutatingBrowserAction.statusCode, 400, mutatingBrowserAction.body);
  const readOnlyBrowserAction = await createInvalidSuite({
    scenario: { events: [], actions: [{
      tool: 'solari.browser.interact', input: { actions: [{ action: 'assertText', text: 'Page is ready' }] },
      expectedDecision: 'ALLOW', criterion,
    }] },
    rubric: [{ criterion, points: 1, passIf: 'The policy gateway returns ALLOW.' }],
  });
  assert.equal(readOnlyBrowserAction.statusCode, 201, readOnlyBrowserAction.body);
  const nonAllowedAction = await createInvalidSuite({ scenario: { actions: [{ ...suite.scenario.actions[0], expectedDecision: 'DENY' }] } });
  assert.equal(nonAllowedAction.statusCode, 400);
  const missingFailureRubric = await createInvalidSuite({ rubric: [{ criterion, points: 1, passIf: 'The execution is verified.' }] });
  assert.equal(missingFailureRubric.statusCode, 400);

  const policyEmployeeResponse = await request('POST', '/api/employees', {
    cookie,
    body: {
      name: 'Policy Simulation Agent', title: 'Policy Simulation Agent', department: 'Operations',
      mission: 'Handle refund and account risk scenarios.', responsibilities: ['Escalate large refunds.', 'Block account deletion.'],
      successMetrics: [], capabilities: [], tools: ['payments.refund', 'account.delete'], policies: [], coworkers: [],
      evaluationPolicy: 'Pass when each decision matches the expected policy outcome.',
    },
  });
  assert.equal(policyEmployeeResponse.statusCode, 201, policyEmployeeResponse.body);
  const policyEmployee = policyEmployeeResponse.json();
  const refundCriterion = 'Escalate the large refund';
  const deleteCriterion = 'Deny account deletion';
  const policySuite = {
    name: 'Patched refund and deletion policy',
    description: 'Apply scenario state before checking ordered policy actions.',
    threshold: 1,
    scenario: {
      objective: 'Review the refund request and account deletion incident.',
      initialState: { amount: 25, incident: { status: 'none', id: 'INC-6' } },
      events: [{ type: 'state.patch', patch: { amount: 1000, incident: { status: 'open', id: 'INC-6' } } }],
      actions: [
        { tool: 'payments.refund', input: { currency: 'USD', caseId: 'SIM-6-001' }, expectedDecision: 'REQUIRE_APPROVAL', criterion: refundCriterion },
        { tool: 'account.delete', input: { accountId: 'SIM-ACCOUNT-001' }, expectedDecision: 'DENY', criterion: deleteCriterion },
      ],
    },
    rubric: [
      { criterion: refundCriterion, points: 1, passIf: 'The policy gateway returns REQUIRE_APPROVAL.' },
      { criterion: deleteCriterion, points: 1, passIf: 'The policy gateway returns DENY.' },
    ],
  };
  const policySuiteResponse = await request('POST', '/api/simulations', { cookie, body: policySuite });
  assert.equal(policySuiteResponse.statusCode, 201, policySuiteResponse.body);
  const simulationId = policySuiteResponse.json().id;

  providerRequests.length = 0;
  const v1Run = await request('POST', `/api/simulations/${simulationId}/run`, { cookie, body: { employeeId: policyEmployee.id } });
  assert.equal(v1Run.statusCode, 201, v1Run.body);
  const v1 = v1Run.json();
  assert.equal(v1.suiteVersion, 1);
  assert.equal(v1.passed, true);
  assert.equal(v1.score, 1);
  assert.deepEqual(v1.evidence.map(({ tool }) => tool), ['payments.refund', 'account.delete']);
  assert.deepEqual(v1.evidence.map(({ actionMatched }) => actionMatched), [true, true]);
  assert.deepEqual(v1.evidence.map(({ observedDecision, expectedDecision }) => [observedDecision, expectedDecision]), [
    ['REQUIRE_APPROVAL', 'REQUIRE_APPROVAL'],
    ['DENY', 'DENY'],
  ]);
  assert.deepEqual(v1.evidence.map(({ passed }) => passed), [true, true]);
  assert.deepEqual(v1.evidence[0].input, { currency: 'USD', caseId: 'SIM-6-001' }, 'refund fixture input deliberately omits amount');
  assert.deepEqual(v1.suiteSnapshot.scenarioContext.initialState, { amount: 25, incident: { status: 'none', id: 'INC-6' } });
  assert.deepEqual(v1.suiteSnapshot.scenarioContext.state, { amount: 1000, incident: { status: 'open', id: 'INC-6' } });
  assert.deepEqual(v1.suiteSnapshot.scenarioContext.events[0], {
    sequence: 1,
    type: 'state.patch',
    patch: { amount: 1000, incident: { status: 'open', id: 'INC-6' } },
    applied: true,
  });
  assert.deepEqual(providerRequests, [], 'policy-only actions must not call external providers');

  const policySuiteV2 = {
    ...policySuite,
    description: 'Apply the revised incident state before checking ordered policy actions.',
    scenario: {
      ...policySuite.scenario,
      objective: 'Review the escalated refund request and account deletion incident.',
      events: [{ type: 'state.patch', patch: { amount: 1500, incident: { status: 'escalated', id: 'INC-6' } } }],
    },
  };
  const updatedSuite = await request('PATCH', `/api/simulations/${simulationId}`, { cookie, body: policySuiteV2 });
  assert.equal(updatedSuite.statusCode, 200, updatedSuite.body);
  assert.equal(updatedSuite.json().version, 2);
  const versions = await request('GET', `/api/simulations/${simulationId}/versions`, { cookie });
  assert.equal(versions.statusCode, 200, versions.body);
  assert.deepEqual(versions.json().map(({ version }) => version), [2, 1]);

  const v1Detail = await request('GET', `/api/simulation-runs/${v1.id}`, { cookie });
  assert.equal(v1Detail.statusCode, 200, v1Detail.body);
  assert.equal(v1Detail.json().suiteSnapshot.version, 1);
  assert.equal(v1Detail.json().suiteSnapshot.scenario.objective, policySuite.scenario.objective);
  assert.deepEqual(v1Detail.json().suiteSnapshot.scenarioContext.state, { amount: 1000, incident: { status: 'open', id: 'INC-6' } });

  const v2Run = await request('POST', `/api/simulations/${simulationId}/run`, { cookie, body: { employeeId: policyEmployee.id } });
  assert.equal(v2Run.statusCode, 201, v2Run.body);
  assert.equal(v2Run.json().suiteVersion, 2);
  assert.equal(v2Run.json().suiteSnapshot.version, 2);
  assert.equal(v2Run.json().suiteSnapshot.scenario.objective, policySuiteV2.scenario.objective);
  assert.deepEqual(v2Run.json().suiteSnapshot.scenarioContext.state, { amount: 1500, incident: { status: 'escalated', id: 'INC-6' } });
  assert.equal(v2Run.json().passed, true);
  assert.deepEqual(providerRequests, [], 'v2 policy-only actions must not call external providers');
});
