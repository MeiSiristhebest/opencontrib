/**
 * Core Types & Contracts for LLM-as-a-Judge Evaluation & Self-Evolving Reflexion
 */

export interface TrajectoryToolCall {
  name: string;
  args: Record<string, any>;
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

export interface TrajectoryMetrics {
  totalSteps: number;
  totalCommandsRun: number;
  failedCommandsCount: number;
  viewFileCalls: number;
  maxConsecutiveFileViews: number;
  wholeFileRgDumpsDetected: number;
  shellScriptWriteHacksDetected: number;
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
  requiredPhaseSequence: string[];
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
