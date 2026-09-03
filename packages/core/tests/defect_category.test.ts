import { describe, expect, it } from 'bun:test';
import { mapToDefectCategory, mapSeverity } from '../src/probe/defect-category.js';
import type { DefectCategory } from '../src/probe/types.js';

describe('mapToDefectCategory (OCP table)', () => {
  it('maps each keyword family to the correct DefectCategory', () => {
    // Ordering/precedence is part of the contract (first-match wins).
    const cases: Array<[string, DefectCategory]> = [
      ['goroutine leak', 'lifecycle_leak'],
      ['resource leak', 'lifecycle_leak'],
      ['data race condition', 'lifecycle_leak'],
      ['concurrency bug', 'lifecycle_leak'],
      ['redis cache stampede', 'distributed_cache'],
      ['unsafe FFI memory access', 'memory_abi'],
      ['ABI breaking change', 'memory_abi'],
      ['ReDoS backpressure', 'performance_backpressure'],
      ['DOS performance regression', 'performance_backpressure'],
      ['monotonic clock time drift', 'time_monotonicity'],
      ['DST time bug', 'time_monotonicity'],
      ['escape analysis gc pressure', 'escape_analysis'],
      ['integer overflow bound', 'numerical_bounds'],
      ['NaN crlf injection', 'numerical_bounds'],
      ['unused dead code', 'dead_code'],
      ['sql injection attack', 'security_cwe'],
      ['', 'security_cwe'],
    ];
    for (const [input, expected] of cases) {
      expect(mapToDefectCategory(input)).toBe(expected);
    }
  });

  it('respects rule precedence (leak wins over memory for "memory leak")', () => {
    expect(mapToDefectCategory('memory leak detected')).toBe('lifecycle_leak');
  });

  it('mapSeverity normalizes known severities', () => {
    expect(mapSeverity('ERROR')).toBe('high');
    expect(mapSeverity('CRITICAL')).toBe('high');
    expect(mapSeverity('WARNING')).toBe('medium');
    expect(mapSeverity(undefined)).toBe('medium');
    expect(mapSeverity('info')).toBe('low');
  });
});
