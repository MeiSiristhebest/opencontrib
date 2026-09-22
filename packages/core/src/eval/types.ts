/**
 * Core Types & Contracts for LLM-as-a-Judge Evaluation & Self-Evolving Reflexion
 */

export interface TrajectoryToolCall {
  name: string;
  args: Record<string, unknown>;
  outputSnippet?: string;
  exitCode?: number;
  durationMs?: number;
}

export interface TrajectoryEvent {
  stepIndex: number;
  type: 'USER_INPUT' | 'PLANNER_RESPONSE' | 'TOOL_EXECUTION' | 'SYSTEM_NOTIFICATION';
  content?: string;
  toolCalls?: TrajectoryToolCall[];
  timestamp?: string;
}

export interface ProtocolAction {
  /** Canonical action verb, e.g. 'CREATE_RUN', 'CAPTURE_RED'. Derived from
   *  the tool name, not the phase — tool name ≠ phase (contrib_save_artifact
   *  can save opportunity, probe, context, poc, patch, or pr_draft). */
  action: string;
  /** How the action was invoked: 'mcp' for direct MCP tool calls, 'cli' for
   *  CLI commands wrapped by run_command. */
  ingress: 'mcp' | 'cli';
  /** Canonical tool name after namespace/CLI normalization. */
  toolName: string;
  /** Step index in the transcript. */
  stepIndex: number;
  /** Run id supplied to the action, when present in its input. */
  inputRunId?: string;
  /** Run id returned by CREATE_RUN, when present in its tool result. */
  outputRunId?: string;
  /** Backward-compatible alias for an input run id. */
  runId?: string;
}

export interface TrajectoryMetrics {
  totalSteps: number;
  totalCommandsRun: number;
  failedCommandsCount: number;
  viewFileCalls: number;
  maxConsecutiveFileViews: number;
  wholeFileRgDumpsDetected: number;
  shellScriptWriteHacksDetected: number;
  totalContribActions: number;
  totalDurationMs?: number;
}

export interface JudgeDimensionScore {
  dimension:
    | 'problemFormulation'
    | 'contextEconomy'
    | 'empiricalRigor'
    | 'concurrencyStress'
    | 'communityCraftsmanship';
  title: string;
  weight: number;
  score: number; // 0 - 100
  reasoning: string;
  evidenceQuotes?: string[];
}

export interface JudgeEvaluationReport {
  overallScore: number; // 0 - 100
  verdict: 'EXEMPLARY' | 'PROFICIENT' | 'NEEDS_IMPROVEMENT' | 'UNSATISFACTORY';
  summary: string;
  dimensions: JudgeDimensionScore[];
  strengths: string[];
  criticalCritiques: string[];
  actionableDirectives: string[];
  metrics: TrajectoryMetrics;
  evaluationRationale?: string; // Brief LLM Judge rationale
}

export interface ReflexionInsight {
  runId?: string;
  repoFullName?: string;
  failureMode: string;
  rootCause: string;
  lessonsLearned: string[];
  suggestedPromptAdditions: string[];
  goldenActionSequence?: string[];
  createdAt: string;
}

export interface BenchmarkScenario {
  id: string;
  name: string;
  track: 'TRACK_A_PROACTIVE_PROBE' | 'TRACK_B_ISSUE_DISCOVERY';
  targetRepo: string;
  expectedDefectCwe?: string;
  maxAllowedSteps: number;
  /** Canonical action verbs expected for the scenario, derived from PROTOCOL_CONTRACT_PHASES. */
  requiredActions: string[];
  /** True for built-in reference repos (e.g. 'mock/agent-memory-hub'); false for real evaluation targets. */
  isSynthetic?: boolean;
}

export interface BenchmarkBundle {
  /** Run manifest from the run bundle (events.jsonl or manifest.json). */
  manifest?: { runId: string; currentPhase: string };
  /** Structured canonical events read from events.jsonl. */
  events?: Array<{
    eventId: string;
    runId: string;
    timestamp: string;
    phase: string;
    eventType: string;
    payload?: Record<string, unknown>;
  }>;
  /** Parsed canonical artifacts keyed by their bundle artifact type. */
  artifacts?: Record<string, unknown>;
  /** Parsing failures are part of the bundle and must fail verification. */
  parseErrors?: string[];
  /** Event types observed in the run's events.jsonl, keyed by phase. */
  eventPhases?: string[];
  /** Artifact types present in the run bundle directory. */
  artifactTypes?: string[];
}

export interface BenchmarkResult {
  scenarioId: string;
  success: boolean;
  stepsTaken: number;
  durationMs: number;
  judgeScore?: number;
  /** True when the required action sequence and canonical invariants are satisfied.
   *  Renamed from `phaseGatingVerified` — it only proves action ordering, not
   *  that canonical phase gates were truly enforced. */
  actionSequenceVerified: boolean;
  /** True when transcript actions are cross-validated against run events/artifacts. */
  runBundleVerified?: boolean;
  errors: string[];
}
