import * as fs from 'fs';
import * as path from 'path';
import type { OpenContribPlugin, PluginContext } from '../kernel/contract.js';
import { STANDARD_AST_RELATIONAL_RULES } from '../probe/adapters/ast-grep-rules.js';

export interface ASTGrepMatch {
  text: string;
  range: {
    byteOffset?: { start: number; end: number };
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  file: string;
  lines: string;
  ruleId?: string;
  severity?: string;
  message?: string;
  replacement?: string;
  language?: string;
}

export const astGrepPlugin: OpenContribPlugin = {
  name: '@opencontrib/plugin-ast-grep',
  version: '1.0.0',
  description: 'Ultra-fast Tree-sitter AST structural search with relational rules and atomic rewrites',
  permissions: ['fs:read', 'exec:binary'],
  activate: (ctx: PluginContext) => {
    ctx.probes.register({
      id: 'ast-grep',
      name: 'ast-grep Structural Patterns & Rewrites',
      category: 'protocol_drift',
      description: 'Finds structural anti-patterns and generates atomic AST fix patches across TypeScript, Go, Rust, and Python',
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

        if (!hasAstGrep) {
          host.log('[ast-grep Probe] ast-grep/sg binary not found in PATH. Install with: npm i -g @ast-grep/cli or cargo install ast-grep-cli', 'info');
          return;
        }

        // 1. Config Passthrough: check if project has native sgconfig.yml
        const customSgConfig = path.join(targetPath, 'sgconfig.yml');
        if (fs.existsSync(customSgConfig)) {
          try {
            const { stdout } = await host.exec(`${bin} scan --json=compact`, {
              cwd: targetPath,
              timeout: 25000,
            });

            if (stdout && stdout.trim().startsWith('[')) {
              const matches: ASTGrepMatch[] = JSON.parse(stdout);
              for (const match of matches) {
                const relFile = path.relative(targetPath, match.file);
                const startLine = match.range.start.line + 1;
                pointers.create({
                  namespace: 'findings',
                  id: `ast-native-${match.ruleId || 'rule'}-${path.basename(match.file)}-${startLine}`,
                  title: `[ast-grep] ${match.message || match.ruleId || 'AST Pattern'} in ${path.basename(match.file)}`,
                  category: 'protocol_drift',
                  severity: match.severity === 'error' ? 'high' : 'medium',
                  file: relFile,
                  line: startLine,
                  confidence: 96,
                  affectedSymbol: match.text.slice(0, 40),
                  callSite: match.text,
                  slice: {
                    codeSnippet: match.lines || match.text,
                    ruleExplanation: match.message || `Violates native repository rule ${match.ruleId}`,
                    remediationSuggestion: match.replacement
                      ? `Suggested AST replacement:\n${match.replacement}`
                      : `Inspect AST node at line ${startLine}.`,
                  },
                  evidence: {
                    suggestedPatch: match.replacement,
                    rawPayload: match as any,
                  },
                });
              }
            }
          } catch {
            // Handled
          }
        }

        // 2. Deep Relational Rules Execution with atomic pattern queries
        for (const rule of STANDARD_AST_RELATIONAL_RULES) {
          try {
            const langFlag = rule.language === 'typescript' ? '--lang ts' : rule.language === 'go' ? '--lang go' : '';
            const cmd = `${bin} run -p "${rule.rule.pattern}" ${langFlag} --json=compact`;

            const { stdout } = await host.exec(cmd, {
              cwd: targetPath,
              timeout: 20000,
            });

            if (stdout && stdout.trim().startsWith('[')) {
              const matches: ASTGrepMatch[] = JSON.parse(stdout);
              for (const match of matches) {
                const relFile = path.relative(targetPath, match.file);
                const startLine = match.range.start.line + 1;
                const startCol = match.range.start.column + 1;

                pointers.create({
                  namespace: 'findings',
                  id: `ast-${rule.id}-${path.basename(match.file)}-${startLine}`,
                  title: `[ast-grep] ${rule.message} in ${path.basename(match.file)}`,
                  category: (rule.metadata?.category as any) || 'protocol_drift',
                  severity: rule.severity === 'error' ? 'high' : 'medium',
                  file: relFile,
                  line: startLine,
                  confidence: 95,
                  affectedSymbol: match.text.slice(0, 40),
                  callSite: match.text,
                  slice: {
                    codeSnippet: match.lines || match.text,
                    ruleExplanation: `${rule.message} (${rule.metadata?.cwe || 'AST'})`,
                    remediationSuggestion: rule.fix
                      ? `Atomic AST Auto-Rewrite:\n${rule.fix}`
                      : `Review AST pattern '${rule.rule.pattern}' at line ${startLine}:${startCol}.`,
                  },
                  evidence: {
                    suggestedPatch: rule.fix,
                    astDataFlow: `${match.text} -> ${rule.message}`,
                    rawPayload: match as any,
                  },
                });
              }
            }
          } catch {
            // Handled
          }
        }
      },
    });
  },
};
