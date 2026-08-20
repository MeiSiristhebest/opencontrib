import type { OpenContribPlugin, PluginContext } from '../kernel/contract.js';
import { generatePropertyTest } from '../probe/fuzz-generator.js';

export const fuzzPlugin: OpenContribPlugin = {
  name: '@opencontrib/plugin-fuzz',
  version: '1.0.0',
  description: 'Property-based boundary fuzz test generator for NaN/-0.0/Inf, CRLF, and state invariants',
  activate: (ctx: PluginContext) => {
    ctx.probes.register({
      id: 'property-fuzz',
      name: 'Property-Based Invariant Fuzzing',
      category: 'numerical_bounds',
      description: 'Synthesizes minimal reproducible Property Tests (fast-check, hypothesis, proptest)',
      match: (fp) => (fp.totalFiles || 0) >= 0,
      scan: async (targetPath, pointers) => {
        const spec = generatePropertyTest('numerical_bounds', 'typescript', 'calculateTimeout');
        pointers.create({
          namespace: 'fuzz',
          id: 'fuzz-numerical-invariants',
          title: `Property-Based Invariant Test (${spec.framework})`,
          category: 'numerical_bounds',
          severity: 'medium',
          file: 'tests/property_bounds.test.ts',
          line: 1,
          confidence: 90,
          slice: {
            codeSnippet: spec.codeSnippet,
            ruleExplanation: 'Targeted boundary attack generating NaN, -0.0, and Infinite floats to test scheduler robustness.',
            remediationSuggestion: 'Ensure Number.isFinite() guards or fallback handling is enforced.',
          },
          evidence: {
            pocCode: spec.codeSnippet,
            expectedFailurePattern: spec.reproAssertion,
          },
        });
      },
    });
  },
};
