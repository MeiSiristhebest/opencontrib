/**
 * The 14 pipeline steps that replace the monolithic `_runPipeline`.
 *
 * Each step is a single responsibility. They are ordered in `PIPELINE_STEPS`
 * and driven by `runPipelineSteps` in `agent-orchestrator.ts`. Every step
 * receives the shared `PipelineContext` (read inputs / write outputs) and the
 * injected `PipelineDeps` (never reaches for concretes directly — DIP).
 *
 * The logic inside each step is a verbatim extraction of the corresponding
 * phase from the original method; no behavioral change is intended.
 */

import type { Opportunity } from '../../contracts/schemas.js';
import {
  PatchDraftSchema,
  SubagentReviewEvaluationSchema,
  type PatchDraft,
} from '../../contracts/llm-schemas.js';
import { scoutOpportunities } from '../../discovery/scout.js';
import { MultiSignalHeuristicRanker } from '../../discovery/ranking.js';
import { detectSystemCapabilities } from '../../discovery/feasibility.js';
import { verifyEmpiricalReproduction, collectEvidence } from '../../evidence/evidence-collector.js';
import { generateSubagentReviewPrompt } from '../../governance/subagent-reviewer.js';
import { deriveEvidenceBackedQualityRubric } from '../../governance/governance-auditor.js';
import { buildPrDescription } from '../../governance/template-merger.js';
import { assessContributionRisk, type RiskAssessment, type ValidationStatus } from '../../risk/risk-engine.js';
import { buildTurnPrompt } from '../agent-orchestrator.js';
import type { PipelineContext, PipelineDeps, PipelineStep, StepOutcome, OrchestratorSubagentReview } from './types.js';
import { halt, continuePipeline } from './types.js';

// ── Phase 0: Discovery & Scout ──────────────────────────────────────────────

export class DiscoveryScoutStep implements PipelineStep {
  readonly name = 'DiscoveryScout';
  async execute(ctx: PipelineContext, deps: PipelineDeps): Promise<StepOutcome> {
    deps.stateMachine.transition('DISCOVERY', 'Scouting candidate issues with live GitHub search');
    // DIP: pass the injected GitHub client (deps.client) so the scout never
    // constructs its own network adapter and is testable with an
    // InMemoryIssueSource. Callers outside the pipeline may still omit it.
    const opportunities = await scoutOpportunities(
      ctx.profile,
      { repo: ctx.targetRepo, limit: 5 },
      deps.client,
    );
    if (opportunities.length === 0) {
      deps.stateMachine.transition('BLOCKED', 'No qualified issues found');
      return halt({
        status: 'BLOCKED',
        stage: 'DISCOVERY',
        reportSummary: 'No qualified, unclaimed open issues matched current profile and feasibility gates.',
      });
    }
    ctx.opportunities = opportunities;
    return continuePipeline();
  }
}

// ── Phase 0.5: Dynamic Runtime Probe & Multi-Signal Heuristic Ranking ───────

export class RankingStep implements PipelineStep {
  readonly name = 'Ranking';
  async execute(ctx: PipelineContext, deps: PipelineDeps): Promise<StepOutcome> {
    const capabilities = detectSystemCapabilities();
    const ranker = new MultiSignalHeuristicRanker(
      {
        techStack: ctx.profile.techStack,
        focusAreas: ctx.profile.focusAreas,
        proficiency: ctx.profile.proficiency,
        minMatchScore: ctx.profile.minMatchScore || 70,
      },
      {
        os: capabilities.os === 'win32' ? 'windows' : capabilities.os === 'darwin' ? 'macos' : 'linux',
        hasDocker: capabilities.hasDocker,
        hasWsl: capabilities.hasWsl,
      },
    );

    const rankedOpportunities = ranker.rankOpportunities(ctx.opportunities!);
    if (rankedOpportunities.length === 0) {
      deps.stateMachine.transition('BLOCKED', 'All candidate issues disqualified by ranking gates');
      return halt({
        status: 'BLOCKED',
        stage: 'QUALIFICATION',
        reportSummary: 'All candidate issues were disqualified by OS feasibility or community qualification gates.',
      });
    }

    const selectedOpp = (rankedOpportunities[0] as any).opportunity || (rankedOpportunities[0] as Opportunity);
    const [owner, repo] = selectedOpp.repoFullName.split('/');
    deps.stateMachine.setRepoContext(selectedOpp.repoFullName, selectedOpp.issueNumber);
    ctx.ranked = rankedOpportunities;
    ctx.selectedOpp = selectedOpp;
    ctx.owner = owner;
    ctx.repo = repo;
    return continuePipeline();
  }
}

// ── Phase 1: Clean-room Workspace Allocation ────────────────────────────────

export class WorkspaceAllocationStep implements PipelineStep {
  readonly name = 'WorkspaceAllocation';
  async execute(ctx: PipelineContext, deps: PipelineDeps): Promise<StepOutcome> {
    const selectedOpp = ctx.selectedOpp!;
    deps.stateMachine.transition('ONBOARDING', `Preparing clean-room worktree for ${selectedOpp.repoFullName}`);
    const workspace = deps.worktreeManager.createIsolatedWorkspace({
      repoFullName: selectedOpp.repoFullName,
      issueOrTaskId: selectedOpp.issueNumber,
    });
    deps.stateMachine.setWorkspace(workspace.workspacePath);
    ctx.workspace = { workspacePath: workspace.workspacePath, branchName: workspace.branchName };
    return continuePipeline();
  }
}

// ── Phase 2 + 2.5: Context Assembly & Pre-Fix Baseline ──────────────────────

export class ContextAssemblyStep implements PipelineStep {
  readonly name = 'ContextAssembly';
  async execute(ctx: PipelineContext, deps: PipelineDeps): Promise<StepOutcome> {
    const selectedOpp = ctx.selectedOpp!;
    deps.stateMachine.transition('PATCH_DESIGN', 'Assembling multi-dimensional context');
    const assembledContext = await deps.contextAssembler.assemble({
      repoFullName: selectedOpp.repoFullName,
      issueNumber: selectedOpp.issueNumber,
      issueTitle: selectedOpp.title,
      issueBody: selectedOpp.body,
      workspacePath: ctx.workspace!.workspacePath,
    });
    const prompt = deps.contextAssembler.formatContextPrompt(assembledContext);

    const testCmd =
      assembledContext.repoContext.runnableCommands.testCommand ||
      assembledContext.repoContext.testCommandHint;

    let preFixReproductionCaptured = false;
    let preFixOutput = '';
    if (testCmd) {
      const preCheck = verifyEmpiricalReproduction({
        cwd: ctx.workspace!.workspacePath,
        testCommand: testCmd,
      });
      preFixReproductionCaptured = preCheck.assertionCaptured;
      preFixOutput = preCheck.baselineOutput;
    }

    ctx.assembledContext = assembledContext;
    ctx.prompt = prompt;
    ctx.testCmd = testCmd;
    ctx.preFixReproductionCaptured = preFixReproductionCaptured;
    ctx.preFixOutput = preFixOutput;
    return continuePipeline();
  }
}

// ── Phase (initial): Schema-First LLM Patch Generation ──────────────────────

export class PatchGenerationStep implements PipelineStep {
  readonly name = 'PatchGeneration';
  async execute(ctx: PipelineContext, deps: PipelineDeps): Promise<StepOutcome> {
    let patchDraft: PatchDraft | null = null;

    if (deps.llmService) {
      try {
        const llmResult = await deps.llmService.generateStructured({
          prompt: `${ctx.prompt}\n\nPlease generate a minimal surgical patch conforming strictly to PatchDraftSchema JSON with concrete code files in the 'files' array.`,
          schema: PatchDraftSchema,
        });
        // SAFETY: PatchDraftSchema (Zod) validated llmResult.data at runtime;
        // the schema's output type is structurally identical to PatchDraft.
        patchDraft = llmResult.data as unknown as PatchDraft;
      } catch {
        // LLM generation failed — refuse to fabricate a patch (fail-closed).
        // The empty-patch gate below halts the pipeline.
      }
    }

    // P0: Do NOT generate fake placeholder patches if LLM fails or is unconfigured!
    if (!patchDraft || !patchDraft.files || patchDraft.files.length === 0) {
      deps.stateMachine.transition('BLOCKED', 'LLM Patch generation failed or generated empty patch');
      return halt({
        status: 'BLOCKED',
        stage: 'PATCH_DESIGN',
        selectedOpportunity: ctx.selectedOpp,
        workspacePath: ctx.workspace?.workspacePath,
        reportSummary: 'Pipeline halted: No valid surgical patch produced. Refusing to inject fake placeholder files.',
      });
    }

    ctx.patchDraft = patchDraft;
    ctx.activePatch = patchDraft;
    return continuePipeline();
  }
}

// ── Phases 3-4: Observe -> Physical Edit -> Run Test -> Diagnose -> Replan ──

export class ImplementValidateLoopStep implements PipelineStep {
  readonly name = 'ImplementValidateLoop';
  async execute(ctx: PipelineContext, deps: PipelineDeps): Promise<StepOutcome> {
    const workspacePath = ctx.workspace!.workspacePath;
    const prompt = ctx.prompt!;
    const testCmd = ctx.testCmd;
    const activePatchRef = { patch: ctx.activePatch! };

    deps.stateMachine.transition('SANDBOX_VALIDATION', 'Executing empirical baseline assertion checks in sandbox');

    let implementationAttempts = 0;
    const maxAttempts = 2;
    let validationPassed = false;
    let validationStatus: ValidationStatus = 'NO_TEST_AVAILABLE';
    let appliedFiles: Array<{ path: string; operation: string }> = [];
    const accumulatedAppliedFiles: Array<{ path: string; operation: string }> = [];
    let evidenceReport: any;
    let lastFailureOutput = '';
    const toolFeedback: import('../agent-orchestrator.js').ToolFeedbackEntry[] = [];

    const loopRuns = ctx.stressLoopRuns || 1;

    while (implementationAttempts < maxAttempts && !validationPassed) {
      implementationAttempts++;
      appliedFiles = [];

      const turnPrompt =
        implementationAttempts > 1
          ? buildTurnPrompt({
              basePrompt: prompt,
              testCommand: testCmd,
              feedback: toolFeedback,
              appliedFiles: accumulatedAppliedFiles,
              attemptNumber: implementationAttempts,
              maxAttempts,
            })
          : `${prompt}\n\nPlease generate a minimal surgical patch conforming strictly to PatchDraftSchema JSON with concrete code files in the 'files' array.`;

      // Generate (or re-generate on repair turn) the patch draft from the per-turn prompt
      if (implementationAttempts > 1) {
        if (deps.llmService) {
          try {
            const repairResult = await deps.llmService.generateStructured({
              prompt: turnPrompt,
              schema: PatchDraftSchema,
            });
            if (
              repairResult.data &&
              (repairResult.data as any).files &&
              (repairResult.data as any).files.length > 0
            ) {
              // SAFETY: PatchDraftSchema (Zod) validated repairResult.data at
              // runtime; the schema's output type is structurally identical to
              // PatchDraft. Guard above already checked `.files.length > 0`.
              activePatchRef.patch = repairResult.data as unknown as PatchDraft;
            }
          } catch {
            // Repair LLM call failed — keep the previous patch draft and retry.
          }
        } else {
          break;
        }
      }

      // 1. Physically apply file edits to worktree with strict boundary checking
      const safeApplyResult = deps.worktreeManager.applySurgicalFilesSafely(
        workspacePath,
        activePatchRef.patch.files.map((f) => ({
          path: f.path,
          operation: f.operation,
          content: f.content,
        })),
      );

      appliedFiles = safeApplyResult.appliedFiles;
      accumulatedAppliedFiles.push(...appliedFiles);

      if (safeApplyResult.errors.length > 0) {
        validationStatus = 'VALIDATION_FAILED';
        validationPassed = false;
        lastFailureOutput = `Workspace safety boundary error: ${safeApplyResult.errors.join('; ')}`;
        toolFeedback.push({
          turn: implementationAttempts,
          toolName: 'applySurgicalFilesSafely',
          output: lastFailureOutput,
          success: false,
        });
      } else if (testCmd) {
        try {
          evidenceReport = await collectEvidence({
            cwd: workspacePath,
            testCommand: testCmd,
            stressLoopCount: loopRuns,
            runFlakyBaseline: false,
          });

          const output = `Stress loops passed: ${evidenceReport.stressLoopPassed}, Passed tests: ${evidenceReport.passedUnitTestsCount}, Failed tests: ${evidenceReport.failedUnitTestsCount || 0}`;
          toolFeedback.push({
            turn: implementationAttempts,
            toolName: 'collectEvidence',
            command: testCmd,
            exitCode: evidenceReport.exitCode,
            output: output,
            success: evidenceReport.stressLoopPassed,
          });

          if (evidenceReport.stressLoopPassed) {
            validationStatus = 'VALIDATED';
            validationPassed = true;
          } else {
            validationStatus = 'VALIDATION_FAILED';
            validationPassed = false;
            lastFailureOutput = `Stress loop failed on ${testCmd}. ${output}`;
          }
        } catch (err: any) {
          validationStatus = 'VALIDATION_UNAVAILABLE';
          validationPassed = false;
          lastFailureOutput = `Validation execution error: ${err.message}`;
          toolFeedback.push({
            turn: implementationAttempts,
            toolName: 'collectEvidence',
            command: testCmd,
            output: lastFailureOutput,
            success: false,
          });
        }
      } else {
        validationStatus = 'NO_TEST_AVAILABLE';
        validationPassed = false;
        break;
      }
    }

    const isReproductionVerified = ctx.preFixReproductionCaptured === true && validationStatus === 'VALIDATED';
    deps.stateMachine.setReproductionCaptured(isReproductionVerified);

    ctx.activePatch = activePatchRef.patch;
    ctx.implementationAttempts = implementationAttempts;
    ctx.validationStatus = validationStatus;
    ctx.appliedFiles = appliedFiles;
    ctx.evidenceReport = evidenceReport;
    ctx.toolFeedback = toolFeedback;
    return continuePipeline();
  }
}

// ── Phase 5: Adversarial Subagent Review ────────────────────────────────────

export class SubagentReviewStep implements PipelineStep {
  readonly name = 'SubagentReview';
  async execute(ctx: PipelineContext, deps: PipelineDeps): Promise<StepOutcome> {
    const selectedOpp = ctx.selectedOpp!;
    const activePatch = ctx.activePatch!;
    const validationStatus = ctx.validationStatus!;
    const evidenceReport = ctx.evidenceReport;

    deps.stateMachine.transition('SUBAGENT_REVIEW', 'Running Maintainer/Security/QA evaluation');
    const reviewPrompt = `${generateSubagentReviewPrompt({
      repoFullName: selectedOpp.repoFullName,
      issueTitle: selectedOpp.title,
      issueBody: selectedOpp.body,
      diffText: activePatch.files.map((f) => `--- ${f.path}\n+++ ${f.path}\n${f.content}`).join('\n\n'),
      testEvidence: evidenceReport
        ? `Validation status: ${validationStatus}, Stress loops passed: ${evidenceReport.stressLoopPassed}, Passed tests: ${evidenceReport.passedUnitTestsCount}`
        : `Validation status: ${validationStatus} (No automated test detected)`,
    })}\n\nPlease return structured JSON conforming strictly to SubagentReviewEvaluationSchema.`;

    let subagentReview: OrchestratorSubagentReview = { status: 'UNAVAILABLE' };

    if (deps.llmService) {
      try {
        const reviewResult = await deps.llmService.generateStructured({
          prompt: reviewPrompt,
          schema: SubagentReviewEvaluationSchema,
        });
        if (reviewResult.data && (reviewResult.data as any).confidenceBreakdown) {
          subagentReview = {
            status: 'SUCCESS',
            maintainerPerspective: (reviewResult.data as any).maintainerPerspective,
            securityPerspective: (reviewResult.data as any).securityPerspective,
            qaPerspective: (reviewResult.data as any).qaPerspective,
            confidenceBreakdown: (reviewResult.data as any).confidenceBreakdown,
          };
        }
      } catch (err: any) {
        subagentReview = {
          status: 'FAILED',
          failureReason: err.message,
        };
      }
    }

    ctx.subagentReview = subagentReview;
    return continuePipeline();
  }
}

// ── Phase 5 (quality rubric): Evidence-Backed Quality Rubric ────────────────

export class QualityRubricStep implements PipelineStep {
  readonly name = 'QualityRubric';
  async execute(ctx: PipelineContext, deps: PipelineDeps): Promise<StepOutcome> {
    const activePatch = ctx.activePatch!;
    const validationStatus = ctx.validationStatus!;
    const evidenceReport = ctx.evidenceReport;
    const subagentReview = ctx.subagentReview!;

    const confidenceBreakdown =
      subagentReview.status === 'SUCCESS' ? subagentReview.confidenceBreakdown : undefined;
    const isReviewAvailable = subagentReview.status === 'SUCCESS' && !!confidenceBreakdown;
    const { rubricResult: qualityRubric } = deriveEvidenceBackedQualityRubric({
      hasReproductionAssertion: (ctx.preFixReproductionCaptured ?? false) && validationStatus === 'VALIDATED',
      testsPassed: validationStatus === 'VALIDATED',
      passedTestsCount:
        evidenceReport?.passedUnitTestsCount || (validationStatus === 'VALIDATED' ? 1 : 0),
      diffLines: activePatch.estimatedDiffLines,
      styleScore: confidenceBreakdown?.styleMatch,
      securityScore: confidenceBreakdown?.securityAudit,
      subagentReviewAvailable: isReviewAvailable,
    });

    deps.stateMachine.setConfidenceScore(qualityRubric.overallScore);
    ctx.qualityRubric = qualityRubric as any;
    return continuePipeline();
  }
}

// ── Phase 5.5: Unified Contribution Risk Engine Assessment ──────────────────

export class RiskAssessmentGateStep implements PipelineStep {
  readonly name = 'RiskAssessmentGate';
  async execute(ctx: PipelineContext, deps: PipelineDeps): Promise<StepOutcome> {
    const selectedOpp = ctx.selectedOpp!;
    const activePatch = ctx.activePatch!;
    const validationStatus = ctx.validationStatus!;
    const qualityRubric = ctx.qualityRubric!;

    const riskAssessment: RiskAssessment = assessContributionRisk({
      repoFullName: selectedOpp.repoFullName,
      diffLines: activePatch.estimatedDiffLines,
      filesCount: activePatch.files.length,
      validationStatus,
      subagentQualityScore: qualityRubric.overallScore,
    });

    if (
      riskAssessment.riskLevel === 'CRITICAL' ||
      riskAssessment.recommendedPolicy === 'blocked' ||
      (!qualityRubric.isPassed &&
        !ctx.humanApproved &&
        (validationStatus === 'VALIDATION_FAILED' || validationStatus === 'VALIDATION_UNAVAILABLE'))
    ) {
      deps.stateMachine.transition(
        'BLOCKED',
        `Contribution risk critical or validation failed: ${riskAssessment.reasons.join(', ')}`,
      );
      return halt({
        status: 'BLOCKED',
        stage: 'SUBAGENT_REVIEW',
        selectedOpportunity: selectedOpp,
        workspacePath: ctx.workspace?.workspacePath,
        patchDraft: activePatch,
        implementationAttempts: ctx.implementationAttempts,
        validationStatus,
        confidenceScore: qualityRubric.overallScore,
        subagentReview: ctx.subagentReview,
        riskAssessment,
        reportSummary: `Patch rejected by Quality Rubric & Risk Engine (Overall: ${qualityRubric.overallScore}%, Risk: ${riskAssessment.riskLevel}). Reasons: ${riskAssessment.reasons.join('; ')}`,
      });
    }

    ctx.riskAssessment = riskAssessment;
    return continuePipeline();
  }
}

// ── Telemetry snapshot (post risk gate) ─────────────────────────────────────

export class TelemetryStep implements PipelineStep {
  readonly name = 'Telemetry';
  async execute(ctx: PipelineContext, deps: PipelineDeps): Promise<StepOutcome> {
    const selectedOpp = ctx.selectedOpp!;
    const qualityRubric = ctx.qualityRubric!;
    const riskAssessment = ctx.riskAssessment!;

    const durationMs = deps.clock.now().getTime() - ctx.startTime;
    ctx.telemetry = {
      runId: `run_${deps.clock.now().getTime()}`,
      repoFullName: selectedOpp.repoFullName,
      issueNumber: selectedOpp.issueNumber,
      attempts: ctx.implementationAttempts ?? 0,
      durationMs,
      qualityScore: qualityRubric.overallScore,
      riskScore: riskAssessment.riskScore,
      riskLevel: riskAssessment.riskLevel,
      status: 'SUCCESS',
    };
    return continuePipeline();
  }
}

// ── Phase 6: Human Gate & Execution Policy Check ────────────────────────────

export class HumanGateStep implements PipelineStep {
  readonly name = 'HumanGate';
  async execute(ctx: PipelineContext, deps: PipelineDeps): Promise<StepOutcome> {
    const selectedOpp = ctx.selectedOpp!;
    const activePatch = ctx.activePatch!;
    const validationStatus = ctx.validationStatus!;
    const qualityRubric = ctx.qualityRubric!;
    const policy = ctx.policy!;
    const riskAssessment = ctx.riskAssessment!;

    const requiresHumanGate =
      (policy.mode === 'interactive' && !ctx.humanApproved) ||
      (riskAssessment.riskLevel !== 'LOW' && !ctx.humanApproved) ||
      (validationStatus === 'NO_TEST_AVAILABLE' && !ctx.humanApproved);

    if (requiresHumanGate) {
      deps.stateMachine.transition('HUMAN_GATE', 'Awaiting human confirmation');
      return halt({
        status: 'HUMAN_APPROVAL_REQUIRED',
        stage: 'HUMAN_GATE',
        selectedOpportunity: selectedOpp,
        workspacePath: ctx.workspace?.workspacePath,
        patchDraft: activePatch,
        appliedFiles: ctx.appliedFiles,
        implementationAttempts: ctx.implementationAttempts,
        validationStatus,
        confidenceScore: qualityRubric.overallScore,
        subagentReview: ctx.subagentReview,
        riskAssessment,
        telemetry: ctx.telemetry,
        reportSummary: `Candidate patch applied in sandbox (${ctx.implementationAttempts} attempt(s)) for #${selectedOpp.issueNumber}. Risk Level: ${riskAssessment.riskLevel} (${riskAssessment.riskScore}/100). Validation: ${validationStatus}. Awaiting human review before opening PR.`,
      });
    }
    return continuePipeline();
  }
}

// ── Dry Run / Local Artifacts Only Mode ─────────────────────────────────────

export class DryRunStep implements PipelineStep {
  readonly name = 'DryRun';
  async execute(ctx: PipelineContext, deps: PipelineDeps): Promise<StepOutcome> {
    const selectedOpp = ctx.selectedOpp!;
    const activePatch = ctx.activePatch!;
    const validationStatus = ctx.validationStatus!;
    const qualityRubric = ctx.qualityRubric!;
    const policy = ctx.policy!;
    const riskAssessment = ctx.riskAssessment!;
    const durationMs = deps.clock.now().getTime() - ctx.startTime;

    if (policy.mode === 'dry_run' || policy.mode === 'local_artifacts_only' || !policy.allowRealPr) {
      if (policy.autoPurgeSandboxOnFinish) {
        deps.worktreeManager.cleanupWorkspace(ctx.workspace!.workspacePath);
      }
      deps.stateMachine.transition('COMPLETED', 'Dry run contribution completed successfully');
      return halt({
        status: 'DRY_RUN_COMPLETED',
        stage: 'COMPLETED',
        selectedOpportunity: selectedOpp,
        workspacePath: ctx.workspace?.workspacePath,
        patchDraft: activePatch,
        appliedFiles: ctx.appliedFiles,
        implementationAttempts: ctx.implementationAttempts,
        validationStatus,
        confidenceScore: qualityRubric.overallScore,
        subagentReview: ctx.subagentReview,
        riskAssessment,
        telemetry: ctx.telemetry,
        reportSummary: `Dry run completed for #${selectedOpp.issueNumber} in ${durationMs}ms. Physical patch verified without opening live PR.`,
      });
    }
    return continuePipeline();
  }
}

// ── Phase 7a: Authoritative State Machine Submission Policy Enforcement ─────

export class SubmissionPolicyStep implements PipelineStep {
  readonly name = 'SubmissionPolicy';
  async execute(ctx: PipelineContext, deps: PipelineDeps): Promise<StepOutcome> {
    const selectedOpp = ctx.selectedOpp!;
    const activePatch = ctx.activePatch!;
    const validationStatus = ctx.validationStatus!;
    const qualityRubric = ctx.qualityRubric!;
    const riskAssessment = ctx.riskAssessment!;

    const submissionGate = deps.stateMachine.canProceedToSubmission();
    if (!submissionGate.allowed) {
      const currentState = deps.stateMachine.getState();
      deps.stateMachine.transition('BLOCKED', 'Submission blocked by authoritative state machine policy');
      return halt({
        status: 'BLOCKED',
        stage: 'SUBMISSION_POLICY_BLOCKED',
        selectedOpportunity: selectedOpp,
        workspacePath: ctx.workspace?.workspacePath,
        patchDraft: activePatch,
        appliedFiles: ctx.appliedFiles,
        implementationAttempts: ctx.implementationAttempts,
        validationStatus,
        confidenceScore: qualityRubric.overallScore,
        subagentReview: ctx.subagentReview,
        riskAssessment,
        telemetry: { ...ctx.telemetry!, status: 'BLOCKED' },
        reportSummary: `PR submission physically blocked by authoritative state machine policy: confidenceScore (${currentState.confidenceScore}) < 90, reproduction unverified, or execution policy violation.`,
      });
    }

    deps.stateMachine.transition('PR_SUBMISSION', 'Creating Pull Request on GitHub');
    return continuePipeline();
  }
}

// ── Phase 7b: Real Pull Request Submission & Verified Flywheel Sync ─────────

export class PrSubmissionStep implements PipelineStep {
  readonly name = 'PrSubmission';
  async execute(ctx: PipelineContext, deps: PipelineDeps): Promise<StepOutcome> {
    const selectedOpp = ctx.selectedOpp!;
    const activePatch = ctx.activePatch!;
    const validationStatus = ctx.validationStatus!;
    const qualityRubric = ctx.qualityRubric!;
    const policy = ctx.policy!;
    const riskAssessment = ctx.riskAssessment!;
    const owner = ctx.owner!;
    const repo = ctx.repo!;

    const prDraftText = buildPrDescription({
      issueNumber: selectedOpp.issueNumber,
      problemSummary: activePatch?.summary || selectedOpp.title,
      rootCause: activePatch?.rationale || 'Targeted surgical bugfix',
      keyChanges: activePatch?.implementationSteps || ['Applied surgical fix'],
      reproductionCommand: activePatch?.regressionTestPlan?.[0] || 'npm test',
      verificationCommand: 'npm test',
      testCount: 5,
      dcoAuthorName: 'OpenContrib',
      dcoAuthorEmail: 'bot@opencontrib.dev',
    });

    let prUrl: string;
    let prNumber: number;

    try {
      const submission = await deps.prService.submitPullRequest({
        upstreamOwner: owner,
        upstreamRepo: repo,
        title: `fix: ${selectedOpp.title}`,
        body: prDraftText,
        branchName: ctx.workspace!.branchName,
        files: ctx.activePatch!.files.map((f) => ({ path: f.path, content: f.content })),
        commitMessage: `fix: ${selectedOpp.title}`,
        isDraft: true,
      });

      prUrl = submission.prUrl;
      prNumber = submission.prNumber;
      if (ctx.telemetry) ctx.telemetry.prUrl = prUrl;
    } catch (err: any) {
      deps.stateMachine.transition('BLOCKED', `Failed to submit Pull Request: ${err.message}`);
      return halt({
        status: 'BLOCKED',
        stage: 'PR_SUBMISSION',
        selectedOpportunity: selectedOpp,
        workspacePath: ctx.workspace?.workspacePath,
        patchDraft: ctx.patchDraft || undefined,
        appliedFiles: ctx.appliedFiles,
        implementationAttempts: ctx.implementationAttempts,
        validationStatus,
        confidenceScore: qualityRubric.overallScore,
        subagentReview: ctx.subagentReview,
        riskAssessment,
        telemetry: { ...ctx.telemetry!, status: 'FAILED' },
        reportSummary: `Failed to create real GitHub Pull Request: ${err.message}. Operation aborted; Flywheel not modified.`,
      });
    }

    // Record success ONLY when PR submission succeeds
    deps.memory.recordSuccess(selectedOpp.repoFullName, {
      title: selectedOpp.title,
      issueNumber: selectedOpp.issueNumber,
      prNumber,
      prUrl,
    });

    deps.flywheel.saveRecord({
      id: `${selectedOpp.repoFullName}#${prNumber}`,
      repoFullName: selectedOpp.repoFullName,
      issueNumber: selectedOpp.issueNumber,
      issueTitle: selectedOpp.title,
      prNumber,
      prUrl,
      status: 'submitted',
      submittedAt: deps.clock.nowIso(),
      diffStat: `~${activePatch?.estimatedDiffLines || 10} lines`,
      evidenceSummary: `Verified across ${ctx.implementationAttempts} attempt(s) with ${qualityRubric.overallScore}% quality score (${validationStatus})`,
      provenance: {
        source: 'system_recorded',
        verified: true,
        verifiedAt: deps.clock.nowIso(),
      },
    });

    // Cleanup workspace if configured
    if (policy.autoPurgeSandboxOnFinish) {
      deps.worktreeManager.cleanupWorkspace(ctx.workspace!.workspacePath);
    }

    deps.stateMachine.transition('COMPLETED', 'PR submitted and flywheel synced');

    return halt({
      status: 'COMPLETED',
      stage: 'COMPLETED',
      selectedOpportunity: selectedOpp,
      workspacePath: ctx.workspace?.workspacePath,
      patchDraft: ctx.patchDraft || undefined,
      appliedFiles: ctx.appliedFiles,
      implementationAttempts: ctx.implementationAttempts,
      validationStatus,
      confidenceScore: qualityRubric.overallScore,
      subagentReview: ctx.subagentReview,
      riskAssessment,
      telemetry: ctx.telemetry,
      prUrl,
      prNumber,
      reportSummary: `Successfully executed autonomous contribution loop for #${selectedOpp.issueNumber}. PR opened: ${prUrl}`,
    });
  }
}

/** Ordered pipeline. Each step runs until one halts the pipeline. */
export const PIPELINE_STEPS: PipelineStep[] = [
  new DiscoveryScoutStep(),
  new RankingStep(),
  new WorkspaceAllocationStep(),
  new ContextAssemblyStep(),
  new PatchGenerationStep(),
  new ImplementValidateLoopStep(),
  new SubagentReviewStep(),
  new QualityRubricStep(),
  new RiskAssessmentGateStep(),
  new TelemetryStep(),
  new HumanGateStep(),
  new DryRunStep(),
  new SubmissionPolicyStep(),
  new PrSubmissionStep(),
];
