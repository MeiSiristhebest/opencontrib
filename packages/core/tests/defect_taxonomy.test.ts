import { describe, expect, it } from 'bun:test';
import {
  DEFECT_TAXONOMY_CATALOG,
  queryTaxonomyCatalog,
  type DefectDomain,
} from '../src/probe/catalog/defect-taxonomy.js';

describe('7-Domain Defect Pattern Taxonomy & Federated Rule Catalog', () => {
  it('covers all 7 core defect domains with structured metadata', () => {
    const requiredDomains: DefectDomain[] = [
      'PROTOCOL_NORMALIZATION',
      'CONCURRENCY_RACE',
      'LIFECYCLE_LEAK',
      'ASYNC_FLOW',
      'DATA_INTEGRITY',
      'LANGUAGE_TRAPS',
      'AGENT_INFRASTRUCTURE',
    ];

    for (const domain of requiredDomains) {
      const patterns = queryTaxonomyCatalog({ domain });
      expect(patterns.length).toBeGreaterThan(0);
      for (const p of patterns) {
        expect(p.id).toBeDefined();
        expect(p.cwe).toMatch(/^CWE-\d+$/);
        expect(p.categoryMultiplier).toBeGreaterThanOrEqual(1.0);
        expect(p.remediationGuide.length).toBeGreaterThan(10);
      }
    }
  });

  it('queries taxonomy catalog dynamically by language and minimum severity', () => {
    const goPatterns = queryTaxonomyCatalog({ language: 'go', minSeverity: 'error' });
    expect(goPatterns.length).toBeGreaterThanOrEqual(3);
    expect(goPatterns.every((p) => p.language === 'go' || p.language === 'polyglot')).toBe(true);
    expect(goPatterns.every((p) => p.severity === 'error')).toBe(true);

    const tsPatterns = queryTaxonomyCatalog({ language: 'typescript' });
    expect(tsPatterns.some((p) => p.id === 'ts-ssrf-bracketed-ipv6-bypass')).toBe(true);
    expect(tsPatterns.some((p) => p.id === 'ts-floating-promise-unhandled')).toBe(true);
  });

  it('contains actionable fix templates for automated AST rewrites', () => {
    const fixable = DEFECT_TAXONOMY_CATALOG.filter((p) => p.fixTemplate !== undefined);
    expect(fixable.length).toBeGreaterThanOrEqual(4);
    for (const f of fixable) {
      expect(f.fixTemplate?.length).toBeGreaterThan(5);
    }
  });
});
