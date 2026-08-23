/**
 * OpenContrib Microkernel Contract & Smart Pointer Specification
 * Unified capability hierarchy, runtime-enforced scoped permissions, typed KernelEventMap, and runtime verification steps.
 */

export type DefectCategory =
  | 'protocol_drift'
  | 'lifecycle_leak'
  | 'distributed_cache'
  | 'memory_abi'
  | 'performance_backpressure'
  | 'time_monotonicity'
  | 'escape_analysis'
  | 'numerical_bounds'
  | 'security_cwe'
  | 'ci_workflow'
  | 'dead_code';

export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical';
export type PointerView = 'stub' | 'slice' | 'evidence' | 'all';

/**
 * Level 1: Minimal Metadata Stub (~25-30 tokens)
 * Structured symbols, call sites, and data flows (No heuristic title-guessing)
 */
export interface PointerStub {
  id: string;
  uri?: string; // e.g. "ptr://findings/sec-path-traversal-42"
  namespace?: string;
  title: string;
  category: DefectCategory;
  severity: FindingSeverity;
  file: string;
  line: number;
  confidence: number; // 0 - 100%
  affectedSymbol?: string;
  callSite?: string;
  dataFlow?: string;
  slice?: PointerSlice;
  evidence?: PointerEvidence;
  verificationStep?: any;
}

/**
 * Level 2: Context Code Slice & Diagnosis (~150 tokens)
 */
export interface PointerSlice {
  codeSnippet: string;
  surroundingContext?: string;
  ruleExplanation?: string;
  remediationSuggestion?: string;
}

/**
 * Concrete, executable verification steps with optional runtime evaluators
 */
export interface VerificationStep {
  setupCode?: string;
  exploitPayload: string;
  targetCall?: string;
  invocationExpression?: string;
  expectedFailureAssertion: string;
  expectedPostFixAssertion: string;
  evaluator?: {
    runExploit: (context?: unknown) => Promise<{ output: string; error?: Error }>;
    isFailureConfirmed: (result: { output: string; error?: Error }) => boolean;
    isFixConfirmed: (result: { output: string; error?: Error }) => boolean;
  };
}

/**
 * Level 3: Deep Evidence & Reproducible PoC
 */
export interface PointerEvidence {
  astDataFlow?: string;
  taintTrace?: string[];
  pocCode?: string;
  pocFileName?: string;
  suggestedPatch?: string;
  executionCommand?: string;
  expectedFailurePattern?: string;
  verificationSteps?: VerificationStep[];
  rawPayload?: Record<string, unknown>;
}

export interface SmartPointer {
  uri: string;
  namespace: string; // e.g. "findings", "poc", "hotspots", "rules"
  id: string;
  createdAt: string;
  stub: PointerStub;
  slice?: PointerSlice;
  evidence?: PointerEvidence;
}

export interface RepoFingerprint {
  repoPath: string;
  primaryLanguage: string;
  languages: Array<{ language: string; percentage: number; filesCount: number }>;
  manifests: string[];
  frameworks: string[];
  hasTests: boolean;
  hasWorkflows?: boolean;
  totalFiles?: number;
  activeWorkflows?: string[];
  hasDocker?: boolean;
}

export interface PointerCreateOptions {
  namespace?: string;
  id: string;
  title: string;
  category: DefectCategory;
  severity: FindingSeverity;
  file: string;
  line: number;
  confidence?: number;
  affectedSymbol?: string;
  callSite?: string;
  dataFlow?: string;
  slice?: PointerSlice;
  evidence?: PointerEvidence;
}

/**
 * Unified Plugin Capabilities
 */
export interface ProbeDescriptor {
  id: string;
  name: string;
  category: DefectCategory;
  description: string;
  match: (fingerprint: RepoFingerprint) => boolean;
  scan: (targetPath: string, pointers: PointerStoreApi, host: HostServices) => Promise<void>;
}

export interface KernelToolDescriptor {
  name: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>, host: HostServices) => Promise<unknown>;
}

export interface PointerStoreApi {
  create(options: PointerCreateOptions): SmartPointer;
  get(uri: string): SmartPointer | undefined;
  resolve(uri: string, view?: PointerView): unknown;
  list(namespace?: string): SmartPointer[];
  clear(): void;
}

export interface ProbeRegistryApi {
  register(probe: ProbeDescriptor): void;
  unregister(probeId: string): boolean;
  get(probeId: string): ProbeDescriptor | undefined;
  listAll(): ProbeDescriptor[];
}

export type PluginHostContract = any;

export type PluginPermission =
  | 'fs:read'
  | 'fs:write'
  | 'exec:git'
  | 'exec:binary'
  | 'network:github';

export class PluginPermissionError extends Error {
  constructor(public pluginName: string, public requestedPermission: PluginPermission, public action: string) {
    super(`[Security Sandbox] Plugin "${pluginName}" denied permission "${requestedPermission}" for action: ${action}`);
    this.name = 'PluginPermissionError';
  }
}

export interface HostServices {
  workspacePath: string;
  exec(cmd: string, opts?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string }>;
  log(message: string, level?: 'info' | 'warn' | 'error' | 'debug'): void;
  isBinaryAvailable(bin: string): boolean;
}

/**
 * Type-Safe Kernel Event Map
 */
export interface KernelEventMap {
  'plugin:activated': { name: string; version: string; probesCount: number; toolsCount: number };
  'plugin:deactivated': { name: string };
  'finding:created': { uri: string; id: string; category: DefectCategory; severity: FindingSeverity };
  'repo:fingerprint': RepoFingerprint;
  'scout:opportunity': { target: string };
  'evidence:verify': { findingUri: string };
}

export interface KernelEvent<T = unknown> {
  id: string;
  type: string;
  timestamp: string;
  source: string;
  traceId: string;
  payload: T;
}

export interface EventBusApi {
  on<K extends keyof KernelEventMap>(
    eventType: K,
    handler: (event: KernelEvent<KernelEventMap[K]>) => Promise<void> | void,
  ): void;
  on<T = unknown>(eventType: string, handler: (event: KernelEvent<T>) => Promise<void> | void): void;
  emit<K extends keyof KernelEventMap>(eventType: K, payload: KernelEventMap[K], source?: string): Promise<void>;
  emit<T = unknown>(eventType: string, payload: T, source?: string): Promise<void>;
}

export interface PluginContext {
  pluginName: string;
  host: HostServices;
  pointers: PointerStoreApi;
  probes: ProbeRegistryApi;
  events: EventBusApi;
  registerTool(tool: KernelToolDescriptor): void;
}

export interface OpenContribPlugin {
  name: string;
  version: string;
  description?: string;
  permissions: PluginPermission[];
  activate(ctx: PluginContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}
