import { buildProductionGitHubClient } from '../composition-root.js';
import { RepoMemoryLedger } from '../memory/repo-memory.js';
import { ProfileFlywheel } from '../flywheel/profile-sync.js';
import { WorktreeManager } from '../workspace/worktree-manager.js';
import { ContributionPrService } from '../github/contribution-pr-service.js';
import { LLMService } from '../llm/llm-service.js';
import { ContextAssembler } from '../discovery/context-assembler.js';
import { ContributionStateMachine } from './state-machine.js';
import { SystemClock } from '../ports/clock.port.js';
import type { UserProfile, Opportunity } from '../contracts/schemas.js';
import type { ValidationStatus } from '../risk/risk-engine.js';
import type { RiskAssessment } from '../risk/risk-engine.js';
import type { PipelineDeps, PipelineContext, OrchestratorSubagentReview } from './pipeline/types.js';
import { PIPELINE_STEPS } from './pipeline/steps.js';

export interface ToolFeedbackEntry {
  turn: number;
  toolName: string;
  command?: string;
  exitCode?: number;
  output: string;
  success: boolean;
}

export interface PromptRebuildContext {
  basePrompt: string;
  testCommand?: string;
  feedback: ToolFeedbackEntry[];
  appliedFiles: Array<{ path: string; operation: string }>;
  attemptNumber: number;
  maxAttempts: number;
}

/**
 * Rebuild the prompt from scratch each turn with accumulated tool feedback.
 *
 * Previously, the prompt was built once at loop entry and then simply had
 * failure traces appended. This meant the LLM could not see or learn from
 * successful intermediate tool calls — only failures were fed back.
 *
 * The per-turn rebuild includes ALL tool outputs from every attempt,
 * giving the model the full context of what was tried and what worked/failed.
 */
export function buildTurnPrompt(ctx: PromptRebuildContext): string {
  const lines: string[] = [];
  lines.push(ctx.basePrompt);
  lines.push('');

  if (ctx.feedback.length > 0) {
    lines.push(`## Previous Attempt Feedback (Attempts 1-${ctx.attemptNumber - 1})`);
    lines.push('');
    for (const entry of ctx.feedback) {
      const status = entry.success ? '✅ PASS' : `❌ FAIL (exit ${entry.exitCode ?? 'N/A'})`;
      const cmd = entry.command ? `\`${entry.command.slice(0, 200)}\`` : entry.toolName;
      lines.push(`### ${status} — ${entry.toolName}`);
      if (entry.command) lines.push(`Command: ${cmd}`);
      lines.push('```');
      lines.push(entry.output.slice(-1500));
      lines.push('```');
      lines.push('');
    }
  }

  if (ctx.appliedFiles.length > 0) {
    lines.push(`## Previously Applied Changes`);
    lines.push('');
    for (const f of ctx.appliedFiles) {
      lines.push(`- ${f.operation} ${f.path}`);
    }
    lines.push('');
  }

  if (ctx.attemptNumber > 1) {
    lines.push(`## Repair Instructions (Attempt ${ctx.attemptNumber}/${ctx.maxAttempts})`);
    lines.push('');
    lines.push(`You have ${ctx.maxAttempts - ctx.attemptNumber} attempt(s) remaining.`);
    lines.push('Based on the feedback above, diagnose the root cause and produce a revised surgical patch.');
    lines.push('Focus on the specific failure rather than making unrelated changes.');
    lines.push('');
    lines.push(`- **Test Command**: \`${ctx.testCommand || 'N/A'}\``);
  }

  lines.push('');
  lines.push('Please generate a minimal surgical patch conforming strictly to PatchDraftSchema JSON with concrete code files in the "files" array.');

  return lines.join('\n');
}

export interface TelemetryRecord {
  runId: string;
  repoFullName: string;
  issueNumber?: number;
  attempts: number;
  durationMs: number;
  qualityScore: number;
  riskScore: number;
  riskLevel: string;
  status: string;
  prUrl?: string;
}

export interface OrchestratorRunResult {
  status: 'COMPLETED' | 'BLOCKED' | 'HUMAN_APPROVAL_REQUIRED' | 'DRY_RUN_COMPLETED';
  stage: string;
  selectedOpportunity?: Opportunity;
  workspacePath?: string;
  patchDraft?: PatchDraft;
  appliedFiles?: Array<{ path: string; operation: string }>;
  implementationAttempts?: number;
  validationStatus?: ValidationStatus;
  confidenceScore?: number;
  subagentReview?: OrchestratorSubagentReview;
  riskAssessment?: RiskAssessment;
  prUrl?: string;
  prNumber?: number;
  telemetry?: TelemetryRecord;
  reportSummary: string;
}

// PatchDraft is only referenced as a type above; alias the import to satisfy it.
import type { PatchDraft } from '../contracts/llm-schemas.js';

function resolveLlmService(injected?: LLMService): LLMService | undefined {
  if (injected) return injected;
  try {
    return new LLMService();
  } catch {
    return undefined;
  }
}

export interface AgentOrchestratorOptions {
  policy?: Partial<import('./state-machine.js').ExecutionPolicy>;
  githubToken?: string;
  llmService?: LLMService;
  /** Full or partial dependency injection for testing / composition root. */
  deps?: Partial<PipelineDeps>;
}

/**
 * Top-level autonomous contribution orchestrator.
 *
 * The former ~530-line `_runPipeline` god method has been replaced by a thin
 * driver that runs the ordered `PIPELINE_STEPS` over a shared `PipelineContext`.
 * Each step owns exactly one responsibility (SRP) and receives injected
 * collaborators through `PipelineDeps` (DIP), so the orchestrator is now
 * fully testable without live GitHub / LLM / filesystem side effects.
 */
export class AgentOrchestrator {
  private deps: PipelineDeps;
  private isRunning = false;

  constructor(options: AgentOrchestratorOptions = {}) {
    const client = options.deps?.client ?? buildProductionGitHubClient({ token: options.githubToken });
    const memory = options.deps?.memory ?? new RepoMemoryLedger();
    const flywheel = options.deps?.flywheel ?? new ProfileFlywheel();
    const worktreeManager = options.deps?.worktreeManager ?? new WorktreeManager();
    const prService = options.deps?.prService ?? new ContributionPrService(client);
    const contextAssembler = options.deps?.contextAssembler ?? new ContextAssembler(memory);
    const stateMachine =
      options.deps?.stateMachine ?? new ContributionStateMachine(options.policy);
    const clock = options.deps?.clock ?? new SystemClock();
    const llmService = options.deps?.llmService ?? resolveLlmService(options.llmService);

    this.deps = {
      client,
      memory,
      flywheel,
      worktreeManager,
      prService,
      contextAssembler,
      stateMachine,
      clock,
      llmService,
    };
  }

  async runPipeline(input: {
    profile: UserProfile;
    targetRepo?: string;
    humanApproved?: boolean;
    stressLoopRuns?: number;
  }): Promise<OrchestratorRunResult> {
    if (this.isRunning) {
      return {
        status: 'BLOCKED',
        stage: 'BLOCKED',
        reportSummary: 'Orchestrator already in progress; instantiate a new AgentOrchestrator for concurrent runs.',
      } as OrchestratorRunResult;
    }
    this.isRunning = true;
    try {
      return await this._runPipeline(input);
    } finally {
      this.isRunning = false;
    }
  }

  private async _runPipeline(input: {
    profile: UserProfile;
    targetRepo?: string;
    humanApproved?: boolean;
    stressLoopRuns?: number;
  }): Promise<OrchestratorRunResult> {
    const ctx: PipelineContext = {
      profile: input.profile,
      targetRepo: input.targetRepo,
      humanApproved: input.humanApproved,
      stressLoopRuns: input.stressLoopRuns,
      startTime: this.deps.clock.now().getTime(),
      policy: this.deps.stateMachine.getState().policy,
    };

    for (const step of PIPELINE_STEPS) {
      const outcome = await step.execute(ctx, this.deps);
      if (outcome.kind === 'halt') {
        return outcome.result;
      }
    }

    // Defensive terminal: a well-formed pipeline always halts via a terminal step.
    return {
      status: 'BLOCKED',
      stage: 'COMPLETED',
      reportSummary: 'Pipeline terminated without producing a terminal result (unexpected).',
    };
  }
}
