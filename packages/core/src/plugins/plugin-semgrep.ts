import * as fs from 'fs';
import * as path from 'path';
import type { OpenContribPlugin, PluginContext } from '../kernel/contract.js';
import type { CapabilityProviderDescriptor } from '../kernel/capability.js';
import { getToolTimeout } from '../kernel/config.js';
import { discoverDocker } from '../discovery/docker-discovery.js';

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
      source?: string;
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
 * Standard Multi-Sourced Semgrep Rule Packs:
 * 1. OWASP Foundation Top 10 (p/owasp-top-ten)
 * 2. MITRE CWE Top 25 Most Dangerous Weaknesses (p/cwe-top-25)
 * 3. Trail of Bits Security Audit Pack (p/trailofbits)
 * 4. Semgrep Official Security Audit & Secrets (p/security-audit, p/secrets)
 */
export const MULTI_SOURCE_SEMGREP_PACKS = [
  '--config p/owasp-top-ten',
  '--config p/cwe-top-25',
  '--config p/trailofbits',
  '--config p/security-audit',
  '--config p/secrets',
];

/**
 * Semgrep Universal SAST & Taint Analysis Adapter
 * Combines multi-sourced authoritative security rulepacks (OWASP, MITRE, Trail of Bits) with project native configs.
 */
export const semgrepPlugin: OpenContribPlugin = {
  name: '@opencontrib/plugin-semgrep',
  version: '1.0.0',
  description: 'Semgrep multi-source SAST and taint tracking scanner (OWASP, MITRE CWE-25, Trail of Bits, Secrets)',
  permissions: ['fs:read', 'exec:binary'],
  activate: (ctx: PluginContext) => {
    ctx.probes.register({
      id: 'semgrep-sast',
      name: 'Semgrep Multi-Source SAST Scanner',
      category: 'security_cwe',
      description: 'Discovers CWE security vulnerabilities, injection flaws, and taint flows from multiple authoritative sources',
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
        const dockerDiscovery = !hasSemgrep ? discoverDocker() : { found: false };
        const hasDockerDaemon = dockerDiscovery.found;

        if (!hasSemgrep && !hasDockerDaemon) {
          host.log('[Semgrep Probe] Neither semgrep binary nor active docker daemon found. Install via: pip install semgrep or start Docker Desktop.', 'info');
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
            : MULTI_SOURCE_SEMGREP_PACKS.join(' ');

          let cmd = `semgrep scan --json ${configArgs} --quiet`;
          if (!hasSemgrep && hasDockerDaemon) {
            const normalizedTarget = targetPath.replace(/\\/g, '/');
            cmd = `docker run --rm -v "${normalizedTarget}:/src" -w /src returntocorp/semgrep semgrep scan --json ${configArgs} --quiet`;
          }

          const { stdout } = await host.exec(cmd, {
            cwd: targetPath,
            timeout: getToolTimeout('SEMGREP'),
          });

          if (!stdout || !stdout.trim().startsWith('{')) return;

          let report: SemgrepOutput;
          try {
            report = JSON.parse(stdout);
          } catch {
            return;
          }
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
  name: 'Semgrep Multi-Source SAST & Taint Flow Scanner',
  capability: 'security.static-analysis',
  defectCategory: 'security_cwe',
  languages: ['typescript', 'javascript', 'go', 'python', 'java', 'rust', 'c', 'cpp'],
  detects: ['sql-injection', 'command-injection', 'path-traversal', 'xss', 'ssrf', 'insecure-crypto', 'trailofbits-cve'],
  cost: { cpu: 'medium', token: 'zero', typicalLatencyMs: 3500 },
  evidenceTier: 'reproducible_poc',
  isCore: true,
  scoreProvider: (fp) => {
    const langs = fp.languages.map((l) => l.language.toLowerCase());
    return langs.some((l) => ['typescript', 'javascript', 'go', 'python', 'java', 'rust', 'c', 'cpp'].includes(l)) ? 93 : 40;
  },
};
