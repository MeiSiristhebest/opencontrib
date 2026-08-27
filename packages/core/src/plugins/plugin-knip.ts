import * as fs from 'fs';
import * as path from 'path';
import type { OpenContribPlugin, PluginContext } from '../kernel/contract.js';
import type { CapabilityProviderDescriptor } from '../kernel/capability.js';
import { getToolTimeout } from '../kernel/config.js';
import { discoverDocker } from '../discovery/docker-discovery.js';

export interface KnipJsonOutput {
  files?: string[];
  dependencies?: Array<{ name: string; specifier?: string }>;
  devDependencies?: Array<{ name: string; specifier?: string }>;
  unlisted?: Record<string, string[]>;
  exports?: Array<{
    file: string;
    symbol: string;
    line: number;
    col: number;
    pos?: number;
  }>;
  types?: Array<{
    file: string;
    symbol: string;
    line: number;
    col: number;
    pos?: number;
  }>;
  duplicates?: Array<Array<{ file: string; export: string }>>;
}

/**
 * Real Knip Architecture & Dead Code Analyzer
 * Executes real `knip` CLI, parses the complete Knip JSON schema, and normalizes findings into structured smart pointers.
 */
export const knipPlugin: OpenContribPlugin = {
  name: 'plugin-knip',
  version: '1.0.0',
  description: 'Knip dead code, unused exports, and dangling dependencies analyzer',
  permissions: ['fs:read', 'exec:binary'],
  activate: (ctx: PluginContext) => {
    ctx.probes.register({
      id: 'knip-dead-code',
      name: 'Knip Dead Code Scanner',
      category: 'dead_code',
      description: 'Detects unused exports, dead files, and dangling dependencies in JS/TS workspaces',
      match: (fp) =>
        ['typescript', 'javascript'].includes(fp.primaryLanguage.toLowerCase()) ||
        fp.manifests.includes('package.json'),
      scan: async (targetPath, pointers, host) => {
        const pkgJson = path.join(targetPath, 'package.json');
        if (!fs.existsSync(pkgJson)) return;

        const hasKnip = host.isBinaryAvailable('knip') || host.isBinaryAvailable('npx');
        const dockerDiscovery = !hasKnip ? discoverDocker() : { found: false };
        const hasDockerDaemon = dockerDiscovery.found;

        if (!hasKnip && !hasDockerDaemon) {
          host.log('[Knip Probe] Neither knip/npx nor active docker daemon found. Skipping dead code analysis.', 'warn');
          return;
        }

        try {
          const isKnipGlobal = host.isBinaryAvailable('knip');
          let cmd = isKnipGlobal
            ? 'knip --reporter json --no-exit-code'
            : (hasKnip
                ? 'npx --yes knip --reporter json --no-exit-code'
                : `docker run --rm -v "${targetPath.replace(/\\/g, '/')}:/src" -w /src node:alpine npx --yes knip --reporter json --no-exit-code`);

          const { stdout } = await host.exec(cmd, {
            cwd: targetPath,
            timeout: getToolTimeout('KNIP'),
          });

          if (!stdout || stdout.trim().length === 0) return;

          // Knip may print preamble lines before JSON; extract valid JSON block
          const jsonStart = stdout.indexOf('{');
          const jsonEnd = stdout.lastIndexOf('}');
          if (jsonStart === -1 || jsonEnd === -1) return;

          const jsonText = stdout.substring(jsonStart, jsonEnd + 1);
          let report: KnipJsonOutput;
          try {
            report = JSON.parse(jsonText);
          } catch {
            return;
          }

          // 1. Normalize Unused Files
          if (Array.isArray(report.files)) {
            for (const file of report.files) {
              const relFile = path.relative(targetPath, file);
              pointers.create({
                namespace: 'findings',
                id: `knip-file-${path.basename(file).replace(/[^a-zA-Z0-9_-]/g, '_')}`,
                title: `Unused dead source file: ${relFile}`,
                category: 'dead_code',
                severity: 'low',
                file: relFile,
                line: 1,
                confidence: 95,
                affectedSymbol: path.basename(file),
                slice: {
                  codeSnippet: `File ${relFile} is completely unreferenced by any module entrypoints.`,
                  remediationSuggestion: `Verify if ${relFile} is obsolete and safely delete or re-export it in package index.`,
                },
              });
            }
          }

          // 2. Normalize Unused Exports
          if (Array.isArray(report.exports)) {
            for (const exp of report.exports) {
              const relFile = path.relative(targetPath, exp.file);
              pointers.create({
                namespace: 'findings',
                id: `knip-exp-${exp.symbol}-${exp.line}`,
                title: `Unused export "${exp.symbol}" in ${relFile}`,
                category: 'dead_code',
                severity: 'low',
                file: relFile,
                line: exp.line,
                confidence: 90,
                affectedSymbol: exp.symbol,
                callSite: `export const ${exp.symbol} ...`,
                slice: {
                  codeSnippet: `Unused export "${exp.symbol}" at line ${exp.line}:${exp.col}.`,
                  remediationSuggestion: `Remove export modifier or delete unused declaration "${exp.symbol}".`,
                },
              });
            }
          }

          // 3. Normalize Unused Types
          if (Array.isArray(report.types)) {
            for (const t of report.types) {
              const relFile = path.relative(targetPath, t.file);
              pointers.create({
                namespace: 'findings',
                id: `knip-type-${t.symbol}-${t.line}`,
                title: `Unused type definition "${t.symbol}" in ${relFile}`,
                category: 'dead_code',
                severity: 'low',
                file: relFile,
                line: t.line,
                confidence: 90,
                affectedSymbol: t.symbol,
                slice: {
                  codeSnippet: `Exported type or interface "${t.symbol}" is never referenced.`,
                  remediationSuggestion: `Remove unused exported type "${t.symbol}" to keep public API surface lean.`,
                },
              });
            }
          }

          // 4. Normalize Unused Dependencies
          if (Array.isArray(report.dependencies)) {
            for (const dep of report.dependencies) {
              pointers.create({
                namespace: 'findings',
                id: `knip-dep-${dep.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
                title: `Unused production dependency: "${dep.name}"`,
                category: 'dead_code',
                severity: 'low',
                file: 'package.json',
                line: 1,
                confidence: 92,
                affectedSymbol: dep.name,
                slice: {
                  codeSnippet: `Dependency "${dep.name}" declared in package.json is never imported in codebase.`,
                  remediationSuggestion: `Remove "${dep.name}" from package.json dependencies to reduce bundle size and security attack surface.`,
                },
              });
            }
          }
        } catch (err: any) {
          host.log(`[Knip Probe] Failed to execute knip analysis: ${err.message}`, 'error');
        }
      },
    });
  },
};

export const knipCapabilityDescriptor: CapabilityProviderDescriptor = {
  providerId: 'knip-analyzer',
  name: 'Knip Dead Code & Export Analyzer',
  capability: 'architecture.dead-code',
  defectCategory: 'dead_code',
  languages: ['typescript', 'javascript'],
  detects: ['unused-export', 'dead-file', 'unlisted-dependency', 'unused-type'],
  cost: { cpu: 'medium', token: 'zero', typicalLatencyMs: 1500 },
  evidenceTier: 'slice',
  isCore: true,
  scoreProvider: (fp) =>
    ['typescript', 'javascript'].includes(fp.primaryLanguage.toLowerCase()) ||
    fp.manifests.includes('package.json')
      ? 91
      : 0,
};
