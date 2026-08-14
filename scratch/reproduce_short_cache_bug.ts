/**
 * Empirical Reproduction Script for Flowgram.ai createShortCache Bug
 */

// 1. FlowGram's CURRENT buggy implementation in packages/common/utils/src/cache.ts
function originalCreateShortCache<T>(timeout = 1000) {
  let cache: T | undefined;
  let timeoutId: any;

  function updateTimeout(): void {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      timeoutId = undefined;
      cache = undefined;
    }, timeout);
  }

  return {
    get(getValue: () => T): T {
      if (cache) { // ❌ BUG HERE: if cache is false, 0, "", or null, this check FAILS!
        updateTimeout();
        return cache;
      }
      cache = getValue();
      updateTimeout();
      return cache;
    },
  };
}

// 2. Proposed Fixed Implementation
function fixedCreateShortCache<T>(timeout = 1000) {
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

  return {
    get(getValue: () => T): T {
      if (hasCache) { // ✅ FIXED: correctly preserves cached false, 0, "", null
        updateTimeout();
        return cache as T;
      }
      cache = getValue();
      hasCache = true;
      updateTimeout();
      return cache;
    },
    dispose(): void {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = undefined;
      hasCache = false;
      cache = undefined;
    },
  };
}

console.log('=== TEST 1: Caching boolean `false` (e.g. isNodeSelected / isValid) ===');
let originalFalseComputeCount = 0;
const originalCache = originalCreateShortCache<boolean>(5000);
const getFalse = () => {
  originalFalseComputeCount++;
  return false;
};

const res1 = originalCache.get(getFalse);
const res2 = originalCache.get(getFalse);
const res3 = originalCache.get(getFalse);

console.log(`Original Implementation:`);
console.log(`- Requested 3 times with value = false`);
console.log(`- Compute function was called: ${originalFalseComputeCount} times (EXPECTED: 1 time)`);
console.log(`- Bug Verified? ${originalFalseComputeCount === 3 ? '🔴 YES, CACHE BYPASSED 3 TIMES (BUG CONFIRMED)' : 'NO'}`);

console.log('\n=== TEST 2: Caching number `0` (e.g. scrollOffset / zoomLevel / index) ===');
let originalZeroComputeCount = 0;
const getZero = () => {
  originalZeroComputeCount++;
  return 0;
};
originalCache.get(getZero);
originalCache.get(getZero);
console.log(`Original Implementation:`);
console.log(`- Requested 2 times with value = 0`);
console.log(`- Compute function was called: ${originalZeroComputeCount} times (EXPECTED: 1 time)`);
console.log(`- Bug Verified? ${originalZeroComputeCount === 2 ? '🔴 YES, CACHE BYPASSED 2 TIMES (BUG CONFIRMED)' : 'NO'}`);

console.log('\n=== TEST 3: Verifying Fixed Implementation ===');
let fixedFalseComputeCount = 0;
const fixedCache = fixedCreateShortCache<boolean>(5000);
const getFixedFalse = () => {
  fixedFalseComputeCount++;
  return false;
};

fixedCache.get(getFixedFalse);
fixedCache.get(getFixedFalse);
fixedCache.get(getFixedFalse);

console.log(`Fixed Implementation:`);
console.log(`- Requested 3 times with value = false`);
console.log(`- Compute function was called: ${fixedFalseComputeCount} times (EXPECTED: 1 time)`);
console.log(`- Fix Verified? ${fixedFalseComputeCount === 1 ? '🟢 YES, PROPERLY CACHED' : 'NO'}`);

fixedCache.dispose();
