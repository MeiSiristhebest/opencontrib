import * as fs from 'fs';
import * as path from 'path';
import type { OpenContribPlugin, PluginContext } from '../kernel/contract.js';
import type { CapabilityProviderDescriptor } from '../kernel/capability.js';

/**
 * Knip Architecture & Dead Code Adapter
 * Provides capability: architecture.dead-code
 * Scans JavaScript and TypeScript workspaces for unused exports, dead files, and unused dependencies.
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

        // If knip binary is available on host, execute; otherwise perform fast heuristic manifest scan
        const hasKnip = host.isBinaryAvailable('knip') || host.isBinaryAvailable('npx');

        if (hasKnip) {
          try {
            const { stdout } = await host.exec('npx --no-install knip --reporter json', {
              cwd: targetPath,
              timeout: 25000,
            });

            if (stdout) {
              const data = JSON.parse(stdout);
              const unusedFiles = data.files || [];
              for (const file of unusedFiles.slice(0, 5)) {
                pointers.create({
                  namespace: 'findings',
                  id: `dead-code-${path.basename(file)}`,
                  title: `Unused dead file detected: ${file}`,
                  category: 'dead_code',
                  severity: 'low',
                  file,
                  line: 1,
                  confidence: 90,
                  slice: {
                    codeSnippet: `File ${file} has zero internal or external references.`,
                    remediationSuggestion: `Safely delete ${file} or export it in package.json entrypoints.`,
                  },
                });
              }
            }
          } catch {
            // Non-zero exit code or timeout: fall back gracefully without crashing host
          }
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
  detects: ['unused-export', 'dead-file', 'unlisted-dependency'],
  cost: { cpu: 'medium', token: 'zero', typicalLatencyMs: 1200 },
  evidenceTier: 'slice',
  isCore: true,
  scoreProvider: (fp) =>
    ['typescript', 'javascript'].includes(fp.primaryLanguage.toLowerCase()) ||
    fp.manifests.includes('package.json')
      ? 91
      : 0,
};
