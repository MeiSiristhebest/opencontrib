/**
 * Pipeline execution contracts for the AgentOrchestrator.
 *
 * `_runPipeline` used to be a single ~530-line god method. It is now a *driver*
 * that runs a fixed sequence of `PipelineStep`s over a shared, mutable
 * `PipelineContext`. Each step has exactly one responsibility (SRP) and is
 * independently testable.
 *
 * Steps never reach for concrete collaborators directly — they receive a
 * `PipelineDeps` bag (DIP). The orchestrator is the only place that wires the
 * real implementations, which makes the pipeline fully injectable for tests.
 */

import type { UserProfile, Opportunity, ConfidenceBreakdown } from '../../contracts/schemas.js';
import type { PatchDraft, SubagentReviewEvaluation } from '../../contracts/llm-schemas.js';
import type { RiskAssessment, ValidationStatus } from '../../risk/risk-engine.js';
import type { ExecutionPolicy, ContributionStateMachine } from '../state-machine.js';
import type { GitHubClient } from '../../discovery/github-client.js';
import type { LLMService } from '../../llm/llm-service.js';
import type { WorktreeManager } from '../../workspace/worktree-manager.js';
import type { ContextAssembler } from '../../discovery/context-assembler.js';
import type { RepoMemoryLedger } from '../../memory/repo-memory.js';
import type { ProfileFlywheel } from '../../flywheel/profile-sync.js';
import type { ContributionPrService } from '../../github/contribution-pr-service.js';
import type { Clock } from '../../ports/clock.port.js';
import type {
  OrchestratorRunResult,
  ToolFeedbackEntry,
  TelemetryRecord,
} from '../agent-orchestrator.js';

/**
 * Internal subagent-review state used by the pipeline. The wire type
 * `SubagentReviewEvaluation` (from the LLM schema) carries no status
 * discriminant; the orchestrator needs `UNAVAILABLE | SUCCESS | FAILED` to drive
 * control flow, so we add that layer here without polluting the schema type.
 */
export type OrchestratorSubagentReview =
  | { status: 'UNAVAILABLE' }
  | { status: 'FAILED'; failureReason: string }
  | ({ status: 'SUCCESS' } & SubagentReviewEvaluation);

/** Injected collaborators. The orchestrator supplies real impls; tests supply doubles. */
export interface PipelineDeps {
  client: GitHubClient;
  llmService?: LLMService;
  memory: RepoMemoryLedger;
  flywheel: ProfileFlywheel;
  worktreeManager: WorktreeManager;
  prService: ContributionPrService;
  contextAssembler: ContextAssembler;
  stateMachine: ContributionStateMachine;
  clock: Clock;
}

/**
 * Mutable context threaded through every step. Each step reads what it needs
 * and writes its outputs back here, exactly mirroring the local-variable flow
 * of the original monolithic method.
 */
export interface PipelineContext {
  profile: UserProfile;
  targetRepo?: string;
  humanApproved?: boolean;
  stressLoopRuns?: number;
  startTime: number;
  policy: ExecutionPolicy;

  opportunities?: Opportunity[];
  ranked?: unknown[];
  selectedOpp?: Opportunity;
  owner?: string;
  repo?: string;
  workspace?: { workspacePath: string; branchName: string };
  assembledContext?: any;
  prompt?: string;
  testCmd?: string;
  preFixReproductionCaptured?: boolean;
  preFixOutput?: string;
  patchDraft?: PatchDraft | null;
  activePatch?: PatchDraft;
  implementationAttempts?: number;
  validationStatus?: ValidationStatus;
  appliedFiles?: Array<{ path: string; operation: string }>;
  evidenceReport?: any;
  toolFeedback?: ToolFeedbackEntry[];
  subagentReview?: OrchestratorSubagentReview;
  qualityRubric?: { overallScore: number; isPassed: boolean; [k: string]: unknown };
  riskAssessment?: RiskAssessment;
  telemetry?: TelemetryRecord;
  requiresHumanGate?: boolean;
}

/** A step either advances the pipeline or halts it with a final result. */
export type StepOutcome = { kind: 'continue' } | { kind: 'halt'; result: OrchestratorRunResult };

export interface PipelineStep {
  readonly name: string;
  execute(ctx: PipelineContext, deps: PipelineDeps): Promise<StepOutcome>;
}

/** Convenience helper used by every step that needs to halt the pipeline. */
export function halt(result: OrchestratorRunResult): StepOutcome {
  return { kind: 'halt', result };
}

export function continuePipeline(): StepOutcome {
  return { kind: 'continue' };
}

export type { ConfidenceBreakdown };
