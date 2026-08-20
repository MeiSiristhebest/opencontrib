import * as fs from 'fs';
import * as path from 'path';
import type { OpenContribPlugin, PluginContext } from '../kernel/contract.js';
import type { CapabilityProviderDescriptor } from '../kernel/capability.js';

export interface SemgrepResultItem {
  check_id: string;
  path: string;
  start: { line: number; col: number; offset?: number };
  end: { line: number; col: number; offset?: number };
  extra: {
    message: string;
    metadata?: {
      cwe?: string[] | string;
      confidence?: string;
      category?: string;
      impact?: string;
      likelihood?: string;
    };
    severity: 'ERROR' | 'WARNING' | 'INFO';
    lines: string;
    dataflow_trace?: {
      taint_source?: unknown;
      intermediate_vars?: unknown;
      sink?: unknown;
    };
    fix?: string;
  };
}

export interface SemgrepOutput {
  results: SemgrepResultItem[];
  errors: Array<{ code: number; level: string; message: string; path?: string }>;
}

/**
 * Semgrep Universal SAST & Taint Analysis Adapter
 * Supports project-native `.semgrep.yml` configuration passthrough and official OWASP Top 10 / Security-Audit rule packs.
 */
export const semgrepPlugin: OpenContribPlugin = {
  name: '@opencontrib/plugin-semgrep',
  version: '1.0.0',
  description: 'Semgrep multi-language semantic SAST and taint tracking scanner with config passthrough',
  permissions: ['fs:read', 'exec:binary'],
  activate: (ctx: PluginContext) => {
    ctx.probes.register({
      id: 'semgrep-sast',
      name: 'Semgrep SAST & Taint Flow Scanner',
      category: 'security_cwe',
      description: 'Discovers CWE security vulnerabilities, injection flaws, and taint flows with native config passthrough',
      match: (fp) => {
        const langs = fp.languages.map((l) => l.language.toLowerCase());
        return (
          langs.includes('typescript') ||
          langs.includes('javascript') ||
          langs.includes('go') ||
          langs.includes('python') ||
          langs.includes('java') ||
          langs.includes('c') ||
          langs.includes('cpp') ||
          langs.includes('rust')
        );
      },
      scan: async (targetPath, pointers, host) => {
        const hasSemgrep = host.isBinaryAvailable('semgrep');
        if (!hasSemgrep) {
          host.log('[Semgrep Probe] semgrep binary not found in PATH. Install via: pip install semgrep or brew install semgrep', 'info');
          return;
        }

        try {
          // 1. Config Passthrough: check if project has native .semgrep.yml or semgrep.yaml
          const customSemgrep1 = path.join(targetPath, '.semgrep.yml');
          const customSemgrep2 = path.join(targetPath, 'semgrep.yaml');
          const customSemgrepDir = path.join(targetPath, '.semgrep');

          const hasCustomConfig =
            fs.existsSync(customSemgrep1) ||
            fs.existsSync(customSemgrep2) ||
            fs.existsSync(customSemgrepDir);

          const configArgs = hasCustomConfig
            ? '--config auto --config .semgrep.yml'
            : '--config p/security-audit --config p/secrets --config p/owasp-top-ten';

          const { stdout } = await host.exec(`semgrep scan --json ${configArgs} --quiet`, {
            cwd: targetPath,
            timeout: 60000,
          });

          if (!stdout || !stdout.trim().startsWith('{')) return;

          const report: SemgrepOutput = JSON.parse(stdout);
          if (Array.isArray(report.results)) {
            for (const r of report.results) {
              const relFile = path.relative(targetPath, r.path);
              const cweInfo = Array.isArray(r.extra.metadata?.cwe)
                ? r.extra.metadata?.cwe.join(', ')
                : r.extra.metadata?.cwe || 'CWE';
              const cleanCheckId = r.check_id.replace(/[^a-zA-Z0-9_-]/g, '_');

              pointers.create({
                namespace: 'findings',
                id: `semgrep-${cleanCheckId}-${r.start.line}`,
                title: `[Semgrep] ${r.extra.message.split('\n')[0].trim()}`,
                category: 'security_cwe',
                severity: r.extra.severity === 'ERROR' ? 'high' : r.extra.severity === 'WARNING' ? 'medium' : 'low',
                file: relFile,
                line: r.start.line,
                confidence: r.extra.metadata?.confidence === 'HIGH' ? 95 : 88,
                affectedSymbol: r.check_id,
                callSite: r.extra.lines.trim(),
                slice: {
                  codeSnippet: r.extra.lines,
                  ruleExplanation: `${r.extra.message} (${cweInfo})`,
                  remediationSuggestion: r.extra.fix
                    ? `Suggested Semgrep Auto-Fix:\n${r.extra.fix}`
                    : `Inspect line ${r.start.line}:${r.start.col} to neutralize security risk.`,
                },
                evidence: {
                  suggestedPatch: r.extra.fix,
                  astDataFlow: r.extra.dataflow_trace ? JSON.stringify(r.extra.dataflow_trace) : undefined,
                  rawPayload: r as any,
                },
              });
            }
          }
        } catch (err: any) {
          host.log(`[Semgrep Probe] Scan encountered non-critical error: ${err.message}`, 'warn');
        }
      },
    });
  },
};

export const semgrepCapabilityDescriptor: CapabilityProviderDescriptor = {
  providerId: 'semgrep-sast',
  name: 'Semgrep SAST & Taint Flow Scanner',
  capability: 'security.static-analysis',
  defectCategory: 'security_cwe',
  languages: ['typescript', 'javascript', 'go', 'python', 'java', 'rust', 'c', 'cpp'],
  detects: ['sql-injection', 'command-injection', 'path-traversal', 'xss', 'ssrf', 'insecure-crypto'],
  cost: { cpu: 'medium', token: 'zero', typicalLatencyMs: 3500 },
  evidenceTier: 'reproducible_poc',
  isCore: true,
  scoreProvider: (fp) => {
    const langs = fp.languages.map((l) => l.language.toLowerCase());
    return langs.some((l) => ['typescript', 'javascript', 'go', 'python', 'java', 'rust', 'c', 'cpp'].includes(l)) ? 93 : 40;
  },
};
