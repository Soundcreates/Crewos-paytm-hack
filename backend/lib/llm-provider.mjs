const DEFAULT_DEVELOPMENT_URL = 'http://127.0.0.1:8317/v1';
const DEFAULT_MODELS = {
  chat: 'openai/gpt-4o-mini',
  embedding: 'openai/text-embedding-3-small',
  transcription: 'openai/whisper-1',
};
const endpoints = new Set(['models', 'chat/completions', 'embeddings', 'audio/transcriptions']);

function environment() {
  return process.env;
}

export function isLocalLlmProvider() {
  return environment().NODE_ENV === 'development';
}

export function getLlmBaseUrl() {
  if (!isLocalLlmProvider()) return 'https://openrouter.ai/api/v1';
  const value = environment().DEV_LLM_BASE_URL?.trim() || DEFAULT_DEVELOPMENT_URL;
  let url;
  try { url = new URL(value); }
  catch { throw new Error('DEV_LLM_BASE_URL must be an absolute HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('DEV_LLM_BASE_URL must be an HTTP or HTTPS base URL without credentials, query, or hash.');
  }
  return url.toString().replace(/\/+$/, '');
}

export function getLlmApiKey(integrationKey = null) {
  const env = environment();
  const value = isLocalLlmProvider()
    ? env.DEV_LLM_API_KEY
    : integrationKey || env.OPENROUTER_API_KEY;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function getLlmProviderName() {
  return isLocalLlmProvider() ? 'local-openai-compatible' : 'openrouter';
}

export function getLlmProviderLabel() {
  return isLocalLlmProvider() ? 'the local OpenAI-compatible LLM endpoint' : 'OpenRouter';
}

export function getLlmModel(purpose = 'chat') {
  const env = environment();
  if (isLocalLlmProvider()) {
    if (purpose === 'evaluator') return env.DEV_LLM_EVALUATOR_MODEL || undefined;
    if (purpose === 'embedding') return env.DEV_LLM_EMBEDDING_MODEL || undefined;
    if (purpose === 'transcription') return env.DEV_LLM_TRANSCRIPTION_MODEL || undefined;
    return env.DEV_LLM_MODEL || 'gpt-6-luna';
  }
  if (purpose === 'evaluator') {
    return env.OPENROUTER_EVALUATOR_MODEL || undefined;
  }
  const configuredName = purpose === 'embedding' ? 'OPENROUTER_EMBEDDING_MODEL'
    : purpose === 'transcription' ? 'OPENROUTER_TRANSCRIPTION_MODEL' : 'OPENROUTER_MODEL';
  return env[configuredName] || DEFAULT_MODELS[purpose] || DEFAULT_MODELS.chat;
}

export async function requestLlm(path, { apiKey, body, formData, method, timeoutMs = 60000, signal } = {}) {
  const route = String(path || '').replace(/^\/+/, '');
  if (!endpoints.has(route)) throw new Error(`Unsupported LLM API endpoint: ${route || '(empty)'}.`);
  const httpMethod = method || (route === 'models' ? 'GET' : 'POST');
  if ((route === 'models' && httpMethod !== 'GET') || (route !== 'models' && httpMethod !== 'POST')) {
    throw new Error(`Unsupported HTTP method for LLM endpoint ${route}.`);
  }
  const credential = getLlmApiKey(apiKey);
  if (!credential) {
    const error = new Error(`${getLlmProviderLabel()} is not configured. Set DEV_LLM_API_KEY for development or OPENROUTER_API_KEY for production.`);
    Object.assign(error, { code: 'provider_unavailable', httpStatus: 503 });
    throw error;
  }
  const headers = { authorization: `Bearer ${credential}` };
  let requestBody;
  if (formData !== undefined) requestBody = formData;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    requestBody = JSON.stringify(body);
  }
  const url = `${getLlmBaseUrl()}/${route}`;
  try {
    return await fetch(url, {
      method: httpMethod,
      headers,
      ...(requestBody === undefined ? {} : { body: requestBody }),
      signal: signal || AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const error = new Error(`Could not reach ${getLlmProviderLabel()} at ${getLlmBaseUrl()}.`, { cause });
    Object.assign(error, { code: 'provider_unavailable', httpStatus: 503 });
    throw error;
  }
}
