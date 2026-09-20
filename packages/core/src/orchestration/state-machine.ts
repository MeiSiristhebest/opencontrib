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

  constructor(policy: Partial<ExecutionPolicy> = {}) {
    this.state = {
      stage: "IDLE",
      policy: { ...DEFAULT_EXECUTION_POLICY, ...policy },
      reproductionCaptured: false,
      history: [{ stage: "IDLE", timestamp: new Date().toISOString() }],
    };
  }

  getState(): Readonly<PipelineState> {
    return this.state;
  }

  transition(nextStage: PipelineStage, note?: string): void {
    const currentStage = this.state.stage;
    // Valid transitions aligned with the agent-orchestrator's actual execution paths:
    //   Autonomous/dry-run:  DISCOVERY -> ONBOARDING -> PATCH_DESIGN -> SANDBOX_VALIDATION -> SUBAGENT_REVIEW -> COMPLETED
    //   With PR:            ... -> SUBAGENT_REVIEW -> PR_SUBMISSION -> COMPLETED
    //   With human gate:    ... -> SUBAGENT_REVIEW -> HUMAN_GATE -> PR_SUBMISSION -> COMPLETED
    // QUALIFICATION is a logical concept inlined in the orchestrator (ranking) and is not a separate transition.
    const validTransitions: Record<PipelineStage, PipelineStage[]> = {
      IDLE: ["DISCOVERY", "BLOCKED"],
      DISCOVERY: [
        "ONBOARDING",
        "QUALIFICATION",
        "PATCH_DESIGN",
        "HUMAN_GATE",
        "BLOCKED",
      ],
      QUALIFICATION: ["ONBOARDING", "PATCH_DESIGN", "HUMAN_GATE", "BLOCKED"],
      ONBOARDING: ["PATCH_DESIGN", "BLOCKED"],
      PATCH_DESIGN: ["SANDBOX_VALIDATION", "BLOCKED"],
      SANDBOX_VALIDATION: ["SUBAGENT_REVIEW", "PATCH_DESIGN", "BLOCKED"],
      SUBAGENT_REVIEW: [
        "SANDBOX_VALIDATION",
        "HUMAN_GATE",
        "PR_SUBMISSION",
        "COMPLETED",
        "PATCH_DESIGN",
        "BLOCKED",
      ],
      HUMAN_GATE: ["PR_SUBMISSION", "COMPLETED", "PATCH_DESIGN", "BLOCKED"],
      // A trusted broker may pause a submission while waiting for an
      // approval challenge.  This is a forward hand-off, not a rollback.
      PR_SUBMISSION: ["HUMAN_GATE", "COMPLETED", "BLOCKED"],
      COMPLETED: [],
      BLOCKED: ["IDLE", "PATCH_DESIGN"],
    };

    const allowedTargets = validTransitions[currentStage] || [];
    if (!allowedTargets.includes(nextStage)) {
      throw new Error(
        `Invalid pipeline transition: ${currentStage} -> ${nextStage}. Allowed: ${allowedTargets.join(", ") || "none"}`,
      );
    }

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
