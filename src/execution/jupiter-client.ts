import { createLogger } from '../utils';

const log = createLogger('jupiter-client');

const API_KEY = process.env.JUPITER_API_KEY;
const MAX_BACKOFF_MS = 30_000;
const BASE_DELAY_MS = 1_000;

function getBackoffMs(attempt: number, retryAfterHeader: string | null): number {
  // Retry-After header takes precedence when present
  if (retryAfterHeader) {
    const sec = parseInt(retryAfterHeader, 10);
    if (!isNaN(sec) && sec > 0) return Math.min(sec * 1000, MAX_BACKOFF_MS);
  }
  // Exponential backoff with jitter as fallback
  const exp = BASE_DELAY_MS * Math.pow(2, attempt);
  return Math.min(exp, MAX_BACKOFF_MS) + Math.floor(Math.random() * 500);
}

function buildHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (API_KEY) headers['x-api-key'] = API_KEY;
  return headers;
}

function shouldRetry(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

export async function jupiterGet(url: string, maxRetries = 2, signal?: AbortSignal): Promise<Response> {
  let lastRes: Response | undefined;
  for (let i = 0; i <= maxRetries; i++) {
    lastRes = await fetch(url, { headers: buildHeaders(), signal });
    if (shouldRetry(lastRes.status)) {
      const backoffMs = getBackoffMs(i, lastRes.headers.get('retry-after'));
      log.warn('Jupiter GET error, backing off', { status: lastRes.status, backoffMs, attempt: i + 1 });
      if (i < maxRetries) await new Promise(r => setTimeout(r, backoffMs));
      continue;
    }
    return lastRes;
  }
  return lastRes!;
}

export async function jupiterPost(url: string, body: unknown, maxRetries = 2, signal?: AbortSignal): Promise<Response> {
  let lastRes: Response | undefined;
  for (let i = 0; i <= maxRetries; i++) {
    lastRes = await fetch(url, {
      method: 'POST',
      headers: buildHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal,
    });
    if (shouldRetry(lastRes.status)) {
      const backoffMs = getBackoffMs(i, lastRes.headers.get('retry-after'));
      log.warn('Jupiter POST error, backing off', { status: lastRes.status, backoffMs, attempt: i + 1 });
      if (i < maxRetries) await new Promise(r => setTimeout(r, backoffMs));
      continue;
    }
    return lastRes;
  }
  return lastRes!;
}
