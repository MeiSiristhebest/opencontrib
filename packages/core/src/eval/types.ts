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
  kind: 'contrib' | 'shell' | 'file' | 'subagent' | 'other';
  canonicalPhase: string;
  toolName: string;
  stepIndex?: number;
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
  chainOfThought?: string; // Full LLM Judge reasoning chain
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
  /** Canonical MCP/CLI tool sequence expected for the scenario. */
  requiredActionSequence: string[];
  /** True for built-in reference repos (e.g. 'mock/agent-memory-hub'); false for real evaluation targets. */
  isSynthetic?: boolean;
}

export interface BenchmarkResult {
  scenarioId: string;
  success: boolean;
  stepsTaken: number;
  durationMs: number;
  judgeScore?: number;
  phaseGatingVerified: boolean;
  errors: string[];
}
