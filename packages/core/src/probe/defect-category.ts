import type { DefectCategory } from './types.js';

/**
 * Ordered keyword → category rules. `mapToDefectCategory` walks this table from
 * top to bottom and returns the first category whose keyword set matches. Adding
 * a new mapping is a one-line table addition — no branch edits (OCP).
 *
 * Order matters: it mirrors the original `if/else` precedence exactly so behavior
 * is preserved.
 */
const DEFECT_CATEGORY_RULES: ReadonlyArray<{ category: DefectCategory; keywords: readonly string[] }> = [
  { category: 'lifecycle_leak', keywords: ['leak', 'resource', 'goroutine'] },
  { category: 'lifecycle_leak', keywords: ['race', 'concurrency', 'thread'] },
  { category: 'distributed_cache', keywords: ['cache', 'stampede'] },
  { category: 'memory_abi', keywords: ['abi', 'memory', 'unsafe', 'ffi'] },
  { category: 'performance_backpressure', keywords: ['performance', 'dos', 'backpressure', 'redos'] },
  { category: 'time_monotonicity', keywords: ['time', 'clock', 'dst'] },
  { category: 'escape_analysis', keywords: ['escape', 'gc'] },
  { category: 'numerical_bounds', keywords: ['bound', 'overflow', 'nan', 'crlf'] },
  { category: 'dead_code', keywords: ['dead', 'unused'] },
];

/** Map a free-form category string to the closed set of `DefectCategory` values. */
export function mapToDefectCategory(cat: string): DefectCategory {
  const lower = cat.toLowerCase();
  for (const rule of DEFECT_CATEGORY_RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
      return rule.category;
    }
  }
  return 'security_cwe';
}

export function mapSeverity(sev?: string): 'low' | 'medium' | 'high' | 'critical' {
  if (!sev) return 'medium';
  const s = sev.toUpperCase();
  if (s === 'ERROR' || s === 'CRITICAL') return 'high';
  if (s === 'WARNING') return 'medium';
  return 'low';
}
