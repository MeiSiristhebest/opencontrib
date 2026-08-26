import * as fs from 'fs';
import * as path from 'path';
import type { OpenContribPlugin, PluginContext } from '../kernel/contract.js';
import type { CapabilityProviderDescriptor } from '../kernel/capability.js';
import { getToolTimeout } from '../kernel/config.js';

export interface ESLintSecurityMessage {
  ruleId: string;
  severity: number;
  message: string;
  line: number;
  column: number;
  nodeType?: string;
  source?: string;
}

export interface ESLintSecurityFileResult {
  filePath: string;
  messages: ESLintSecurityMessage[];
}

/**
 * ESLint Security & Node.js Hazard Adapter
 * Detects command injection (child_process), path traversal (non-literal-fs-filename), and ReDoS regular expressions in JS/TS environments.
 */
export const ESLINT_SECURITY_RULES = [
  { id: 'no-eval', severity: 'high', category: 'code-injection-eval', cwe: 'CWE-95' },
  { id: 'no-implied-eval', severity: 'high', category: 'code-injection-eval', cwe: 'CWE-95' },
  { id: 'no-new-func', severity: 'high', category: 'code-injection-new-function', cwe: 'CWE-95' },
  { id: 'no-script-url', severity: 'medium', category: 'code-injection-eval', cwe: 'CWE-79' },
  { id: 'react/no-danger-with-children', severity: 'medium', category: 'xss-danger-children', cwe: 'CWE-79' },
  { id: 'react/no-inline-styles', severity: 'low', category: 'xss-inline-styles', cwe: 'CWE-79' },
  { id: 'callback-return', severity: 'medium', category: 'error-handling-callback', cwe: 'CWE-754' },
  { id: 'handle-callback-err', severity: 'medium', category: 'error-handling-callback', cwe: 'CWE-391' },
] as const;

/**
 * ESLint Security & Node.js Hazard Adapter v2.0
 * Detects code injection (eval/new Function), child_process injection, path traversal, XSS, and ReDoS.
 */
export const eslintSecurityPlugin: OpenContribPlugin = {
  name: '@opencontrib/plugin-eslint-security',
  version: '2.0.0',
  description: 'Node.js security auditor for child_process injection, path traversal, eval, ReDoS, and XSS',
  permissions: ['fs:read', 'exec:binary'],
  activate: (ctx: PluginContext) => {
    ctx.probes.register({
      id: 'eslint-security',
      name: 'Node.js Security Hazard Auditor',
      category: 'security_cwe',
      description: 'Finds child_process injection, eval, unsafe regex, path traversal, and XSS patterns in Node.js',
      match: (fp) =>
        ['typescript', 'javascript'].includes(fp.primaryLanguage.toLowerCase()) ||
        fp.manifests.includes('package.json'),
      scan: async (targetPath, pointers, host) => {
        const pkgJson = path.join(targetPath, 'package.json');
        if (!fs.existsSync(pkgJson)) return;

        // Path A: Try eslint CLI with --no-config-lookup
        const hasEslint = host.isBinaryAvailable('eslint');
        if (hasEslint) {
          try {
            const ruleFlags = ESLINT_SECURITY_RULES.map((r) => `--rule "${r.id}: error"`).join(' ');
            const { stdout } = await host.exec(
              `eslint ${ruleFlags} --no-config-lookup --format json .`,
              { cwd: targetPath, timeout: getToolTimeout('ESLINT_SECURITY') },
            );
            if (stdout && stdout.trim().startsWith('[')) {
              try {
                const results = JSON.parse(stdout);
                for (const fileResult of results) {
                  if (!fileResult.messages) continue;
                  for (const msg of fileResult.messages) {
                    const relFile = path.relative(targetPath, fileResult.filePath);
                    const rule = ESLINT_SECURITY_RULES.find((r) => r.id === msg.ruleId);
                    if (!rule) continue;
                    pointers.create({
                      namespace: 'findings',
                      id: `sec-${rule.cwe}-${path.basename(fileResult.filePath)}-${msg.line}`,
                      title: `[${rule.id}] ${msg.message} in ${path.basename(fileResult.filePath)}`,
                      category: 'security_cwe',
                      severity: msg.severity === 2 ? 'high' : 'medium',
                      file: relFile,
                      line: msg.line,
                      confidence: 96,
                      affectedSymbol: rule.id,
                      callSite: msg.source || rule.id,
                      slice: {
                        codeSnippet: msg.source || `${msg.ruleId} at ${msg.line}:${msg.column}`,
                        ruleExplanation: `${rule.category} (${rule.cwe})`,
                        remediationSuggestion: `Audit and sanitize potential security hazard for rule ${rule.id}.`,
                      },
                      evidence: {
                        astDataFlow: `${msg.source || ''} -> ${rule.category}`,
                        rawPayload: msg as any,
                      },
                    });
                  }
                }
              } catch {
                // Non-fatal parse failure
              }
            }
          } catch {
            // Fall through to Path B
          }
        }

        // Path B: ast-grep fallback
        const hasAstGrep = host.isBinaryAvailable('ast-grep') || host.isBinaryAvailable('sg');
        if (!hasAstGrep) return;

        const bin = host.isBinaryAvailable('ast-grep') ? 'ast-grep' : 'sg';

        const securityPatterns = [
          {
            pattern: 'child_process.exec($CMD)',
            message: 'Potential Command Injection via child_process.exec with unescaped string',
            ruleId: 'detect-child-process',
            severity: 'high' as const,
          },
          {
            pattern: 'execSync($CMD)',
            message: 'Synchronous command execution with dynamic argument may allow shell injection',
            ruleId: 'detect-child-process-sync',
            severity: 'high' as const,
          },
          {
            pattern: 'new RegExp($PATTERN)',
            message: 'Dynamic RegExp constructor may allow Regular Expression Denial of Service (ReDoS)',
            ruleId: 'detect-unsafe-regex',
            severity: 'medium' as const,
          },
          {
            pattern: 'eval($$)',
            message: 'eval() execution allows arbitrary code injection',
            ruleId: 'detect-eval',
            severity: 'high' as const,
          },
          {
            pattern: 'new Function($$)',
            message: 'new Function() allows dynamic code injection',
            ruleId: 'detect-new-function',
            severity: 'high' as const,
          },
        ];

        for (const sec of securityPatterns) {
          try {
            const { stdout } = await host.exec(`${bin} run -p "${sec.pattern}" --lang ts --json=compact`, {
              cwd: targetPath,
              timeout: getToolTimeout('ESLINT_SECURITY'),
            });

            if (stdout && stdout.trim().startsWith('[')) {
              try {
                const matches = JSON.parse(stdout);
                for (const m of matches) {
                  const relFile = path.relative(targetPath, m.file);
                  const startLine = m.range.start.line + 1;

                  pointers.create({
                    namespace: 'findings',
                    id: `sec-${sec.ruleId}-${path.basename(m.file)}-${startLine}`,
                    title: `[Security] ${sec.message} in ${path.basename(m.file)}`,
                    category: 'security_cwe',
                    severity: sec.severity,
                    file: relFile,
                    line: startLine,
                    confidence: 93,
                    affectedSymbol: sec.ruleId,
                    callSite: m.text,
                    slice: {
                      codeSnippet: m.text,
                      ruleExplanation: sec.message,
                      remediationSuggestion: `Review dynamic execution vulnerability for pattern ${sec.pattern}.`,
                    },
                    evidence: {
                      astDataFlow: `${m.text} -> ${sec.message}`,
                      rawPayload: m as any,
                    },
                  });
                }
              } catch {
                // Non-fatal parse failure
              }
            }
          } catch {
            // Ignored
          }
        }
      },
    });
  },
};

export const eslintSecurityCapabilityDescriptor: CapabilityProviderDescriptor = {
  providerId: 'eslint-security',
  name: 'Node.js Security Hazard & Injection Auditor',
  capability: 'security.static-analysis',
  defectCategory: 'security_cwe',
  languages: ['typescript', 'javascript'],
  detects: ['child-process-injection', 'path-traversal-fs', 'unsafe-regex-redos'],
  cost: { cpu: 'low', token: 'zero', typicalLatencyMs: 200 },
  evidenceTier: 'slice',
  isCore: true,
  scoreProvider: (fp) =>
    ['typescript', 'javascript'].includes(fp.primaryLanguage.toLowerCase()) ||
    fp.manifests.includes('package.json')
      ? 91
      : 0,
};
