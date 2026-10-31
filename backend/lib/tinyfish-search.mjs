const SEARCH_ENDPOINT = 'https://api.search.tinyfish.ai/';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESULTS = 20;

function fail(message, code = 'tinyfish_request_failed', httpStatus = 502) {
  return Object.assign(new Error(message), { code, httpStatus });
}

function optionalString(value, name, maxLength) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.trim().length > maxLength) {
    throw fail(`${name} must be a string of at most ${maxLength} characters.`, 'invalid_tinyfish_input', 400);
  }
  const cleaned = value.trim();
  return cleaned || undefined;
}

function cleanDomains(value, name) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10) {
    throw fail(`${name} must contain at most 10 domain names.`, 'invalid_tinyfish_input', 400);
  }
  const domains = value.map((item) => {
    if (typeof item !== 'string') throw fail(`${name} entries must be domain names.`, 'invalid_tinyfish_input', 400);
    const domain = item.trim().toLowerCase().replace(/\.$/, '');
    const labels = domain.split('.');
    if (domain.length > 253 || labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw fail(`${name} entries must be valid bare domain names.`, 'invalid_tinyfish_input', 400);
    }
    return domain;
  });
  return [...new Set(domains)];
}

function isoDate(value, name) {
  const cleaned = optionalString(value, name, 10);
  if (cleaned === undefined) return undefined;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(cleaned) ? new Date(`${cleaned}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== cleaned) {
    throw fail(`${name} must be a real calendar date in YYYY-MM-DD format.`, 'invalid_tinyfish_input', 400);
  }
  return cleaned;
}

function integerOption(value, name, minimum, maximum) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw fail(`${name} must be an integer from ${minimum} to ${maximum}.`, 'invalid_tinyfish_input', 400);
  }
  return value;
}

function publicHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function boundedText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeResult(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const url = publicHttpUrl(item.url);
  if (!url) return null;
  return {
    position: Number.isInteger(item.position) ? item.position : index + 1,
    siteName: boundedText(item.site_name, 253),
    title: boundedText(item.title, 500),
    snippet: boundedText(item.snippet, 3000),
    url,
    ...(typeof item.date === 'string' ? { date: boundedText(item.date, 40) } : {}),
    ...(typeof item.publisher === 'string' ? { publisher: boundedText(item.publisher, 300) } : {}),
    ...(Array.isArray(item.authors) ? { authors: item.authors.filter((author) => typeof author === 'string').slice(0, 20).map((author) => boundedText(author, 200)) } : {}),
    ...(typeof item.venue === 'string' ? { venue: boundedText(item.venue, 300) } : {}),
    ...(Number.isInteger(item.year) ? { year: item.year } : {}),
    ...(Number.isInteger(item.cited_by_count) ? { citedByCount: item.cited_by_count } : {}),
    ...(publicHttpUrl(item.pdf_url) ? { pdfUrl: publicHttpUrl(item.pdf_url) } : {}),
  };
}

function searchUrl(input) {
  const query = optionalString(input?.query, 'query', 500);
  if (!query || query.length < 2) throw fail('Enter a search query with at least 2 characters.', 'invalid_tinyfish_input', 400);
  const params = new URLSearchParams({ query });
  const purpose = optionalString(input?.purpose, 'purpose', 2000);
  const location = optionalString(input?.location, 'location', 8);
  const language = optionalString(input?.language, 'language', 12);
  if (purpose) params.set('purpose', purpose);
  if (location) params.set('location', location.toUpperCase());
  if (language) params.set('language', language.toLowerCase());

  const includeDomains = cleanDomains(input?.includeDomains, 'includeDomains');
  const excludeDomains = cleanDomains(input?.excludeDomains, 'excludeDomains');
  if (includeDomains?.length) params.set('include_domains', includeDomains.join(','));
  if (excludeDomains?.length) params.set('exclude_domains', excludeDomains.join(','));

  const domainType = optionalString(input?.domainType, 'domainType', 20) || 'web';
  if (!['web', 'news', 'research_paper'].includes(domainType)) throw fail('domainType must be web, news, or research_paper.', 'invalid_tinyfish_input', 400);
  params.set('domain_type', domainType);

  const recencyMinutes = integerOption(input?.recencyMinutes, 'recencyMinutes', 1, 5_256_000);
  const afterDate = isoDate(input?.afterDate, 'afterDate');
  const beforeDate = isoDate(input?.beforeDate, 'beforeDate');
  if (recencyMinutes !== undefined && (afterDate || beforeDate)) throw fail('Use recencyMinutes or afterDate/beforeDate, not both.', 'invalid_tinyfish_input', 400);
  if (afterDate && beforeDate && afterDate > beforeDate) throw fail('afterDate must be on or before beforeDate.', 'invalid_tinyfish_input', 400);
  if (domainType === 'research_paper' && (recencyMinutes !== undefined || afterDate || beforeDate)) {
    throw fail('Use pubYearMin/pubYearMax instead of date filters for research_paper searches.', 'invalid_tinyfish_input', 400);
  }
  if (recencyMinutes !== undefined) params.set('recency_minutes', String(recencyMinutes));
  if (afterDate) params.set('after_date', afterDate);
  if (beforeDate) params.set('before_date', beforeDate);

  const page = integerOption(input?.page, 'page', 0, 10);
  if (page !== undefined) params.set('page', String(page));
  const pubYearMin = integerOption(input?.pubYearMin, 'pubYearMin', 0, 9999);
  const pubYearMax = integerOption(input?.pubYearMax, 'pubYearMax', 0, 9999);
  if (pubYearMin !== undefined && pubYearMax !== undefined && pubYearMin > pubYearMax) {
    throw fail('pubYearMin must not be greater than pubYearMax.', 'invalid_tinyfish_input', 400);
  }
  if ((pubYearMin !== undefined || pubYearMax !== undefined) && domainType !== 'research_paper') {
    throw fail('pubYearMin and pubYearMax are only available for research_paper searches.', 'invalid_tinyfish_input', 400);
  }
  if (pubYearMin !== undefined) params.set('pub_year_min', String(pubYearMin));
  if (pubYearMax !== undefined) params.set('pub_year_max', String(pubYearMax));
  return { query, url: `${SEARCH_ENDPOINT}?${params}` };
}

export async function runTinyFishSearch(input, { apiKey = process.env.TINY_FISH_API_KEY, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const { query, url } = searchUrl(input);
  const credential = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!credential) throw fail('TinyFish Search is not configured. Set TINY_FISH_API_KEY on the backend and restart it.', 'tinyfish_not_configured', 503);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { 'X-API-Key': credential, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const timedOut = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
    throw fail(timedOut ? 'TinyFish Search timed out.' : 'Could not reach the TinyFish Search API.', timedOut ? 'tinyfish_timeout' : 'tinyfish_unavailable', 503);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const guidance = response.status === 401 ? 'TinyFish rejected TINY_FISH_API_KEY.'
      : response.status === 402 ? 'TinyFish Search API access is not enabled for this account.'
        : response.status === 429 ? 'TinyFish Search rate limit reached.'
          : response.status === 503 ? 'TinyFish Search is temporarily unavailable.'
            : `TinyFish Search request failed (HTTP ${response.status}).`;
    throw fail(guidance, response.status === 429 || response.status === 503 ? 'tinyfish_unavailable' : 'tinyfish_request_failed', response.status);
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw fail('TinyFish Search returned invalid JSON.'); }
  if (!payload || !Array.isArray(payload.results)) throw fail('TinyFish Search returned an unexpected result shape.');
  const maxItems = integerOption(input?.maxItems, 'maxItems', 1, MAX_RESULTS) ?? MAX_RESULTS;
  const results = payload.results.slice(0, maxItems).map(normalizeResult).filter(Boolean);
  return {
    ok: true,
    provider: 'tinyfish-search',
    query: boundedText(payload.query, 500) || query,
    totalResults: Number.isFinite(payload.total_results) ? payload.total_results : results.length,
    page: Number.isInteger(payload.page) ? payload.page : (input?.page || 0),
    results,
  };
}

export const tinyFishSearchInternals = { searchUrl, normalizeResult };
