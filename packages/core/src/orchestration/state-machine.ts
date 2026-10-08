import type { ContributionRunManager } from "../run/run-manager.js";
import type { ContributionRunPhase } from "../run/types.js";

export type ExecutionMode =
  | "draft_only"
  | "local_artifacts_only"
  | "dry_run"
  | "interactive"
  | "autonomous_headless";

export type ExecutionOutcome =
  | "draft_generated"
  | "local_artifacts_written"
  | "patch_validated"
  | "pr_opened"
  | "blocked_by_governance"
  | "waiting_for_human_approval";

export interface ExecutionPolicy {
  mode: ExecutionMode;
  allowRealPr: boolean;
  reviewRequired: boolean;
  maxDiffLines: number;
  minConfidenceScore: number;
  autoPurgeSandboxOnFinish: boolean;
}

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  mode: "interactive",
  allowRealPr: true,
  reviewRequired: true,
  maxDiffLines: 100,
  minConfidenceScore: 90,
  autoPurgeSandboxOnFinish: true,
};

export type PipelineStage =
  | "IDLE"
  | "DISCOVERY"
  | "QUALIFICATION"
  | "ONBOARDING"
  | "PATCH_DESIGN"
  | "SANDBOX_VALIDATION"
  | "SUBAGENT_REVIEW"
  | "HUMAN_GATE"
  | "PR_SUBMISSION"
  | "COMPLETED"
  | "BLOCKED";

export interface PipelineState {
  /** Canonical lifecycle phase; pipeline stages never advance it. */
  currentPhase?: ContributionRunPhase;
  runId?: string;
  stage: PipelineStage;
  policy: ExecutionPolicy;
  repoFullName?: string;
  issueNumber?: number;
  prNumber?: number;
  workspacePath?: string;
  reproductionCaptured: boolean;
  confidenceScore?: number;
  weakestDimensionScore?: number;
  outcome?: ExecutionOutcome;
  history: Array<{ stage: PipelineStage; timestamp: string; note?: string }>;
}

export class ContributionStateMachine {
  private state: PipelineState;
  private phaseSource?: () => ContributionRunPhase | undefined;

  constructor(policy: Partial<ExecutionPolicy> = {}) {
    this.state = {
      stage: "IDLE",
      policy: { ...DEFAULT_EXECUTION_POLICY, ...policy },
      reproductionCaptured: false,
      history: [{ stage: "IDLE", timestamp: new Date().toISOString() }],
    };
  }

  getState(): Readonly<PipelineState> {
    return { ...this.state, currentPhase: this.phaseSource?.() };
  }

  bindRun(runManager: ContributionRunManager, runId: string): void {
    if (!runManager.getRun(runId)) throw new Error(`CanonicalRunMissingError: cannot bind pipeline progress to ${runId}.`);
    this.phaseSource = () => runManager.getRun(runId)?.manifest.currentPhase;
    this.state = {
      stage: "IDLE",
      runId,
      policy: this.state.policy,
      reproductionCaptured: false,
      history: [{ stage: "IDLE", timestamp: new Date().toISOString() }],
    };
  }

  reset(): void {
    this.phaseSource = undefined;
    this.state = {
      stage: "IDLE",
      policy: this.state.policy,
      reproductionCaptured: false,
      history: [{ stage: "IDLE", timestamp: new Date().toISOString() }],
    };
  }

  transition(nextStage: PipelineStage, note?: string): void {
    // Execution progress only. RunManager and its canonical contract own all
    // lifecycle transitions and artifact gates, including completion.
    this.state.stage = nextStage;
    this.state.history.push({
      stage: nextStage,
      timestamp: new Date().toISOString(),
      note,
    });
  }

  setRepoContext(repoFullName: string, issueNumber?: number): void {
    this.state.repoFullName = repoFullName;
    this.state.issueNumber = issueNumber;
  }

  setWorkspace(workspacePath: string): void {
    this.state.workspacePath = workspacePath;
  }

  setReproductionCaptured(captured: boolean): void {
    this.state.reproductionCaptured = captured;
  }

  setConfidenceScore(score: number, weakestScore?: number): void {
    this.state.confidenceScore = score;
    this.state.weakestDimensionScore = weakestScore;
  }

  setOutcome(outcome: ExecutionOutcome): void {
    this.state.outcome = outcome;
  }
}
