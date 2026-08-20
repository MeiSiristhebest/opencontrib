/**
 * OpenContrib Microkernel Contract & Smart Pointer Specification
 * Unified capability hierarchy, scoped permissions, typed events, and concrete verification steps.
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
 */
export interface PointerStub {
  id: string;
  uri: string; // e.g. "ptr://findings/ocr-npe-42"
  title: string;
  category: DefectCategory;
  severity: FindingSeverity;
  file: string;
  line: number;
  confidence: number; // 0 - 100%
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
 * Concrete, executable verification steps (No placeholder assertions)
 */
export interface VerificationStep {
  setupCode?: string;
  exploitPayload: string;
  invocationExpression: string;
  expectedFailureAssertion: string;
  expectedPostFixAssertion: string;
}

/**
 * Level 3: Deep Evidence & Reproducible PoC
 */
export interface PointerEvidence {
  astDataFlow?: string;
  taintTrace?: string[];
  pocCode?: string;
  pocFileName?: string;
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
  hasWorkflows: boolean;
  totalFiles: number;
}

/**
 * Unified Plugin Capabilities
 */
export interface ProbeDescriptor {
  id: string;
  name: string;
  version?: string;
  category: DefectCategory;
  author?: string;
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
  create(params: {
    namespace?: string;
    id: string;
    title: string;
    category: DefectCategory;
    severity: FindingSeverity;
    file: string;
    line: number;
    confidence?: number;
    slice?: PointerSlice;
    evidence?: PointerEvidence;
  }): SmartPointer;

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

export type PluginPermission =
  | 'fs:read'
  | 'fs:write'
  | 'exec:git'
  | 'exec:binary'
  | 'network:github';

export interface HostServices {
  workspacePath: string;
  exec(cmd: string, opts?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string }>;
  log(message: string, level?: 'info' | 'warn' | 'error' | 'debug'): void;
  isBinaryAvailable(bin: string): boolean;
}

export interface KernelEvent<T = unknown> {
  id: string;
  type: string;
  timestamp: string;
  source: string;
  traceId?: string;
  payload: T;
}

export interface EventBusApi {
  on<T = unknown>(eventType: string, handler: (event: KernelEvent<T>) => Promise<void> | void): void;
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
  permissions?: PluginPermission[];
  activate(ctx: PluginContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}
