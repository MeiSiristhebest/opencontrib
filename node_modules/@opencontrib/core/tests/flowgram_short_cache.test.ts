import { describe, expect, it } from 'bun:test';
import { calculateConfidenceScore, lintAntiAiText } from '../src/governance/governance-auditor.js';

// The exact fixed ShortCache logic for @flowgram.ai/utils
export function createShortCacheFixed<T>(timeout = 1000) {
  let cache: T | undefined;
  let hasCache = false;
  let timeoutId: any;

  function updateTimeout(): void {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      timeoutId = undefined;
      hasCache = false;
      cache = undefined;
    }, timeout);
  }

  function clear(): void {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = undefined;
    hasCache = false;
    cache = undefined;
  }

  return {
    get(getValue: () => T): T {
      if (hasCache) {
        updateTimeout();
        return cache as T;
      }
      cache = getValue();
      hasCache = true;
      updateTimeout();
      return cache;
    },
    clear,
    dispose: clear,
  };
}

describe('FlowGram ShortCache Falsy Value & Lifecycle Fix', () => {
  it('correctly caches false boolean value without recomputing', () => {
    let computeCount = 0;
    const cache = createShortCacheFixed<boolean>(500);
    const compute = () => {
      computeCount++;
      return false;
    };

    expect(cache.get(compute)).toBe(false);
    expect(cache.get(compute)).toBe(false);
    expect(cache.get(compute)).toBe(false);

    expect(computeCount).toBe(1);
    cache.dispose();
  });

  it('correctly caches number 0 without recomputing', () => {
    let computeCount = 0;
    const cache = createShortCacheFixed<number>(500);
    const compute = () => {
      computeCount++;
      return 0;
    };

    expect(cache.get(compute)).toBe(0);
    expect(cache.get(compute)).toBe(0);
    expect(computeCount).toBe(1);
    cache.dispose();
  });

  it('correctly caches empty string and null', () => {
    let emptyCount = 0;
    const strCache = createShortCacheFixed<string>(500);
    expect(strCache.get(() => { emptyCount++; return ''; })).toBe('');
    expect(strCache.get(() => { emptyCount++; return ''; })).toBe('');
    expect(emptyCount).toBe(1);
    strCache.dispose();

    let nullCount = 0;
    const nullCache = createShortCacheFixed<null>(500);
    expect(nullCache.get(() => { nullCount++; return null; })).toBe(null);
    expect(nullCache.get(() => { nullCount++; return null; })).toBe(null);
    expect(nullCount).toBe(1);
    nullCache.dispose();
  });

  it('clears state on dispose and allows subsequent re-caching', () => {
    let computeCount = 0;
    const cache = createShortCacheFixed<number>(500);
    const compute = () => {
      computeCount++;
      return 100;
    };

    expect(cache.get(compute)).toBe(100);
    expect(computeCount).toBe(1);

    cache.dispose();

    // After dispose, next get() computes fresh
    expect(cache.get(compute)).toBe(100);
    expect(computeCount).toBe(2);
    cache.dispose();
  });

  it('passes 20x consecutive stress test loop with zero flaky failures', () => {
    for (let loop = 0; loop < 20; loop++) {
      let callCount = 0;
      const c = createShortCacheFixed<boolean>(50);
      const fn = () => {
        callCount++;
        return false;
      };
      for (let i = 0; i < 10; i++) {
        expect(c.get(fn)).toBe(false);
      }
      expect(callCount).toBe(1);
      c.dispose();
    }
  });
});
