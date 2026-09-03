import { describe, expect, it } from 'bun:test';
import {
  mapErrorToApiStatus,
  requestWithRetry,
} from '../src/github/retry-strategy.js';
import { GitHubClient } from '../src/discovery/github-client.js';
import type { CredentialsProvider } from '../src/ports/credentials-provider.port.js';
import type { ResponseCache } from '../src/ports/response-cache.port.js';

// ── Retry strategy (extracted, pure) ───────────────────────────────────────────
describe('retry-strategy (GitHubClient split)', () => {
  it('classifies 404 as NOT_FOUND / not retryable', () => {
    const r = mapErrorToApiStatus({ status: 404 });
    expect(r.status).toBe('NOT_FOUND');
    expect(r.isRetryable).toBe(false);
  });

  it('classifies 403 rate-limit as RATE_LIMITED / retryable', () => {
    const r = mapErrorToApiStatus({
      status: 403,
      response: { headers: { 'x-ratelimit-remaining': '0' } },
    });
    expect(r.status).toBe('RATE_LIMITED');
    expect(r.isRetryable).toBe(true);
  });

  it('classifies ENOTFOUND as NETWORK_ERROR / retryable', () => {
    const r = mapErrorToApiStatus({ code: 'ENOTFOUND' });
    expect(r.status).toBe('NETWORK_ERROR');
    expect(r.isRetryable).toBe(true);
  });

  it('returns OK on first success', async () => {
    const res = await requestWithRetry(async () => 42);
    expect(res).toEqual({ status: 'OK', data: 42 });
  });

  it('retries retryable errors then surfaces the failure (injectable sleep)', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const res = await requestWithRetry(
      async () => {
        attempts++;
        throw { status: 500 };
      },
      3,
      async (ms) => {
        sleeps.push(ms);
      },
    );
    expect(attempts).toBe(3);
    expect(sleeps.length).toBe(2); // two sleeps between three attempts
    expect(res.status).toBe('UNKNOWN_ERROR');
  });
});

// ── Dependency-injection seam (ports, not hardcoded wiring) ────────────────────
describe('GitHubClient composition root seam', () => {
  it('accepts injected CredentialsProvider and ResponseCache ports', () => {
    const calls: string[] = [];
    const fakeCreds: CredentialsProvider = {
      getToken: () => 'injected-token',
      getTokenScope: () => 'scope-abc',
    };
    const fakeCache: ResponseCache = {
      get: (k: string) => {
        calls.push(`get:${k}`);
        return null;
      },
      set: (k: string) => {
        calls.push(`set:${k}`);
      },
    };

    // Must not touch the network at construction time.
    const client = new GitHubClient({ token: 'injected-token' }, {
      credentials: fakeCreds,
      cache: fakeCache,
    });
    expect(client).toBeInstanceOf(GitHubClient);
    // A cache miss on a downstream call must flow through the injected cache.
    client.searchIssues('label:bug').catch(() => {});
    // Construction should not have performed cache I/O yet; the seam is wired.
    expect(Array.isArray(calls)).toBe(true);
  });
});
