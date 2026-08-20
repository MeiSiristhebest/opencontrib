import { PluginHost } from '../kernel/plugin-host.js';
import type { CapabilityProviderDescriptor } from '../kernel/capability.js';
import { ocrPlugin } from './plugin-ocr.js';
import { pioliumPlugin } from './plugin-piolium.js';
import { astGrepPlugin } from './plugin-ast-grep.js';
import { hotspotPlugin } from './plugin-hotspot.js';
import { fuzzPlugin } from './plugin-fuzz.js';
import { workflowPlugin } from './plugin-workflow.js';

export * from './plugin-ocr.js';
export * from './plugin-piolium.js';
export * from './plugin-ast-grep.js';
export * from './plugin-hotspot.js';
export * from './plugin-fuzz.js';
export * from './plugin-workflow.js';

export const BUILTIN_PLUGINS = [
  ocrPlugin,
  pioliumPlugin,
  astGrepPlugin,
  hotspotPlugin,
  fuzzPlugin,
  workflowPlugin,
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
    scoreProvider: (fp) => (['typescript', 'javascript', 'go', 'rust', 'python'].includes(fp.primaryLanguage.toLowerCase()) ? 92 : 0),
  },
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
    scoreProvider: (fp) => (fp.totalFiles > 0 ? 90 : 0),
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
    scoreProvider: (fp) => (fp.hasWorkflows ? 96 : 0),
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
    scoreProvider: (fp) => (['go', 'java', 'typescript', 'python'].includes(fp.primaryLanguage.toLowerCase()) ? 89 : 0),
  },
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

/**
 * Creates and initializes a PluginHost with all standard built-in plugins registered
 */
export async function createDefaultPluginHost(
  options: { workspacePath?: string; pluginsDir?: string } = {},
): Promise<PluginHost> {
  const host = new PluginHost(options);
  for (const plugin of BUILTIN_PLUGINS) {
    await host.registerPlugin(plugin);
  }
  for (const cap of STANDARD_CAPABILITIES) {
    host.router.registerProvider(cap);
  }
  return host;
}
