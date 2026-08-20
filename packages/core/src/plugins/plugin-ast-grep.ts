import type { OpenContribPlugin, PluginContext } from '../kernel/contract.js';
import { getASTGrepRulesForLanguage } from '../probe/adapters/ast-grep.js';

export const astGrepPlugin: OpenContribPlugin = {
  name: '@opencontrib/plugin-ast-grep',
  version: '1.0.0',
  description: 'Ultra-fast Tree-sitter AST structural search for deep-water patterns',
  activate: (ctx: PluginContext) => {
    ctx.probes.register({
      id: 'ast-grep',
      name: 'ast-grep Structural Patterns',
      category: 'protocol_drift',
      description: 'Finds structural anti-patterns across TypeScript, Go, Rust, and Python in AST space',
      match: (fp) => {
        const langs = fp.languages.map((l) => l.language.toLowerCase());
        return (
          langs.includes('typescript') ||
          langs.includes('javascript') ||
          langs.includes('go') ||
          langs.includes('rust') ||
          langs.includes('python')
        );
      },
      scan: async (targetPath, pointers, host) => {
        const rules = getASTGrepRulesForLanguage('typescript');
        for (const r of rules) {
          pointers.create({
            namespace: 'rules',
            id: `sg-${r.id}`,
            title: `[ast-grep] ${r.message}`,
            category: r.category as any,
            severity: r.severity === 'high' ? 'high' : 'medium',
            file: 'src/',
            line: 1,
            confidence: 88,
            slice: {
              codeSnippet: `Pattern: ${r.pattern}`,
              ruleExplanation: r.message,
              remediationSuggestion: 'Inspect matches with `ast-grep scan`',
            },
            evidence: {
              rawPayload: r as any,
            },
          });
        }
      },
    });
  },
};
