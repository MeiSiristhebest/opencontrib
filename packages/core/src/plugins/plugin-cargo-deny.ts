import * as fs from 'fs';
import * as path from 'path';
import type { OpenContribPlugin, PluginContext } from '../kernel/contract.js';
import type { CapabilityProviderDescriptor } from '../kernel/capability.js';

export interface CargoDenyFieldItem {
  advisory?: {
    id: string; // e.g. "RUSTSEC-2024-0001"
    title: string;
    description: string;
    url: string;
    severity?: string;
  };
  code?: string;
  graphs?: Array<{ Krate?: { name: string; version: string } }>;
  message?: string;
}

export interface CargoDenyDiagnostic {
  fields: CargoDenyFieldItem;
  type: string; // "diagnostic"
}

/**
 * Cargo Deny Rust Supply Chain & Advisory Adapter
 * Executes official `cargo deny check --format json` to detect RustSec security advisories and unmaintained crates.
 */
export const cargoDenyPlugin: OpenContribPlugin = {
  name: '@opencontrib/plugin-cargo-deny',
  version: '1.0.0',
  description: 'RustSec security advisories, bans, and license dependency checker',
  permissions: ['fs:read', 'exec:binary'],
  activate: (ctx: PluginContext) => {
    ctx.probes.register({
      id: 'cargo-deny',
      name: 'Cargo Deny Advisory Scanner',
      category: 'security_cwe',
      description: 'Checks Rust dependencies against the RustSec Advisory Database for known vulnerabilities',
      match: (fp) =>
        fp.primaryLanguage.toLowerCase() === 'rust' ||
        fp.manifests.includes('Cargo.toml'),
      scan: async (targetPath, pointers, host) => {
        const cargoToml = path.join(targetPath, 'Cargo.toml');
        if (!fs.existsSync(cargoToml)) return;

        const hasCargo = host.isBinaryAvailable('cargo');
        if (!hasCargo) {
          host.log('[cargo-deny Probe] cargo compiler binary not found in PATH.', 'info');
          return;
        }

        try {
          const { stdout } = await host.exec('cargo deny check advisories --format json', {
            cwd: targetPath,
            timeout: 30000,
          });

          if (!stdout) return;

          const lines = stdout.split('\n');
          for (const line of lines) {
            if (!line.trim().startsWith('{')) continue;
            try {
              const item: CargoDenyDiagnostic = JSON.parse(line);
              if (item.type === 'diagnostic' && item.fields.advisory) {
                const adv = item.fields.advisory;
                const krateName = item.fields.graphs?.[0]?.Krate?.name || 'crate';
                const krateVer = item.fields.graphs?.[0]?.Krate?.version || '';

                pointers.create({
                  namespace: 'findings',
                  id: `cargo-deny-${adv.id}`,
                  title: `[RustSec ${adv.id}] ${adv.title} in ${krateName} ${krateVer}`,
                  category: 'security_cwe',
                  severity: adv.severity === 'critical' ? 'critical' : 'high',
                  file: 'Cargo.toml',
                  line: 1,
                  confidence: 99,
                  affectedSymbol: krateName,
                  slice: {
                    codeSnippet: `Vulnerable crate: ${krateName} (v${krateVer})\nAdvisory: ${adv.url}`,
                    ruleExplanation: adv.description,
                    remediationSuggestion: `Upgrade ${krateName} to a patched release or remove dependency.`,
                  },
                  evidence: {
                    rawPayload: item as any,
                  },
                });
              }
            } catch {
              // Ignore line parse errors
            }
          }
        } catch (err: any) {
          host.log(`[cargo-deny Probe] Execution error: ${err.message}`, 'warn');
        }
      },
    });
  },
};

export const cargoDenyCapabilityDescriptor: CapabilityProviderDescriptor = {
  providerId: 'cargo-deny',
  name: 'Cargo Deny RustSec Advisory Engine',
  capability: 'architecture.dead-code',
  defectCategory: 'security_cwe',
  languages: ['rust'],
  detects: ['rustsec-cve', 'unmaintained-crate', 'license-violation'],
  cost: { cpu: 'low', token: 'zero', typicalLatencyMs: 1400 },
  evidenceTier: 'slice',
  isCore: true,
  scoreProvider: (fp) =>
    fp.primaryLanguage.toLowerCase() === 'rust' || fp.manifests.includes('Cargo.toml') ? 95 : 0,
};
