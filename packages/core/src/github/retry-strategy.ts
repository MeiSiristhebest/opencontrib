import type { ApiResult, ApiStatus } from './types.js';

/**
 * Maps an arbitrary Octokit/network error to the project's `ApiStatus`
 * taxonomy and whether the failure is worth retrying. Pure function — no I/O,
 * no clock — so it is trivially unit-testable.
 */
export function mapErrorToApiStatus(err: any): {
  status: ApiStatus;
  statusCode?: number;
  isRetryable: boolean;
} {
  const status = err?.status || err?.statusCode;
  if (status === 404) return { status: 'NOT_FOUND', statusCode: 404, isRetryable: false };
  if (status === 401) return { status: 'FORBIDDEN', statusCode: 401, isRetryable: false };
  if (status === 403) {
    const isRateLimit =
      err?.response?.headers?.['x-ratelimit-remaining'] === '0' ||
      /rate limit|secondary rate/i.test(err?.message || '');
    return {
      status: isRateLimit ? 'RATE_LIMITED' : 'FORBIDDEN',
      statusCode: 403,
      isRetryable: isRateLimit,
    };
  }
  if (status === 429) return { status: 'RATE_LIMITED', statusCode: 429, isRetryable: true };
  if (status >= 500 && status <= 504)
    return { status: 'UNKNOWN_ERROR', statusCode: status, isRetryable: true };
  if (
    err?.code === 'ENOTFOUND' ||
    err?.code === 'ECONNREFUSED' ||
    err?.code === 'ETIMEDOUT' ||
    err?.name === 'FetchError'
  ) {
    return { status: 'NETWORK_ERROR', isRetryable: true };
  }
  return { status: 'UNKNOWN_ERROR', statusCode: status, isRetryable: false };
}

/**
 * Honors `retry-after` / `x-ratelimit-reset` headers, then falls back to
 * exponential backoff with full jitter. The sleep is injectable so tests can
 * run instantly.
 */
export function getRetryDelayMs(err: any, attempt: number): number {
  const headers = err?.response?.headers;
  if (headers) {
    if (headers['retry-after']) {
      const seconds = parseInt(headers['retry-after'], 10);
      if (!isNaN(seconds)) return Math.min(60000, seconds * 1000);
    }
    if (headers['x-ratelimit-reset']) {
      const resetTime = parseInt(headers['x-ratelimit-reset'], 10) * 1000;
      const diff = resetTime - Date.now();
      if (diff > 0 && diff < 60000) return diff + 500;
    }
  }
  // True exponential backoff with full jitter: (2^attempt * 1000ms) + random jitter (0-500ms)
  const baseDelay = Math.min(16000, Math.pow(2, attempt) * 1000);
  const jitter = Math.floor(Math.random() * 500);
  return baseDelay + jitter;
}

/**
 * Unified resilient request wrapper with exponential backoff and jitter.
 * Extracted from `GitHubClient` as a standalone, dependency-free function.
 */
export async function requestWithRetry<T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<ApiResult<T>> {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      const data = await operation();
      return { status: 'OK', data };
    } catch (err: any) {
      attempt++;
      const { status, statusCode, isRetryable } = mapErrorToApiStatus(err);
      if (isRetryable && attempt < maxRetries) {
        const delay = getRetryDelayMs(err, attempt);
        await sleep(delay);
        continue;
      }
      return {
        status,
        data: null as any,
        error: err?.message || String(err),
        statusCode,
      };
    }
  }
  return {
    status: 'UNKNOWN_ERROR',
    data: null as any,
    error: 'Max retries exhausted',
  };
}
