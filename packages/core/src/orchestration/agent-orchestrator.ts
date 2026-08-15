import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { GitHubClient } from '../discovery/github-client.js';
import { scoutOpportunities } from '../discovery/scout.js';
import { MultiSignalHeuristicRanker } from '../discovery/ranking.js';
import { detectSystemCapabilities } from '../discovery/feasibility.js';
import { ContextAssembler } from '../discovery/context-assembler.js';
import { WorktreeManager } from '../workspace/worktree-manager.js';
import {
  collectEvidence,
  runStressLoop,
  verifyEmpiricalReproduction,
  verifyDualStageReproduction,
} from '../evidence/evidence-collector.js';
import { RepoMemoryLedger } from '../memory/repo-memory.js';
import { ProfileFlywheel } from '../flywheel/profile-sync.js';
import { ContributionPrService } from '../github/contribution-pr-service.js';
import {
  auditGovernance,
  lintAntiAiText,
  calculate7DQualityRubric,
  deriveEvidenceBackedQualityRubric,
} from '../governance/governance-auditor.js';
import { generateSubagentReviewPrompt, type SubagentReviewEvaluation } from '../governance/subagent-reviewer.js';
import { buildPrDescription } from '../governance/template-merger.js';
import { LLMService } from '../llm/llm-service.js';
import {
  PatchDraftSchema,
  SubagentReviewEvaluationSchema,
  type PatchDraft,
} from '../contracts/llm-schemas.js';
import {
  ContributionStateMachine,
  type ExecutionPolicy,
  DEFAULT_EXECUTION_POLICY,
} from './state-machine.js';
import {
  assessContributionRisk,
  type RiskAssessment,
  type ValidationStatus,
} from '../risk/risk-engine.js';
import type { UserProfile, Opportunity, ConfidenceBreakdown } from '../contracts/schemas.js';

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
  subagentReview?: SubagentReviewEvaluation;
  riskAssessment?: RiskAssessment;
  prUrl?: string;
  prNumber?: number;
  telemetry?: TelemetryRecord;
  reportSummary: string;
}

export class AgentOrchestrator {
  private client: GitHubClient;
  private memory: RepoMemoryLedger;
  private flywheel: ProfileFlywheel;
  private worktreeManager: WorktreeManager;
  private prService: ContributionPrService;
  private llmService?: LLMService;
  private contextAssembler: ContextAssembler;
  private stateMachine: ContributionStateMachine;

  constructor(options: {
    policy?: Partial<ExecutionPolicy>;
    githubToken?: string;
    llmService?: LLMService;
  } = {}) {
    this.client = new GitHubClient({ token: options.githubToken });
    this.memory = new RepoMemoryLedger();
    this.flywheel = new ProfileFlywheel();
    this.worktreeManager = new WorktreeManager();
    this.prService = new ContributionPrService(this.client);
    if (options.llmService) {
      this.llmService = options.llmService;
    } else {
      try {
        this.llmService = new LLMService();
      } catch {
        this.llmService = undefined;
      }
    }
    this.contextAssembler = new ContextAssembler(this.memory);
    this.stateMachine = new ContributionStateMachine(options.policy);
  }


  async runPipeline(input: {
    profile: UserProfile;
    targetRepo?: string;
    humanApproved?: boolean;
    stressLoopRuns?: number;
  }): Promise<OrchestratorRunResult> {
    const startTime = Date.now();
    const policy = this.stateMachine.getState().policy;

    // ─────────────────────────────────────────────────────────────
    // Phase 0: Discovery & Scout
    // ─────────────────────────────────────────────────────────────
    this.stateMachine.transition('DISCOVERY', 'Scouting candidate issues with live GitHub search');
    const opportunities = await scoutOpportunities(input.profile, {
      repo: input.targetRepo,
      limit: 5,
    });

    if (opportunities.length === 0) {
      this.stateMachine.transition('BLOCKED', 'No qualified issues found');
      return {
        status: 'BLOCKED',
        stage: 'DISCOVERY',
        reportSummary: 'No qualified, unclaimed open issues matched current profile and feasibility gates.',
      };
    }

    // ─────────────────────────────────────────────────────────────
    // Phase 0.5: Dynamic Runtime Probe & Multi-Signal Heuristic Issue Ranking
    // ─────────────────────────────────────────────────────────────
    const capabilities = detectSystemCapabilities();
    const ranker = new MultiSignalHeuristicRanker({
      techStack: input.profile.techStack,
      focusAreas: input.profile.focusAreas,
      proficiency: input.profile.proficiency,
      os: capabilities.os,
      hasDocker: capabilities.hasDocker,
      hasWsl: capabilities.hasWsl,
    });

    const rankedOpportunities = ranker.rankOpportunities(opportunities);
    if (rankedOpportunities.length === 0) {
      this.stateMachine.transition('BLOCKED', 'All candidate issues disqualified by ranking gates');
      return {
        status: 'BLOCKED',
        stage: 'QUALIFICATION',
        reportSummary: 'All candidate issues were disqualified by OS feasibility or community qualification gates.',
      };
    }

    // 2-stage reranked top item
    const selectedOpp = (rankedOpportunities[0] as any).opportunity || rankedOpportunities[0];
    const [owner, repo] = selectedOpp.repoFullName.split('/');
    this.stateMachine.setRepoContext(selectedOpp.repoFullName, selectedOpp.issueNumber);

    // ─────────────────────────────────────────────────────────────
    // Phase 1: Clean-room Workspace Allocation
    // ─────────────────────────────────────────────────────────────
    this.stateMachine.transition('ONBOARDING', `Preparing clean-room worktree for ${selectedOpp.repoFullName}`);
    const workspace = this.worktreeManager.createIsolatedWorkspace({
      repoFullName: selectedOpp.repoFullName,
      issueOrTaskId: selectedOpp.issueNumber,
    });
    this.stateMachine.setWorkspace(workspace.workspacePath);

    // ─────────────────────────────────────────────────────────────
    // Phase 2: Multi-dimensional Context Assembly
    // ─────────────────────────────────────────────────────────────
    this.stateMachine.transition('PATCH_DESIGN', 'Assembling multi-dimensional context');
    const assembledContext = this.contextAssembler.assemble({
      repoFullName: selectedOpp.repoFullName,
      issueNumber: selectedOpp.issueNumber,
      issueTitle: selectedOpp.title,
      issueBody: selectedOpp.body,
      workspacePath: workspace.workspacePath,
    });
    const prompt = this.contextAssembler.formatContextPrompt(assembledContext);

    const testCmd =
      assembledContext.repoContext.runnableCommands.testCommand ||
      assembledContext.repoContext.testCommandHint;

    // ─────────────────────────────────────────────────────────────
    // Phase 2.5: Pre-Fix Baseline Empirical Reproduction Assertion Probe
    // ─────────────────────────────────────────────────────────────
    let preFixReproductionCaptured = false;
    let preFixOutput = '';
    if (testCmd) {
      const preCheck = verifyEmpiricalReproduction({
        cwd: workspace.workspacePath,
        testCommand: testCmd,
      });
      preFixReproductionCaptured = preCheck.assertionCaptured;
      preFixOutput = preCheck.baselineOutput;
    }

    // Initial Schema-First LLM Patch Generation
    let patchDraft: PatchDraft | null = null;

    if (this.llmService) {
      try {
        const llmResult = await this.llmService.generateStructured({
          prompt: `${prompt}\n\nPlease generate a minimal surgical patch conforming strictly to PatchDraftSchema JSON with concrete code files in the 'files' array.`,
          schema: PatchDraftSchema,
        });
        patchDraft = llmResult.data;
      } catch {
        // LLM Error
      }
    }

    // P0: Do NOT generate fake placeholder patches if LLM fails or is unconfigured!
    if (!patchDraft || !patchDraft.files || patchDraft.files.length === 0) {
      this.stateMachine.transition('BLOCKED', 'LLM Patch generation failed or generated empty patch');
      return {
        status: 'BLOCKED',
        stage: 'PATCH_DESIGN',
        selectedOpportunity: selectedOpp,
        workspacePath: workspace.workspacePath,
        reportSummary: 'Pipeline halted: No valid surgical patch produced. Refusing to inject fake placeholder files.',
      };
    }


    // ─────────────────────────────────────────────────────────────
    // Phase 3 - 4: Observe -> Physical Edit (with Boundary Check) -> Run Test -> Diagnose -> Replan Loop
    // ─────────────────────────────────────────────────────────────
    this.stateMachine.transition('SANDBOX_VALIDATION', 'Executing empirical baseline assertion checks in sandbox');

    let implementationAttempts = 0;
    const maxAttempts = 2;
    let validationPassed = false;
    let validationStatus: ValidationStatus = 'NO_TEST_AVAILABLE';
    let appliedFiles: Array<{ path: string; operation: string }> = [];
    let filesToSubmit: Array<{ path: string; content: string }> = [];
    let evidenceReport: any;
    let lastFailureOutput = '';

    const loopRuns = input.stressLoopRuns || (selectedOpp.track === 'FAST_TRACK' ? 3 : 20);

    while (implementationAttempts < maxAttempts && !validationPassed) {
      implementationAttempts++;
      appliedFiles = [];
      filesToSubmit = [];

      // 1. Physically apply file edits to worktree with strict boundary checking
      const safeApplyResult = this.worktreeManager.applySurgicalFilesSafely(
        workspace.workspacePath,
        patchDraft.files.map((f) => ({
          path: f.path,
          operation: f.operation,
          content: f.content,
        })),
      );

      appliedFiles = safeApplyResult.appliedFiles;
      filesToSubmit = patchDraft.files.map((f) => ({ path: f.path, content: f.content }));

      if (safeApplyResult.errors.length > 0) {
        validationStatus = 'VALIDATION_FAILED';
        validationPassed = false;
        lastFailureOutput = `Workspace safety boundary error: ${safeApplyResult.errors.join('; ')}`;
      } else if (testCmd) {
        // 2. Validate in sanitized sandbox runtime
        try {
          evidenceReport = await collectEvidence({
            cwd: workspace.workspacePath,
            testCommand: testCmd,
            stressLoopCount: loopRuns,
            runFlakyBaseline: false,
          });

          if (evidenceReport.stressLoopPassed) {
            validationStatus = 'VALIDATED';
            validationPassed = true;
          } else {
            validationStatus = 'VALIDATION_FAILED';
            validationPassed = false;
            lastFailureOutput = `Stress loop failed on ${testCmd}. Total passing tests: ${evidenceReport.passedUnitTestsCount}`;
          }
        } catch (err: any) {
          validationStatus = 'VALIDATION_UNAVAILABLE';
          validationPassed = false;
          lastFailureOutput = `Validation execution error: ${err.message}`;
        }
      } else {
        validationStatus = 'NO_TEST_AVAILABLE';
        validationPassed = false; // No automated tests executed; does not pretend to be validated
        break; // No repair loop needed when no test command exists
      }

      // 3. If failed and attempts remain, trigger LLM Diagnose & Repair with REAL failure trace
      if (!validationPassed && implementationAttempts < maxAttempts && validationStatus !== 'NO_TEST_AVAILABLE') {

        const repairPrompt = `${prompt}

### Sandboxed Validation Failure Trace (Attempt ${implementationAttempts}/${maxAttempts}):
\`\`\`
${lastFailureOutput.slice(-2000)}
\`\`\`
- **Test Command**: \`${testCmd}\`
- **Failing Files Changed**: ${appliedFiles.map((f) => f.path).join(', ')}

Please diagnose the exact failure reason above and generate a revised surgical patch conforming strictly to PatchDraftSchema JSON.`;

        try {
          const repairResult = await this.llmService.generateStructured({
            prompt: repairPrompt,
            schema: PatchDraftSchema,
          });
          if (repairResult.data && repairResult.data.files && repairResult.data.files.length > 0) {
            patchDraft = repairResult.data;
          }
        } catch {}
      }
    }

    const isReproductionVerified = preFixReproductionCaptured && validationStatus === 'VALIDATED';
    this.stateMachine.setReproductionCaptured(isReproductionVerified);

    // ─────────────────────────────────────────────────────────────
    // Phase 5: Adversarial Subagent Review & Evidence-Backed Quality Rubric
    // ─────────────────────────────────────────────────────────────
    this.stateMachine.transition('SUBAGENT_REVIEW', 'Running Maintainer/Security/QA evaluation');
    const reviewPrompt = `${generateSubagentReviewPrompt({
      repoFullName: selectedOpp.repoFullName,
      issueTitle: selectedOpp.title,
      issueBody: selectedOpp.body,
      diffText: patchDraft.files.map((f) => `--- ${f.path}\n+++ ${f.path}\n${f.content}`).join('\n\n'),
      testEvidence: evidenceReport
        ? `Validation status: ${validationStatus}, Stress loops passed: ${evidenceReport.stressLoopPassed}, Passed tests: ${evidenceReport.passedUnitTestsCount}`
        : `Validation status: ${validationStatus} (No automated test detected)`,
    })}\n\nPlease return structured JSON conforming strictly to SubagentReviewEvaluationSchema.`;

    let subagentReview: SubagentReviewEvaluation = {
      status: 'UNAVAILABLE',
    };

    if (this.llmService) {
      try {
        const reviewResult = await this.llmService.generateStructured({
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


    // Derive Evidence-Backed Quality Rubric without fake scores
    const isReviewAvailable = subagentReview.status === 'SUCCESS' && !!subagentReview.confidenceBreakdown;
    const { rubricResult: qualityRubric } = deriveEvidenceBackedQualityRubric({
      hasReproductionAssertion: isReproductionVerified,
      testsPassed: validationStatus === 'VALIDATED',
      passedTestsCount: evidenceReport?.passedUnitTestsCount || (validationStatus === 'VALIDATED' ? 1 : 0),
      diffLines: patchDraft.estimatedDiffLines,
      styleScore: subagentReview.confidenceBreakdown?.styleMatch,
      securityScore: subagentReview.confidenceBreakdown?.securityAudit,
      subagentReviewAvailable: isReviewAvailable,
    });



    this.stateMachine.setConfidenceScore(qualityRubric.overallScore);

    // ─────────────────────────────────────────────────────────────
    // Phase 5.5: Unified Contribution Risk Engine Assessment
    // ─────────────────────────────────────────────────────────────
    const riskAssessment = assessContributionRisk({
      repoFullName: selectedOpp.repoFullName,
      diffLines: patchDraft.estimatedDiffLines,
      filesCount: patchDraft.files.length,
      validationStatus,
      subagentQualityScore: qualityRubric.overallScore,
    });

    if (riskAssessment.riskLevel === 'CRITICAL' || riskAssessment.recommendedPolicy === 'blocked' || (!qualityRubric.isPassed && !input.humanApproved && validationStatus === 'VALIDATION_FAILED')) {
      this.stateMachine.transition(
        'BLOCKED',
        `Contribution risk critical or validation failed: ${riskAssessment.reasons.join(', ')}`,
      );
      return {
        status: 'BLOCKED',
        stage: 'SUBAGENT_REVIEW',
        selectedOpportunity: selectedOpp,
        workspacePath: workspace.workspacePath,
        patchDraft,
        implementationAttempts,
        validationStatus,
        confidenceScore: qualityRubric.overallScore,
        subagentReview,
        riskAssessment,
        reportSummary: `Patch rejected by Quality Rubric & Risk Engine (Overall: ${qualityRubric.overallScore}%, Risk: ${riskAssessment.riskLevel}). Reasons: ${riskAssessment.reasons.join('; ')}`,
      };
    }

    const durationMs = Date.now() - startTime;
    const telemetry: TelemetryRecord = {
      runId: `run_${Date.now()}`,
      repoFullName: selectedOpp.repoFullName,
      issueNumber: selectedOpp.issueNumber,
      attempts: implementationAttempts,
      durationMs,
      qualityScore: qualityRubric.overallScore,
      riskScore: riskAssessment.riskScore,
      riskLevel: riskAssessment.riskLevel,
      status: 'SUCCESS',
    };

    // ─────────────────────────────────────────────────────────────
    // Phase 6: Human Gate & Execution Policy Check
    // (Mandate human approval if risk is MEDIUM/HIGH or in interactive mode)
    // ─────────────────────────────────────────────────────────────
    const requiresHumanGate =
      (policy.mode === 'interactive' && !input.humanApproved) ||
      (riskAssessment.riskLevel !== 'LOW' && !input.humanApproved) ||
      (validationStatus === 'NO_TEST_AVAILABLE' && !input.humanApproved);

    if (requiresHumanGate) {
      this.stateMachine.transition('HUMAN_GATE', 'Awaiting human confirmation');
      return {
        status: 'HUMAN_APPROVAL_REQUIRED',
        stage: 'HUMAN_GATE',
        selectedOpportunity: selectedOpp,
        workspacePath: workspace.workspacePath,
        patchDraft,
        appliedFiles,
        implementationAttempts,
        validationStatus,
        confidenceScore: qualityRubric.overallScore,
        subagentReview,
        riskAssessment,
        telemetry,
        reportSummary: `Candidate patch applied in sandbox (${implementationAttempts} attempt(s)) for #${selectedOpp.issueNumber}. Risk Level: ${riskAssessment.riskLevel} (${riskAssessment.riskScore}/100). Validation: ${validationStatus}. Awaiting human review before opening PR.`,
      };
    }

    // Dry Run / Local Artifacts Only Mode
    if (policy.mode === 'dry_run' || policy.mode === 'local_artifacts_only' || !policy.allowRealPr) {
      if (policy.autoPurgeSandboxOnFinish) {
        this.worktreeManager.cleanupWorkspace(workspace.workspacePath);
      }
      this.stateMachine.transition('COMPLETED', 'Dry run contribution completed successfully');
      return {
        status: 'DRY_RUN_COMPLETED',
        stage: 'COMPLETED',
        selectedOpportunity: selectedOpp,
        workspacePath: workspace.workspacePath,
        patchDraft,
        appliedFiles,
        implementationAttempts,
        validationStatus,
        confidenceScore: qualityRubric.overallScore,
        subagentReview,
        riskAssessment,
        telemetry,
        reportSummary: `Dry run completed for #${selectedOpp.issueNumber} in ${durationMs}ms. Physical patch verified without opening live PR.`,
      };
    }

    // ─────────────────────────────────────────────────────────────
    // Phase 7: Real Pull Request Submission & Verified Flywheel Sync
    // ─────────────────────────────────────────────────────────────
    // Authoritative State Machine Submission Policy Enforcement
    if (!this.stateMachine.canProceedToSubmission()) {
      const currentState = this.stateMachine.getState();
      this.stateMachine.transition('BLOCKED', 'Submission blocked by authoritative state machine policy');
      return {
        status: 'BLOCKED',
        stage: 'SUBMISSION_POLICY_BLOCKED',
        selectedOpportunity: selectedOpp,
        workspacePath: workspace.workspacePath,
        patchDraft,
        appliedFiles,
        implementationAttempts,
        validationStatus,
        confidenceScore: qualityRubric.overallScore,
        subagentReview,
        riskAssessment,
        telemetry: { ...telemetry, status: 'BLOCKED' },
        reportSummary: `PR submission physically blocked by authoritative state machine policy: confidenceScore (${currentState.confidenceScore}) < 90, reproduction unverified, or execution policy violation.`,
      };
    }

    this.stateMachine.transition('PR_SUBMISSION', 'Creating Pull Request on GitHub');
    const prDraft = buildPrDescription({

      targetRepoFullName: selectedOpp.repoFullName,
      issueNumber: selectedOpp.issueNumber,
      issueTitle: selectedOpp.title,
      motivation: patchDraft.summary,
      changes: patchDraft.implementationSteps,
      verification: patchDraft.regressionTestPlan,
    });

    let prUrl: string;
    let prNumber: number;

    try {
      const submission = await this.prService.submitPullRequest({
        upstreamOwner: owner,
        upstreamRepo: repo,
        title: `fix: ${selectedOpp.title}`,
        body: prDraft.renderedBody,
        branchName: workspace.branchName,
        files: filesToSubmit,
        commitMessage: `fix: ${selectedOpp.title}`,
        isDraft: true,
      });

      prUrl = submission.prUrl;
      prNumber = submission.prNumber;
      telemetry.prUrl = prUrl;
    } catch (err: any) {
      this.stateMachine.transition('BLOCKED', `Failed to submit Pull Request: ${err.message}`);
      return {
        status: 'BLOCKED',
        stage: 'PR_SUBMISSION',
        selectedOpportunity: selectedOpp,
        workspacePath: workspace.workspacePath,
        patchDraft,
        appliedFiles,
        implementationAttempts,
        validationStatus,
        confidenceScore: qualityRubric.overallScore,
        subagentReview,
        riskAssessment,
        telemetry: { ...telemetry, status: 'FAILED' },
        reportSummary: `Failed to create real GitHub Pull Request: ${err.message}. Operation aborted; Flywheel not modified.`,
      };
    }

    // Record success ONLY when PR submission succeeds
    this.memory.recordSuccess(selectedOpp.repoFullName, {
      title: selectedOpp.title,
      issueNumber: selectedOpp.issueNumber,
      prNumber,
      prUrl,
    });

    this.flywheel.saveRecord({
      id: `${selectedOpp.repoFullName}#${prNumber}`,
      repoFullName: selectedOpp.repoFullName,
      issueNumber: selectedOpp.issueNumber,
      issueTitle: selectedOpp.title,
      prNumber,
      prUrl,
      status: 'submitted',
      submittedAt: new Date().toISOString(),
      diffStat: `~${patchDraft.estimatedDiffLines} lines`,
      evidenceSummary: `Verified across ${implementationAttempts} attempt(s) with ${qualityRubric.overallScore}% quality score (${validationStatus})`,
    });

    // Cleanup workspace if configured
    if (policy.autoPurgeSandboxOnFinish) {
      this.worktreeManager.cleanupWorkspace(workspace.workspacePath);
    }

    this.stateMachine.transition('COMPLETED', 'PR submitted and flywheel synced');

    return {
      status: 'COMPLETED',
      stage: 'COMPLETED',
      selectedOpportunity: selectedOpp,
      workspacePath: workspace.workspacePath,
      patchDraft,
      appliedFiles,
      implementationAttempts,
      validationStatus,
      confidenceScore: qualityRubric.overallScore,
      subagentReview,
      riskAssessment,
      telemetry,
      prUrl,
      prNumber,
      reportSummary: `Successfully executed autonomous contribution loop for #${selectedOpp.issueNumber}. PR opened: ${prUrl}`,
    };
  }
}
