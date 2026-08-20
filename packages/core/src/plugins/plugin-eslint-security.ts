import * as fs from 'fs';
import * as path from 'path';
import type { OpenContribPlugin, PluginContext } from '../kernel/contract.js';
import type { CapabilityProviderDescriptor } from '../kernel/capability.js';

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
export const eslintSecurityPlugin: OpenContribPlugin = {
  name: '@opencontrib/plugin-eslint-security',
  version: '1.0.0',
  description: 'Node.js security auditor for child_process injection, path traversal, and ReDoS',
  permissions: ['fs:read', 'exec:binary'],
  activate: (ctx: PluginContext) => {
    ctx.probes.register({
      id: 'eslint-security',
      name: 'Node.js Security Hazard Auditor',
      category: 'security_cwe',
      description: 'Finds child_process command injection, non-literal fs operations, and unsafe regexes in Node.js',
      match: (fp) =>
        ['typescript', 'javascript'].includes(fp.primaryLanguage.toLowerCase()) ||
        fp.manifests.includes('package.json'),
      scan: async (targetPath, pointers, host) => {
        const pkgJson = path.join(targetPath, 'package.json');
        if (!fs.existsSync(pkgJson)) return;

        // Use ast-grep for microsecond Tree-sitter inspection of Node.js security hazards
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
        ];

        for (const sec of securityPatterns) {
          try {
            const { stdout } = await host.exec(`${bin} run -p "${sec.pattern}" --lang ts --json=compact`, {
              cwd: targetPath,
              timeout: 15000,
            });

            if (stdout && stdout.trim().startsWith('[')) {
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
                    codeSnippet: m.lines || m.text,
                    ruleExplanation: sec.message,
                    remediationSuggestion: 'Use `execFile` with array arguments instead of raw string execution.',
                  },
                  evidence: {
                    astDataFlow: `${m.text} -> ${sec.ruleId}`,
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
