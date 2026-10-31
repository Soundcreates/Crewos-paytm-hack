import { HttpError } from './errors.mjs';

export function sendJson(response, status, value, extraHeaders = {}, traceStep = () => {}) {
  const body = JSON.stringify(value);
  traceStep('http.response.prepared', {
    status,
    contentType: 'application/json',
    responseBytes: Buffer.byteLength(body),
  });

  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  response.end(body);
}

export async function readRawBody(request, maxBytes, traceStep = () => {}) {
  traceStep('http.request.raw_body.started', {
    declaredBytes: Number(request.headers['content-length'] || 0),
    maxBytes,
  });

  if (Number(request.headers['content-length'] || 0) > maxBytes) {
    throw new HttpError(413, 'Request body is too large.');
  }

  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }

  traceStep('http.request.raw_body.completed', { bytes });
  return Buffer.concat(chunks);
}

export function readBody(request, maxBytes, traceStep = () => {}, traceErrorFields = () => ({})) {
  const startedAt = Date.now();
  const contentType = String(request.headers['content-type'] || '').split(';', 1)[0].slice(0, 80);
  let parsedBytes = 0;
  traceStep('http.request.json_body_parse.started', { contentType, maxBytes });

  return new Promise((resolveBody, reject) => {
    const declared = Number(request.headers['content-length'] || 0);
    if (declared > maxBytes) return reject(new HttpError(413, 'Request body is too large.'));

    const parts = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        request.destroy();
        reject(new HttpError(413, 'Request body is too large.'));
      } else {
        parts.push(chunk);
      }
    });
    request.on('end', () => {
      if (!bytes) return resolveBody({});
      if (!String(request.headers['content-type'] || '').includes('application/json')) {
        return reject(new HttpError(415, 'Send JSON with Content-Type: application/json.'));
      }

      try {
        parsedBytes = bytes;
        resolveBody(JSON.parse(Buffer.concat(parts).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Request body is not valid JSON.'));
      }
    });
    request.on('error', reject);
  }).then((body) => {
    traceStep('http.request.json_body_parse.completed', {
      durationMs: Date.now() - startedAt,
      bytes: parsedBytes,
      topLevelFields: Object.keys(body).length,
    });
    return body;
  }, (error) => {
    traceStep('http.request.json_body_parse.failed', {
      durationMs: Date.now() - startedAt,
      ...traceErrorFields(error),
    });
    throw error;
  });
}
