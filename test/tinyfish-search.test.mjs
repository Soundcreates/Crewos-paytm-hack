import assert from 'node:assert/strict';
import test from 'node:test';
import { runTinyFishSearch } from '../backend/lib/tinyfish-search.mjs';

test('TinyFish Search sends an authenticated request with documented filters and normalizes public sources', async () => {
  let request;
  const result = await runTinyFishSearch({
    query: 'AI fitness tracker market demand',
    purpose: 'Find credible demand evidence.',
    location: 'us',
    language: 'EN',
    includeDomains: ['example.com', 'docs.tinyfish.ai'],
    excludeDomains: ['spam.example'],
    domainType: 'news',
    recencyMinutes: 1440,
    page: 2,
  }, {
    apiKey: 'test-api-key',
    fetchImpl: async (url, options) => {
      request = { url: new URL(url), options };
      return Response.json({
        query: 'normalized query',
        total_results: 27,
        page: 2,
        results: [
          { title: 'Market report', site_name: 'Example', snippet: 'Demand evidence.', url: 'https://example.com/report#section', position: 4, date: '2026-10-01' },
          { title: 'Unsafe', url: 'javascript:alert(1)' },
          { title: 'Credentials in URL', url: 'https://user:password@example.com/private' },
        ],
      });
    },
  });

  assert.equal(request.url.origin + request.url.pathname, 'https://api.search.tinyfish.ai/');
  assert.equal(request.options.method, 'GET');
  assert.equal(request.options.headers['X-API-Key'], 'test-api-key');
  assert.equal(request.url.searchParams.get('query'), 'AI fitness tracker market demand');
  assert.equal(request.url.searchParams.get('purpose'), 'Find credible demand evidence.');
  assert.equal(request.url.searchParams.get('location'), 'US');
  assert.equal(request.url.searchParams.get('language'), 'en');
  assert.equal(request.url.searchParams.get('include_domains'), 'example.com,docs.tinyfish.ai');
  assert.equal(request.url.searchParams.get('exclude_domains'), 'spam.example');
  assert.equal(request.url.searchParams.get('domain_type'), 'news');
  assert.equal(request.url.searchParams.get('recency_minutes'), '1440');
  assert.equal(request.url.searchParams.get('page'), '2');
  assert.equal(result.provider, 'tinyfish-search');
  assert.equal(result.query, 'normalized query');
  assert.equal(result.totalResults, 27);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].url, 'https://example.com/report');
});

test('TinyFish Search rejects a missing key before attempting network access', async () => {
  let requests = 0;
  await assert.rejects(
    runTinyFishSearch({ query: 'market demand' }, { apiKey: '', fetchImpl: async () => { requests += 1; } }),
    (error) => error.code === 'tinyfish_not_configured' && error.httpStatus === 503,
  );
  assert.equal(requests, 0);
});

test('TinyFish Search reports account plan and authentication errors without exposing provider bodies', async () => {
  for (const [status, code, message] of [
    [401, 'tinyfish_request_failed', 'TinyFish rejected TINY_FISH_API_KEY.'],
    [402, 'tinyfish_request_failed', 'TinyFish Search API access is not enabled for this account.'],
    [429, 'tinyfish_unavailable', 'TinyFish Search rate limit reached.'],
  ]) {
    await assert.rejects(
      runTinyFishSearch({ query: 'market demand' }, {
        apiKey: 'test-api-key',
        fetchImpl: async () => new Response('private upstream detail', { status }),
      }),
      (error) => error.code === code && error.httpStatus === status && error.message === message && !error.message.includes('private upstream detail'),
    );
  }
});

test('TinyFish Search validates date ranges, search type, and domains before sending a request', async () => {
  let requests = 0;
  const options = { apiKey: 'test-api-key', fetchImpl: async () => { requests += 1; return Response.json({ results: [] }); } };
  await assert.rejects(runTinyFishSearch({ query: 'market', afterDate: '2026-02-30' }, options), (error) => error.code === 'invalid_tinyfish_input');
  await assert.rejects(runTinyFishSearch({ query: 'market', afterDate: '2026-10-02', beforeDate: '2026-10-01' }, options), (error) => error.code === 'invalid_tinyfish_input');
  await assert.rejects(runTinyFishSearch({ query: 'market', domainType: 'blog' }, options), (error) => error.code === 'invalid_tinyfish_input');
  await assert.rejects(runTinyFishSearch({ query: 'market', includeDomains: ['not a domain'] }, options), (error) => error.code === 'invalid_tinyfish_input');
  assert.equal(requests, 0);
});

test('TinyFish Search accepts publication-year filters for paper search and rejects conflicting date filters', async () => {
  let requestUrl;
  const fetchImpl = async (url) => { requestUrl = new URL(url); return Response.json({ results: [] }); };
  await runTinyFishSearch({ query: 'agent architectures', domainType: 'research_paper', pubYearMin: 2022, pubYearMax: 2026 }, { apiKey: 'test-api-key', fetchImpl });
  assert.equal(requestUrl.searchParams.get('pub_year_min'), '2022');
  assert.equal(requestUrl.searchParams.get('pub_year_max'), '2026');
  await assert.rejects(
    runTinyFishSearch({ query: 'agent architectures', domainType: 'research_paper', afterDate: '2026-01-01' }, { apiKey: 'test-api-key', fetchImpl }),
    (error) => error.code === 'invalid_tinyfish_input',
  );
});
