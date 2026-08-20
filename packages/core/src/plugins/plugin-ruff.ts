import * as path from 'path';
import type { OpenContribPlugin, PluginContext } from '../kernel/contract.js';
import type { CapabilityProviderDescriptor } from '../kernel/capability.js';

export interface RuffDiagnosticItem {
  code: string; // e.g. "F841", "E711", "S101", "B008"
  message: string;
  location: { row: number; column: number };
  end_location: { row: number; column: number };
  filename: string;
  noqa_row?: number;
  fix?: {
    applicability?: string;
    message?: string;
    edits?: Array<{ content: string; location: unknown }>;
  };
}

/**
 * Ruff Python AST Quality & Security Analyzer
 * Executes official `ruff check --output-format json .` and parses official Ruff JSON diagnostic schema.
 */
export const ruffPlugin: OpenContribPlugin = {
  name: '@opencontrib/plugin-ruff',
  version: '1.0.0',
  description: 'Extremely fast Python AST linter, dead code, and security checker',
  permissions: ['fs:read', 'exec:binary'],
  activate: (ctx: PluginContext) => {
    ctx.probes.register({
      id: 'ruff-python',
      name: 'Ruff Python AST Linter',
      category: 'protocol_drift',
      description: 'Finds syntax bugs, dead variables, mutable default arguments, and security flaws in Python code',
      match: (fp) =>
        fp.primaryLanguage.toLowerCase() === 'python' ||
        fp.manifests.includes('pyproject.toml') ||
        fp.manifests.includes('requirements.txt'),
      scan: async (targetPath, pointers, host) => {
        const hasRuff = host.isBinaryAvailable('ruff') || host.isBinaryAvailable('uv');
        if (!hasRuff) {
          host.log('[Ruff Probe] ruff/uv not found in PATH. Install via: pip install ruff or curl -LsSf https://astral.sh/uv/install.sh', 'info');
          return;
        }

        try {
          const cmd = host.isBinaryAvailable('ruff')
            ? 'ruff check --output-format json --no-fix .'
            : 'uv run ruff check --output-format json --no-fix .';

          const { stdout } = await host.exec(cmd, {
            cwd: targetPath,
            timeout: 20000,
          });

          if (!stdout || !stdout.trim().startsWith('[')) return;

          const diagnostics: RuffDiagnosticItem[] = JSON.parse(stdout);
          for (const item of diagnostics) {
            const relFile = path.relative(targetPath, item.filename);
            const isSecurity = item.code.startsWith('S') || item.code.startsWith('B'); // Bandit or Bugbear rules
            const isDeadCode = item.code === 'F841' || item.code === 'F401'; // Unused var / unused import

            pointers.create({
              namespace: 'findings',
              id: `ruff-${item.code}-${path.basename(item.filename)}-${item.location.row}`,
              title: `[Ruff ${item.code}] ${item.message} in ${path.basename(item.filename)}`,
              category: isSecurity ? 'security_cwe' : isDeadCode ? 'dead_code' : 'protocol_drift',
              severity: isSecurity ? 'high' : 'medium',
              file: relFile,
              line: item.location.row,
              confidence: 96,
              affectedSymbol: item.code,
              callSite: `Line ${item.location.row}:${item.location.column}`,
              slice: {
                codeSnippet: `${relFile}:${item.location.row}:${item.location.column} - [${item.code}] ${item.message}`,
                ruleExplanation: item.message,
                remediationSuggestion: item.fix?.message || `Refactor violation of rule ${item.code} at row ${item.location.row}.`,
              },
              evidence: {
                rawPayload: item as any,
              },
            });
          }
        } catch (err: any) {
          host.log(`[Ruff Probe] Non-fatal error during execution: ${err.message}`, 'warn');
        }
      },
    });
  },
};

export const ruffCapabilityDescriptor: CapabilityProviderDescriptor = {
  providerId: 'ruff-python',
  name: 'Ruff Python AST & Defect Engine',
  capability: 'security.static-analysis',
  defectCategory: 'protocol_drift',
  languages: ['python'],
  detects: ['unused-import', 'undefined-var', 'mutable-default-arg', 'insecure-eval', 'sql-injection-format'],
  cost: { cpu: 'low', token: 'zero', typicalLatencyMs: 120 },
  evidenceTier: 'slice',
  isCore: true,
  scoreProvider: (fp) =>
    fp.primaryLanguage.toLowerCase() === 'python' ||
    fp.manifests.includes('pyproject.toml') ||
    fp.manifests.includes('requirements.txt')
      ? 96
      : 0,
};
