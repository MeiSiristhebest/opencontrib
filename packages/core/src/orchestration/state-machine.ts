export type ExecutionMode =
  | 'draft_only'
  | 'local_artifacts_only'
  | 'dry_run'
  | 'interactive'
  | 'autonomous_headless';

export type ExecutionOutcome =
  | 'draft_generated'
  | 'local_artifacts_written'
  | 'patch_validated'
  | 'pr_opened'
  | 'blocked_by_governance'
  | 'waiting_for_human_approval';

export interface ExecutionPolicy {
  mode: ExecutionMode;
  allowRealPr: boolean;
  reviewRequired: boolean;
  maxDiffLines: number;
  minConfidenceScore: number;
  autoPurgeSandboxOnFinish: boolean;
}

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  mode: 'interactive',
  allowRealPr: true,
  reviewRequired: true,
  maxDiffLines: 100,
  minConfidenceScore: 90,
  autoPurgeSandboxOnFinish: true,
};

export type PipelineStage =
  | 'IDLE'
  | 'DISCOVERY'
  | 'QUALIFICATION'
  | 'ONBOARDING'
  | 'PATCH_DESIGN'
  | 'SANDBOX_VALIDATION'
  | 'SUBAGENT_REVIEW'
  | 'HUMAN_GATE'
  | 'PR_SUBMISSION'
  | 'COMPLETED'
  | 'BLOCKED';

export interface PipelineState {
  stage: PipelineStage;
  policy: ExecutionPolicy;
  repoFullName?: string;
  issueNumber?: number;
  prNumber?: number;
  workspacePath?: string;
  reproductionCaptured: boolean;
  confidenceScore?: number;
  outcome?: ExecutionOutcome;
  history: Array<{ stage: PipelineStage; timestamp: string; note?: string }>;
}

export class ContributionStateMachine {
  private state: PipelineState;

  constructor(policy: Partial<ExecutionPolicy> = {}) {
    this.state = {
      stage: 'IDLE',
      policy: { ...DEFAULT_EXECUTION_POLICY, ...policy },
      reproductionCaptured: false,
      history: [{ stage: 'IDLE', timestamp: new Date().toISOString() }],
    };
  }

  getState(): Readonly<PipelineState> {
    return this.state;
  }

  transition(nextStage: PipelineStage, note?: string): void {
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

  setConfidenceScore(score: number): void {
    this.state.confidenceScore = score;
  }

  setOutcome(outcome: ExecutionOutcome): void {
    this.state.outcome = outcome;
  }

  canProceedToSubmission(): { allowed: boolean; reason?: string } {
    const { policy, confidenceScore, reproductionCaptured, stage } = this.state;

    // 1. Lifecycle position constraint
    const validStages: ContributionStage[] = ['HUMAN_GATE', 'PR_SUBMISSION'];
    if (!validStages.includes(stage)) {
      return {
        allowed: false,
        reason: `Current stage (${stage}) is not submission-ready (must be in HUMAN_GATE or PR_SUBMISSION)`,
      };
    }

    // 2. Policy constraint
    if (!policy.allowRealPr) {
      return { allowed: false, reason: `Policy forbids real PR submissions (mode: ${policy.mode})` };
    }

    // 3. Dual-stage evidence constraint
    if (!reproductionCaptured) {
      return { allowed: false, reason: 'Failing reproduction assertion has not been captured in sandbox' };
    }

    // 4. Quality confidence constraint
    if (confidenceScore !== undefined && confidenceScore < policy.minConfidenceScore) {
      return {
        allowed: false,
        reason: `Confidence score (${confidenceScore}%) is below policy requirement (${policy.minConfidenceScore}%)`,
      };
    }

    return { allowed: true };
  }
}

