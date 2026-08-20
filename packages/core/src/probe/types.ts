/**
 * OpenContrib Progressive Probe & Plugin System Types
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

export type ProbeCost = 'fast' | 'medium' | 'deep';
export type ProbeStage = 'scout' | 'audit' | 'evidence';
export type FindingSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface ProbeActivation {
  /** Target programming languages (e.g. ['go'], ['rust'], ['typescript', 'javascript'], ['*']) */
  languages: string[];
  /** Manifest file indicators (e.g. ['go.mod'], ['package.json'], ['Cargo.toml']) */
  manifestFiles?: string[];
  /** Binaries required on host (e.g. ['semgrep'], ['nilaway'], ['ocr']) */
  requiresBinaries?: string[];
  /** Minimum star threshold or framework keywords */
  frameworks?: string[];
}

export interface ProbeExecution {
  /** Execution cost profile */
  cost: ProbeCost;
  /** Pipeline stage */
  stage: ProbeStage;
  /** Command template with placeholders: {target}, {outputJson}, {flags} */
  command?: string;
  /** Timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Built-in transformer name */
  transformer?: string;
}

export interface ProbeManifest {
  /** Unique probe identifier (e.g. 'semgrep', 'nilaway', 'ocr', 'osv-scanner') */
  name: string;
  /** Semantic version */
  version: string;
  /** Human readable summary */
  description: string;
  /** Primary defect category targeted */
  category: DefectCategory;
  /** Author or vendor */
  author?: string;
  /** Progressive activation rules */
  activation: ProbeActivation;
  /** Execution configuration */
  execution: ProbeExecution;
}

export interface RepoLanguageInfo {
  language: string;
  percentage: number;
  filesCount: number;
}

export interface RepoFingerprint {
  repoPath: string;
  primaryLanguage: string;
  languages: RepoLanguageInfo[];
  manifests: string[];
  frameworks: string[];
  hasTests: boolean;
  hasWorkflows: boolean;
  totalFiles: number;
}

export interface SkippedProbeInfo {
  name: string;
  reason: 'language_mismatch' | 'manifest_missing' | 'binary_not_found' | 'cost_filtered' | 'user_skipped';
  details: string;
}

export interface ProbeNegotiationPlan {
  target: string;
  fingerprint: RepoFingerprint;
  selectedProbes: ProbeManifest[];
  skippedProbes: SkippedProbeInfo[];
  estimatedDurationMs: number;
}

export interface NormalizedFinding {
  id: string;
  probeName: string;
  category: DefectCategory;
  title: string;
  description: string;
  file: string;
  line: number;
  column?: number;
  endLine?: number;
  severity: FindingSeverity;
  cwe?: string;
  ruleId?: string;
  affectedSymbol?: string;
  callSite?: string;
  dataFlow?: string;
  remediation?: string;
  pocSnippet?: string;
  prPotentialScore: number;
}

export interface ProbeRunResult {
  target: string;
  timestamp: string;
  fingerprint: RepoFingerprint;
  executedProbes: string[];
  failedProbes: Array<{ name: string; error: string }>;
  findingsCount: number;
  findings: NormalizedFinding[];
  summaryByCategory: Record<string, number>;
}
