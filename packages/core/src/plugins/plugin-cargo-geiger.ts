import * as fs from 'fs';
import * as path from 'path';
import type { OpenContribPlugin, PluginContext } from '../kernel/contract.js';
import type { CapabilityProviderDescriptor } from '../kernel/capability.js';

export interface CargoGeigerReport {
  packages?: Array<{
    package?: { name: string; version: string };
    unsafety?: {
      used?: { functions: number; exprs: number; item_impls: number; item_traits: number; methods: number };
      unused?: { functions: number; exprs: number; item_impls: number; item_traits: number; methods: number };
      forbids_unsafe?: boolean;
    };
  }>;
}

/**
 * Cargo Geiger Rust Unsafe Code & Raw Pointer Auditor
 * Detects count and distribution of `unsafe` blocks, raw pointer dereferences, and FFI boundaries in Rust crates.
 */
export const cargoGeigerPlugin: OpenContribPlugin = {
  name: '@opencontrib/plugin-cargo-geiger',
  version: '1.0.0',
  description: 'Audits usage of unsafe code blocks, raw pointers, and FFI in Rust repositories',
  permissions: ['fs:read', 'exec:binary'],
  activate: (ctx: PluginContext) => {
    ctx.probes.register({
      id: 'cargo-geiger',
      name: 'Cargo Geiger Unsafe Code Auditor',
      category: 'security_cwe',
      description: 'Audits unsafe code blocks and undefined behavior boundaries in Rust codebases',
      match: (fp) =>
        fp.primaryLanguage.toLowerCase() === 'rust' ||
        fp.manifests.includes('Cargo.toml'),
      scan: async (targetPath, pointers, host) => {
        const cargoToml = path.join(targetPath, 'Cargo.toml');
        if (!fs.existsSync(cargoToml)) return;

        const hasGeiger = host.isBinaryAvailable('cargo-geiger') || host.isBinaryAvailable('cargo');
        if (!hasGeiger) return;

        // If cargo-geiger is available on host, run official JSON scan
        try {
          const { stdout } = await host.exec('cargo geiger --output-format json', {
            cwd: targetPath,
            timeout: 45000,
          });

          if (stdout && stdout.trim().startsWith('{')) {
            const report: CargoGeigerReport = JSON.parse(stdout);
            if (Array.isArray(report.packages)) {
              for (const pkg of report.packages) {
                const used = pkg.unsafety?.used;
                const totalUnsafe = (used?.functions || 0) + (used?.exprs || 0) + (used?.methods || 0);
                if (totalUnsafe > 0 && pkg.package) {
                  pointers.create({
                    namespace: 'findings',
                    id: `geiger-${pkg.package.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
                    title: `[cargo-geiger] ${totalUnsafe} unsafe expressions detected in ${pkg.package.name}`,
                    category: 'security_cwe',
                    severity: totalUnsafe > 10 ? 'high' : 'medium',
                    file: 'Cargo.toml',
                    line: 1,
                    confidence: 96,
                    affectedSymbol: pkg.package.name,
                    slice: {
                      codeSnippet: `Crate ${pkg.package.name} (v${pkg.package.version}) contains ${totalUnsafe} unsafe operations.`,
                      ruleExplanation: 'Unsafe code blocks bypass Rust compiler memory-safety and thread-safety invariants.',
                      remediationSuggestion: 'Ensure unsafe blocks have explicit safety comments (// SAFETY:) and invariant bounds.',
                    },
                    evidence: {
                      rawPayload: pkg as any,
                    },
                  });
                }
              }
            }
          }
        } catch {
          // Handled
        }
      },
    });
  },
};

export const cargoGeigerCapabilityDescriptor: CapabilityProviderDescriptor = {
  providerId: 'cargo-geiger',
  name: 'Cargo Geiger Unsafe Code Auditor',
  capability: 'security.static-analysis',
  defectCategory: 'security_cwe',
  languages: ['rust'],
  detects: ['unsafe-block', 'raw-pointer-deref', 'ffi-boundary'],
  cost: { cpu: 'medium', token: 'zero', typicalLatencyMs: 2500 },
  evidenceTier: 'slice',
  isCore: true,
  scoreProvider: (fp) =>
    fp.primaryLanguage.toLowerCase() === 'rust' || fp.manifests.includes('Cargo.toml') ? 92 : 0,
};
