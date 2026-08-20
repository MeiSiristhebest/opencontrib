/**
 * OpenContrib Microkernel Contract & Smart Pointer Specification
 * Inspired by modern minimal agent kernel architectures (e.g. Pi agent / VSCode Extension Host)
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
 * Consumed by LLM during high-level planning & triage without cluttering context
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
 * Consumed by LLM when drilling down into a specific issue before writing code
 */
export interface PointerSlice {
  codeSnippet: string;
  surroundingContext?: string;
  ruleExplanation?: string;
  remediationSuggestion?: string;
}

/**
 * Level 3: Deep Evidence & Reproducible PoC
 * Consumed by LLM on demand during Fail-First test execution
 */
export interface PointerEvidence {
  astDataFlow?: string;
  taintTrace?: string[];
  pocCode?: string;
  pocFileName?: string;
  executionCommand?: string;
  expectedFailurePattern?: string;
  rawPayload?: Record<string, unknown>;
}

export interface SmartPointer {
  uri: string;
  namespace: string; // e.g. "findings", "poc", "hotspots", "ast-slice"
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

export interface ProbeDescriptor {
  id: string;
  name: string;
  version?: string;
  category: DefectCategory;
  author?: string;
  description: string;
  /** Progressive matching predicate */
  match: (fingerprint: RepoFingerprint) => boolean;
  /** Execution callback */
  scan: (targetPath: string, pointers: PointerStoreApi, host: HostServices) => Promise<void>;
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

export interface HostServices {
  workspacePath: string;
  exec(cmd: string, opts?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string }>;
  log(message: string, level?: 'info' | 'warn' | 'error' | 'debug'): void;
  isBinaryAvailable(bin: string): boolean;
}

export interface EventBusApi {
  on(event: 'repo:fingerprint', handler: (fp: RepoFingerprint) => Promise<void> | void): void;
  on(event: 'scout:opportunity', handler: (ctx: { target: string; pointers: PointerStoreApi }) => Promise<void> | void): void;
  on(event: 'evidence:verify', handler: (ctx: { findingUri: string; pointers: PointerStoreApi }) => Promise<void> | void): void;
  emit(event: string, payload: unknown): Promise<void>;
}

export interface PluginContext {
  pluginName: string;
  host: HostServices;
  pointers: PointerStoreApi;
  probes: ProbeRegistryApi;
  events: EventBusApi;
}

export interface OpenContribPlugin {
  name: string;
  version: string;
  description?: string;
  activate(ctx: PluginContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}
