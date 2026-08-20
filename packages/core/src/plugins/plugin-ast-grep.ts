import * as fs from 'fs';
import * as path from 'path';
import type { OpenContribPlugin, PluginContext } from '../kernel/contract.js';
import { DEEP_WATER_AST_RULES } from '../probe/adapters/ast-grep.js';

export interface ASTGrepMatch {
  text: string;
  range: {
    start: { line: number; column: number; index?: number };
    end: { line: number; column: number; index?: number };
  };
  file: string;
  lines: string;
  ruleId?: string;
  severity?: string;
  message?: string;
}

export const astGrepPlugin: OpenContribPlugin = {
  name: '@opencontrib/plugin-ast-grep',
  version: '1.0.0',
  description: 'Ultra-fast Tree-sitter AST structural search for deep-water patterns',
  permissions: ['fs:read', 'exec:binary'],
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
        const hasAstGrep = host.isBinaryAvailable('ast-grep') || host.isBinaryAvailable('sg');
        const bin = host.isBinaryAvailable('ast-grep') ? 'ast-grep' : 'sg';

        if (hasAstGrep) {
          // Execute real ast-grep against target repository with each deep-water rule
          for (const rule of DEEP_WATER_AST_RULES) {
            try {
              // Pass pattern directly with JSON output
              const langFlag = rule.language === 'typescript' ? '--lang ts' : rule.language === 'go' ? '--lang go' : '';
              const cmd = `${bin} scan -p "${rule.pattern}" ${langFlag} --json`;

              const { stdout } = await host.exec(cmd, {
                cwd: targetPath,
                timeout: 20000,
              });

              if (stdout && stdout.trim().startsWith('[')) {
                const matches: ASTGrepMatch[] = JSON.parse(stdout);
                for (const match of matches) {
                  const relFile = path.relative(targetPath, match.file);
                  const startLine = match.range.start.line + 1; // ast-grep is 0-indexed
                  const startCol = match.range.start.column + 1;

                  pointers.create({
                    namespace: 'findings',
                    id: `ast-${rule.id}-${path.basename(match.file)}-${startLine}`,
                    title: `[ast-grep] ${rule.message} in ${path.basename(match.file)}`,
                    category: rule.category as any,
                    severity: rule.severity === 'high' ? 'high' : 'medium',
                    file: relFile,
                    line: startLine,
                    confidence: 94,
                    affectedSymbol: match.text.slice(0, 40),
                    callSite: match.text,
                    slice: {
                      codeSnippet: match.lines || match.text,
                      ruleExplanation: rule.message,
                      remediationSuggestion: `Review AST pattern '${rule.pattern}' at line ${startLine}:${startCol}.`,
                    },
                    evidence: {
                      astDataFlow: `${match.text} -> ${rule.message}`,
                      rawPayload: match as any,
                    },
                  });
                }
              }
            } catch {
              // Silent fail per rule scan
            }
          }
        } else {
          host.log('[ast-grep Probe] ast-grep/sg binary not found in PATH. Install with: npm i -g @ast-grep/cli or cargo install ast-grep-cli', 'info');
        }
      },
    });
  },
};
