import { PluginHost } from '../kernel/plugin-host.js';
import type { CapabilityProviderDescriptor } from '../kernel/capability.js';
import { loadWorkspaceConfig } from '../kernel/config.js';
import { ocrPlugin } from './plugin-ocr.js';
import { pioliumPlugin } from './plugin-piolium.js';
import { astGrepPlugin } from './plugin-ast-grep.js';
import { hotspotPlugin } from './plugin-hotspot.js';
import { fuzzPlugin } from './plugin-fuzz.js';
import { workflowPlugin } from './plugin-workflow.js';
import { knipPlugin, knipCapabilityDescriptor } from './plugin-knip.js';
import { semgrepPlugin, semgrepCapabilityDescriptor } from './plugin-semgrep.js';
import { ruffPlugin, ruffCapabilityDescriptor } from './plugin-ruff.js';
import { goAnalyzersPlugin, goAnalyzersCapabilityDescriptor } from './plugin-go-analyzers.js';
import { cargoDenyPlugin, cargoDenyCapabilityDescriptor } from './plugin-cargo-deny.js';
import { cargoGeigerPlugin, cargoGeigerCapabilityDescriptor } from './plugin-cargo-geiger.js';
import { eslintSecurityPlugin, eslintSecurityCapabilityDescriptor } from './plugin-eslint-security.js';

export * from './plugin-ocr.js';
export * from './plugin-piolium.js';
export * from './plugin-ast-grep.js';
export * from './plugin-hotspot.js';
export * from './plugin-fuzz.js';
export * from './plugin-workflow.js';
export * from './plugin-knip.js';
export * from './plugin-semgrep.js';
export * from './plugin-ruff.js';
export * from './plugin-go-analyzers.js';
export * from './plugin-cargo-deny.js';
export * from './plugin-cargo-geiger.js';
export * from './plugin-eslint-security.js';

export const BUILTIN_PLUGINS = [
  ocrPlugin,
  pioliumPlugin,
  astGrepPlugin,
  hotspotPlugin,
  fuzzPlugin,
  workflowPlugin,
  knipPlugin,
  semgrepPlugin,
  ruffPlugin,
  goAnalyzersPlugin,
  cargoDenyPlugin,
  cargoGeigerPlugin,
  eslintSecurityPlugin,
];

export const STANDARD_CAPABILITIES: CapabilityProviderDescriptor[] = [
  {
    providerId: 'ast-grep',
    name: 'ast-grep Structural Search',
    capability: 'security.static-analysis',
    defectCategory: 'protocol_drift',
    languages: ['typescript', 'javascript', 'go', 'rust', 'python'],
    detects: ['path-traversal', 'sql-injection', 'null-deref', 'xss'],
    cost: { cpu: 'low', token: 'zero', typicalLatencyMs: 150 },
    evidenceTier: 'slice',
    isCore: true,
    scoreProvider: (fp) =>
      ['typescript', 'javascript', 'go', 'rust', 'python'].includes(fp.primaryLanguage.toLowerCase()) ? 92 : 0,
  },
  semgrepCapabilityDescriptor,
  ruffCapabilityDescriptor,
  goAnalyzersCapabilityDescriptor,
  cargoDenyCapabilityDescriptor,
  cargoGeigerCapabilityDescriptor,
  eslintSecurityCapabilityDescriptor,
  {
    providerId: 'piolium',
    name: 'Piolium Autonomous PoC Constructor',
    capability: 'bug.reproduction',
    defectCategory: 'security_cwe',
    languages: ['*'],
    detects: ['reproducible-exploit', 'concurrency-race', 'nil-panic'],
    cost: { cpu: 'medium', token: 'zero', typicalLatencyMs: 350 },
    evidenceTier: 'reproducible_poc',
    isCore: true,
    scoreProvider: () => 95,
  },
  {
    providerId: 'git-hotspot',
    name: 'Git Churn × Complexity Forensics',
    capability: 'forensics.git-hotspot',
    defectCategory: 'lifecycle_leak',
    languages: ['*'],
    detects: ['high-churn-risk', 'complexity-trap'],
    cost: { cpu: 'low', token: 'zero', typicalLatencyMs: 200 },
    evidenceTier: 'stub',
    isCore: true,
    scoreProvider: (fp) => ((fp.totalFiles || 0) > 0 ? 90 : 0),
  },
  {
    providerId: 'property-fuzz',
    name: 'Property-Based Boundary Fuzzing',
    capability: 'testing.property-fuzz',
    defectCategory: 'numerical_bounds',
    languages: ['typescript', 'go', 'python'],
    detects: ['nan-float', 'negative-delay', 'crlf-boundary'],
    cost: { cpu: 'low', token: 'zero', typicalLatencyMs: 100 },
    evidenceTier: 'slice',
    isCore: true,
    scoreProvider: (fp) => (fp.hasTests ? 88 : 40),
  },
  {
    providerId: 'workflow-linter',
    name: 'GitHub Actions CI Modernizer',
    capability: 'ci.workflow-lint',
    defectCategory: 'ci_workflow',
    languages: ['*'],
    detects: ['deprecated-action', 'node20-runner-trap'],
    cost: { cpu: 'low', token: 'zero', typicalLatencyMs: 50 },
    evidenceTier: 'slice',
    isCore: true,
    scoreProvider: (fp) => (Boolean(fp.hasWorkflows || (fp.activeWorkflows && fp.activeWorkflows.length > 0)) ? 96 : 0),
  },
  {
    providerId: 'ocr-npe',
    name: 'Alibaba OCR Rule Matcher',
    capability: 'concurrency.leak-detection',
    defectCategory: 'lifecycle_leak',
    languages: ['go', 'java', 'typescript', 'python'],
    detects: ['nil-pointer', 'goroutine-leak', 'mutex-deadlock'],
    cost: { cpu: 'medium', token: 'zero', typicalLatencyMs: 400 },
    evidenceTier: 'slice',
    isCore: true,
    scoreProvider: (fp) =>
      ['go', 'java', 'typescript', 'python'].includes(fp.primaryLanguage.toLowerCase()) ? 89 : 0,
  },
  knipCapabilityDescriptor,
  {
    providerId: 'codeql-deep',
    name: 'CodeQL Deep Taint Analyzer',
    capability: 'security.static-analysis',
    defectCategory: 'security_cwe',
    languages: ['go', 'java', 'c++', 'python', 'javascript'],
    detects: ['complex-dataflow-taint', 'cve-zero-day'],
    cost: { cpu: 'heavy', token: 'zero', typicalLatencyMs: 45000 },
    evidenceTier: 'reproducible_poc',
    isCore: false, // Optional Heavy
    scoreProvider: (fp, intent) => (intent === 'deep_security' ? 85 : 45),
  },
];

import { ProbeRegistry } from '../probe/registry.js';
import { runProbes } from '../probe/runner.js';
import { extractRepoFingerprint } from '../probe/fingerprint.js';
import { canExecuteProbe } from '../probe/negotiator.js';
import type { ProbeDescriptor, PointerStoreApi, RepoFingerprint } from '../kernel/contract.js';
import type { ProbeManifest, ProbeNegotiationPlan } from '../probe/types.js';

export function createProbeDescriptorFromManifest(manifest: ProbeManifest): ProbeDescriptor {
  return {
    id: manifest.name,
    name: manifest.description || manifest.name,
    category: manifest.category,
    description: manifest.description,
    match: (fingerprint: RepoFingerprint) => {
      if (!canExecuteProbe(manifest)) return false;

      const languages = manifest.activation.languages;
      const langMatch =
        languages.includes('*') ||
        languages.some((ml) => ml.toLowerCase() === fingerprint.primaryLanguage.toLowerCase()) ||
        fingerprint.languages.some((l) => languages.some((ml) => ml.toLowerCase() === l.language.toLowerCase()));
      if (!langMatch) return false;

      if (manifest.activation.manifestFiles && manifest.activation.manifestFiles.length > 0) {
        const hasManifest = manifest.activation.manifestFiles.some((mf) =>
          fingerprint.manifests.includes(mf),
        );
        if (!hasManifest) return false;
      }

      return true;
    },
    scan: async (targetPath: string, pointers: PointerStoreApi) => {
      const fp = await extractRepoFingerprint(targetPath);
      const plan: ProbeNegotiationPlan = {
        target: targetPath,
        fingerprint: fp,
        selectedProbes: [manifest],
        skippedProbes: [],
        estimatedDurationMs: manifest.execution.timeoutMs || 30000,
      };
      const runResult = await runProbes(plan, { timeoutMs: manifest.execution.timeoutMs });
      for (const finding of runResult.findings) {
        pointers.create({
          namespace: 'findings',
          id: finding.id || `probe-${manifest.name}-${finding.file}-${finding.line}`,
          title: finding.title,
          category: finding.category,
          severity: finding.severity,
          file: finding.file,
          line: finding.line,
          confidence: finding.prPotentialScore || 85,
          affectedSymbol: finding.affectedSymbol,
          callSite: finding.callSite,
          dataFlow: finding.dataFlow,
          slice: {
            codeSnippet: finding.description,
            ruleExplanation: `${finding.title} (${finding.cwe || finding.ruleId || manifest.name})`,
            remediationSuggestion: finding.remediation,
          },
          evidence: {
            pocCode: finding.pocSnippet,
            rawPayload: finding as any,
          },
        });
      }
    },
  };
}

/**
 * Creates and initializes a PluginHost with standard capabilities filtered by workspace configuration
 */
export async function createDefaultPluginHost(
  options: { workspacePath?: string; pluginsDir?: string } = {},
): Promise<PluginHost> {
  const wsPath = options.workspacePath || process.cwd();
  const config = loadWorkspaceConfig(wsPath);

  const host = new PluginHost({ ...options, workspacePath: wsPath });

  for (const plugin of BUILTIN_PLUGINS) {
    try {
      await host.registerPlugin(plugin);
    } catch (err: any) {
      console.error(`[createDefaultPluginHost] Plugin "${plugin.name}" failed to activate, skipping:`, err.message);
    }
  }

  // Register remaining probes from canonical ProbeRegistry (Single Source of Truth)
  const existingProbes = host.listAll();
  const existingIds = new Set<string>();
  for (const p of existingProbes) {
    existingIds.add(p.id.toLowerCase());
    if (p.aliases) {
      for (const a of p.aliases) {
        existingIds.add(a.toLowerCase());
      }
    }
  }

  const registry = new ProbeRegistry(options.pluginsDir);
  for (const manifest of registry.listAll()) {
    if (!existingIds.has(manifest.name.toLowerCase())) {
      host.register(createProbeDescriptorFromManifest(manifest));
    }
  }

  // Register only capabilities enabled in configuration
  for (const cap of STANDARD_CAPABILITIES) {
    if (config.enabledCapabilities.includes(cap.capability)) {
      host.router.registerProvider(cap);
    }
  }

  return host;
}
