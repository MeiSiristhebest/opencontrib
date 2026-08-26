import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { OpenContribPlugin, PluginContext } from '../kernel/contract.js';
import { getToolTimeout } from '../kernel/config.js';
import { STANDARD_AST_RELATIONAL_RULES, serializeRuleToYaml } from '../probe/adapters/ast-grep-rules.js';

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

/** Map from rule.language to the --lang flag value accepted by ast-grep. No fallback to empty string. */
const LANG_FLAG: Record<string, string> = {
  typescript: 'typescript',
  javascript: 'javascript',
  go: 'go',
  rust: 'rust',
  python: 'python',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  csharp: 'csharp',
  php: 'php',
  ruby: 'ruby',
  bash: 'bash',
  yaml: 'yaml',
  json: 'json',
};

/** Scan repository file extensions to determine which languages are actually present. */
function detectRepoLanguages(targetPath: string): string[] {
  const EXT_TO_LANG: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
    '.go': 'go', '.rs': 'rust', '.py': 'python', '.java': 'java',
    '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.h++': 'cpp',
    '.cs': 'csharp', '.php': 'php', '.rb': 'ruby',
  };
  const langs = new Set<string>();
  const walk = (dir: string, depth = 0): void => {
    if (depth > 4) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build') continue;
          walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (EXT_TO_LANG[ext]) langs.add(EXT_TO_LANG[ext]);
        }
      }
    } catch { /* skip unreadable dirs */ }
  };
  walk(targetPath);
  return Array.from(langs);
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

        const repoLanguages = detectRepoLanguages(targetPath);

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

        // 2. Deep Relational Rules Execution — filter by languages actually present in the repo
        for (const rule of STANDARD_AST_RELATIONAL_RULES.filter((r) => repoLanguages.includes(r.language))) {
          try {
            const ruleDef = rule.rule;
            const needsYaml = ruleDef.kind || ruleDef.inside || ruleDef.has || ruleDef.not || ruleDef.any || ruleDef.all;

            let stdout: string;
            if (needsYaml) {
              const yamlPath = path.join(os.tmpdir(), `astgrep-${rule.id}.yml`);
              fs.writeFileSync(yamlPath, serializeRuleToYaml(rule), 'utf8');
              const langFlag = LANG_FLAG[rule.language] || rule.language;
              const cmd = `${bin} scan --rule "${yamlPath}" --lang ${langFlag} --json=compact`;
              const execResult = await host.exec(cmd, {
                cwd: targetPath,
                timeout: getToolTimeout('AST_GREP'),
              });
              stdout = execResult.stdout;
              fs.unlinkSync(yamlPath);
            } else {
              const langFlag = LANG_FLAG[rule.language] || rule.language;
              const cmd = `${bin} run -p "${ruleDef.pattern}" --lang ${langFlag} --json=compact`;
              const execResult = await host.exec(cmd, {
                cwd: targetPath,
                timeout: getToolTimeout('AST_GREP'),
              });
              stdout = execResult.stdout;
            }

            if (stdout && stdout.trim().startsWith('[')) {
              try {
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
              } catch {
                // Non-fatal parse failure
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
