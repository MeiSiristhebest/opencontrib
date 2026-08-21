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
      match: (fp) =>
        fp.languages.some((l) =>
          ['typescript', 'javascript', 'python', 'rust', 'go'].includes(l.language.toLowerCase())
        ),
      scan: async (targetPath, pointers) => {
        // Inspect registered findings: if numerical or invariant findings are detected, generate matching harness
        const numericalFindings = pointers.list('findings').filter(
          (p) => p.category === 'numerical_bounds' || p.category === 'protocol_drift'
        );

        for (const finding of numericalFindings) {
          const lang = finding.file.endsWith('.go')
            ? 'go'
            : finding.file.endsWith('.py')
            ? 'python'
            : finding.file.endsWith('.rs')
            ? 'rust'
            : 'typescript';

          const targetSymbol = finding.affectedSymbol || 'processInput';
          const spec = generatePropertyTest(finding.category as any, lang, targetSymbol);

          pointers.create({
            namespace: 'fuzz',
            id: `fuzz-${finding.id}`,
            title: `Property-Based Invariant Test for ${targetSymbol} (${spec.framework})`,
            category: 'numerical_bounds',
            severity: 'medium',
            file: finding.file,
            line: finding.line,
            confidence: 90,
            slice: {
              codeSnippet: spec.codeSnippet,
              ruleExplanation: `Targeted property-based fuzz attack against ${targetSymbol} testing invariant edge cases.`,
              remediationSuggestion: `Review ${targetSymbol} behavior with property-based test harness:\n${spec.codeSnippet}`,
            },
            evidence: {
              pocCode: spec.codeSnippet,
              expectedFailurePattern: spec.reproAssertion,
            },
          });
        }
      },
    });
  },
};
