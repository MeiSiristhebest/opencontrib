import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { ArtifactBundleManager } from "./artifact-bundle.js";

import type {
  ArtifactType,
  ContributionRunManifest,
  ContributionRunPhase,
  ContributionRunSummary,
  CreateRunInput,
  SavedArtifactResult,
} from "./types.js";
import { SystemClock, type Clock } from "../ports/clock.port.js";
import {
  RandomIdGenerator,
  type IdGenerator,
} from "../ports/id-generator.port.js";
import { ActiveSessionManager } from "./active-session.js";

import {
  getProtocolGuidance,
  PROTOCOL_CONTRACT_PHASES,
  type ProtocolGuidance,
} from "../workflow/protocol-contract.js";

export type { CreateRunInput };

export interface ResumeRunResult {
  runId: string;
  currentPhase: ContributionRunPhase;
  manifest: ContributionRunManifest;
  availableArtifacts: ArtifactType[];
  latestArtifactSummary: {
    hasOpportunity: boolean;
    hasProbe: boolean;
    hasContext: boolean;
    hasWorkspace: boolean;
    hasPoc: boolean;
    hasPatch: boolean;
    hasEvidence: boolean;
    hasGovernance: boolean;
    hasPrDraft: boolean;
    hasResult: boolean;
  };
  suggestedNextAction: string;
  guidance: ProtocolGuidance;
}

import { PHASE_REQUIREMENTS, validatePhaseGate } from "./state-machine.js";
import { getOpenContribDataDir } from "../kernel/home.js";
import { registerCanonicalRunWriter } from "./canonical-writer.js";

export const PRIVILEGED_PHASES = new Set<ContributionRunPhase>([
  "EVIDENCE_COLLECTED",
  "GOVERNANCE_AUDITED",
  "PR_SUBMITTED",
  "COMPLETED",
]);

/** Server-derived mapping: each draft artifact kind has one lifecycle phase. */
export const DRAFT_PHASE_BY_ARTIFACT: Partial<
  Record<ArtifactType, ContributionRunPhase>
> = {
  opportunity: "OPPORTUNITY_SCOUTED",
  probe: "PROBE_COMPLETED",
  context: "CONTEXT_ASSEMBLED",
  poc: "POC_GENERATED",
  patch: "PATCH_DRAFTED",
};

/**
 * Authoritative artifacts that CANNOT be created or overwritten via generic saveArtifact.
 * They must only be written through trusted internal services (e.g. EvidenceService,
 * GovernanceService, ApprovalService, SubmissionService).
 */
export const AUTHORITATIVE_ARTIFACT_TYPES = new Set<ArtifactType>([
  "workspace",
  "validated_patch",
  "patch_attempt",
  "evidence_red",
  "evidence",
  "issue_binding",
  "security_disclosure",
  "governance",
  "submission_intent",
  "approval",
  "submission",
  "result",
]);

export class ContributionRunManager {
  private bundleManager: ArtifactBundleManager;
  private baseDir: string;
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly activeSession: ActiveSessionManager;

  constructor(
    deps: {
      baseDir?: string;
      clock?: Clock;
      idGenerator?: IdGenerator;
      activeSession?: ActiveSessionManager;
    } = {},
  ) {
    this.baseDir = deps.baseDir || join(getOpenContribDataDir(), "runs");
    this.bundleManager = new ArtifactBundleManager(this.baseDir);
    this.clock = deps.clock ?? new SystemClock();
    this.idGenerator = deps.idGenerator ?? new RandomIdGenerator();
    // Resolve the active-session path when this manager is constructed rather
    // than capturing the module-level singleton.  This keeps a CLI `--home`
    // selection authoritative for every lazily-created manager.
    this.activeSession = deps.activeSession ?? new ActiveSessionManager();

    // Register the service-only capability after construction. The capability
    // is held in a private WeakMap and is not exposed through the public core
    // barrel; canonical services use it to persist authoritative artifacts.
    registerCanonicalRunWriter(this, {
      saveArtifact: (runId, type, content) =>
        this._saveArtifactInternal(runId, type, content),
      transition: (runId, targetPhase) => this._transition(runId, targetPhase),
      markFailed: (runId, reason, retryable, providerSideEffectPossible) =>
        this._markFailedInternal(
          runId,
          reason,
          retryable,
          providerSideEffectPossible,
        ),
      recordFailure: (runId, reason, retryable, providerSideEffectPossible) =>
        this._recordFailureInternal(
          runId,
          reason,
          retryable,
          providerSideEffectPossible,
        ),
      hydrateRun: (manifest) => this._hydrateRunInternal(manifest),
    });
  }

  resolveRunId(runId?: string): string | undefined {
    if (runId) return runId;
    return this.activeSession.getActiveRunId() || undefined;
  }

  generateRunId(repoFullName: string, issueNumber?: number): string {
    const timestamp = this.clock.nowIso().replace(/[-:T]/g, "").slice(0, 14);
    const cleanRepo = repoFullName.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
    const issueSuffix = issueNumber ? `_issue_${issueNumber}` : "";
    const randomSuffix = this.idGenerator.generate();
    return `run_${timestamp}_${cleanRepo}${issueSuffix}_${randomSuffix}`;
  }

  createRun(input: CreateRunInput): ContributionRunManifest {
    const runId = this.generateRunId(input.repoFullName, input.issueNumber);
    const now = this.clock.nowIso();

    const manifest: ContributionRunManifest = {
      schemaVersion: "1.0.0",
      runId,
      repoFullName: input.repoFullName,
      issueNumber: input.issueNumber,
      issueTitle: input.issueTitle,
      currentPhase: "INITIALIZED",
      createdAt: now,
      updatedAt: now,
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
    };

    this.bundleManager.saveManifest(manifest);
    this.bundleManager.appendEvent(runId, {
      phase: "INITIALIZED",
      eventType: "RUN_CREATED",
      payload: {
        repoFullName: input.repoFullName,
        issueNumber: input.issueNumber,
        issueTitle: input.issueTitle,
      },
    });

    this.activeSession.activateSession({
      runId,
      repoFullName: input.repoFullName,
      issueNumber: input.issueNumber,
      issueTitle: input.issueTitle,
      currentPhase: "INITIALIZED",
    });

    return manifest;
  }

  /** Trusted internal phase transition; not exposed through the public run API. */
  private _transition(
    runId: string,
    targetPhase: ContributionRunPhase,
  ): ContributionRunManifest {
    const summary = this.getRun(runId);
    if (!summary) {
      throw new Error(`Contribution run ${runId} does not exist`);
    }

    const gateResult = validatePhaseGate(summary, targetPhase);
    if (!gateResult.ok && gateResult.error) {
      throw gateResult.error;
    }

    // Re-applying the current phase is an idempotent notification, not a
    // lifecycle event. Do not rewrite timestamps, append a transition event,
    // or give callers a way to manufacture progress by repeating a phase.
    if (summary.manifest.currentPhase === targetPhase) {
      return summary.manifest;
    }

    return this._updateRunPhase(runId, targetPhase);
  }

  /**
   * Internal phase persistence. All callers reach this through transition(),
   * which validates the phase gate before this method is invoked.
   */
  private _updateRunPhase(
    runId: string,
    newPhase: ContributionRunPhase,
  ): ContributionRunManifest {
    const manifest = this.bundleManager.readManifest(runId);
    if (!manifest) {
      throw new Error(`Contribution run ${runId} does not exist`);
    }

    const previousPhase = manifest.currentPhase;
    manifest.currentPhase = newPhase;
    manifest.updatedAt = this.clock.nowIso();
    this.bundleManager.saveManifest(manifest);

    this.bundleManager.appendEvent(runId, {
      phase: newPhase,
      eventType: "PHASE_TRANSITION",
      payload: { fromPhase: previousPhase, toPhase: newPhase },
    });

    this.activeSession.updatePhase(newPhase, runId);

    return manifest;
  }

  saveArtifact(
    runId: string,
    type: ArtifactType,
    content: string | Record<string, unknown>,
  ): SavedArtifactResult {
    if (AUTHORITATIVE_ARTIFACT_TYPES.has(type)) {
      throw new Error(
        `AuthoritativeArtifactViolationError: Artifact type '${type}' is authoritative and cannot be written via generic save. Use canonical service.`,
      );
    }

    const expectedPhase = DRAFT_PHASE_BY_ARTIFACT[type];
    const summary = this.getRun(runId);
    if (!summary) {
      throw new Error(`Contribution run ${runId} does not exist`);
    }

    // pr_draft must only be saved after a patch exists and governance has audited.
    // Reject early-phase saves to prevent INITIALIZED runs from accumulating drafts.
    if (type === "pr_draft") {
      const earlyPhases = new Set<ContributionRunPhase>([
        "INITIALIZED",
        "OPPORTUNITY_SCOUTED",
        "PROBE_COMPLETED",
        "CONTEXT_ASSEMBLED",
        "WORKSPACE_PREPARED",
      ]);
      if (earlyPhases.has(summary.manifest.currentPhase)) {
        throw new Error(
          `ArtifactPhaseViolationError: pr_draft cannot be saved in phase '${summary.manifest.currentPhase}'. A pr_draft requires a validated patch and governance audit. Use the canonical pipeline to produce pr_draft artifacts.`,
        );
      }
      // Once governance or submission has bound the exact PR body, the draft is
      // no longer mutable. Re-rendering it would invalidate the audited hash and
      // must fail before touching the WORM run bundle.
      if (
        new Set<ContributionRunPhase>([
          "GOVERNANCE_AUDITED",
          "PR_SUBMITTED",
          "COMPLETED",
          "FAILED",
        ]).has(summary.manifest.currentPhase)
      ) {
        throw new Error(
          `ImmutableArtifactViolationError: pr_draft is immutable after governance binding in phase '${summary.manifest.currentPhase}'.`,
        );
      }
    }

    // A phase-bound draft cannot be written from an unrelated or later phase.
    // Validate the prospective transition before persisting so a caller cannot
    // smuggle a patch into a run while silently leaving lifecycle state behind.
    if (
      expectedPhase &&
      summary.manifest.currentPhase !== expectedPhase &&
      !PHASE_REQUIREMENTS[expectedPhase].fromPhases.includes(
        summary.manifest.currentPhase,
      )
    ) {
      const prospective = {
        ...summary,
        artifacts: {
          ...summary.artifacts,
          [type]: content,
        },
      };
      const gateResult = validatePhaseGate(prospective, expectedPhase);
      if (!gateResult.ok && gateResult.error) {
        throw gateResult.error;
      }
    }

    // The artifact kind, not the caller, selects a phase.  Only advance when
    // the canonical contract says that this draft phase is the next legal
    // transition.  PR drafts have no lifecycle phase of their own and remain
    // ordinary draft artifacts after EVIDENCE_COLLECTED.
    const derivedPhase =
      expectedPhase &&
      summary.manifest.currentPhase !== expectedPhase &&
      PHASE_REQUIREMENTS[expectedPhase].fromPhases.includes(
        summary.manifest.currentPhase,
      )
        ? expectedPhase
        : undefined;

    const saved = this._saveArtifactInternal(runId, type, content);
    if (derivedPhase) {
      this._transition(runId, derivedPhase);
    }
    return saved;
  }

  private _saveArtifactInternal(
    runId: string,
    type: ArtifactType,
    content: string | Record<string, unknown>,
  ): SavedArtifactResult {
    const manifest = this.bundleManager.readManifest(runId);
    if (!manifest) {
      throw new Error(`Contribution run ${runId} does not exist`);
    }

    const saved = this.bundleManager.saveArtifact(runId, type, content);

    this.bundleManager.appendEvent(runId, {
      phase: manifest.currentPhase,
      eventType: "ARTIFACT_SAVED",
      payload: { artifactType: type, byteSize: saved.byteSize },
    });

    manifest.updatedAt = this.clock.nowIso();
    this.bundleManager.saveManifest(manifest);

    return saved;
  }

  /** Record a trusted failure without allowing a lifecycle rollback. */
  private _markFailedInternal(
    runId: string,
    reason: string,
    retryable = true,
    providerSideEffectPossible = false,
  ): ContributionRunManifest {
    const summary = this.getRun(runId);
    if (!summary) throw new Error(`Contribution run ${runId} does not exist`);
    if (summary.manifest.currentPhase !== "FAILED") {
      this._transition(runId, "FAILED");
    }
    return this._recordFailureInternal(
      runId,
      reason,
      retryable,
      providerSideEffectPossible,
      "RUN_FAILED",
    );
  }

  private _recordFailureInternal(
    runId: string,
    reason: string,
    retryable = true,
    providerSideEffectPossible = false,
    eventType: "RUN_FAILED" | "RUN_FAILURE_RECORDED" = "RUN_FAILURE_RECORDED",
  ): ContributionRunManifest {
    const manifest = this.bundleManager.readManifest(runId);
    if (!manifest) throw new Error(`Contribution run ${runId} does not exist`);
    const failedAt = this.clock.nowIso();
    manifest.metadata = {
      ...(manifest.metadata ?? {}),
      failure: {
        reason,
        retryable,
        providerSideEffectPossible,
        failedAt,
      },
    };
    manifest.updatedAt = failedAt;
    this.bundleManager.saveManifest(manifest);
    this.bundleManager.appendEvent(runId, {
      phase: manifest.currentPhase,
      eventType,
      payload: { reason, retryable, providerSideEffectPossible },
    });
    return manifest;
  }

  /**
   * Host-only run hydration. It copies metadata only; a trusted host must
   * regenerate workspace, RED/GREEN evidence, governance, intent, approval,
   * and submission artifacts before any provider side effect.
   */
  private _hydrateRunInternal(
    manifest: ContributionRunManifest,
  ): ContributionRunManifest {
    const existing = this.bundleManager.readManifest(manifest.runId);
    if (existing) {
      if (
        existing.repoFullName.toLowerCase() !==
          manifest.repoFullName.toLowerCase() ||
        existing.issueNumber !== manifest.issueNumber
      ) {
        throw new Error(
          `RunHydrationConflictError: run ${manifest.runId} is already bound to a different repository or issue.`,
        );
      }
      return existing;
    }
    const hydrated: ContributionRunManifest = {
      ...manifest,
      currentPhase: "INITIALIZED",
      updatedAt: this.clock.nowIso(),
    };
    this.bundleManager.saveManifest(hydrated);
    this.bundleManager.appendEvent(hydrated.runId, {
      phase: "INITIALIZED",
      eventType: "RUN_HYDRATED_BY_TRUSTED_HOST",
      payload: {
        source: "agent_transfer",
        repoFullName: hydrated.repoFullName,
      },
    });
    return hydrated;
  }

  getRun(runId: string): ContributionRunSummary | null {
    return this.bundleManager.getRunSummary(runId);
  }

  listRuns(): ContributionRunManifest[] {
    if (!existsSync(this.baseDir)) {
      return [];
    }

    const entries = readdirSync(this.baseDir, { withFileTypes: true });
    const manifests: ContributionRunManifest[] = [];

    for (const entry of entries) {
      if (entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name)) {
        const manifest = this.bundleManager.readManifest(entry.name);
        if (manifest) {
          manifests.push(manifest);
        }
      }
    }

    return manifests.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  resumeRun(runId: string): ResumeRunResult {
    const summary = this.bundleManager.getRunSummary(runId);
    if (!summary) {
      throw new Error(`Cannot resume: contribution run ${runId} not found`);
    }

    const artifacts = summary.artifacts;
    const availableArtifacts: ArtifactType[] = [];
    if (artifacts.opportunity) availableArtifacts.push("opportunity");
    if (artifacts.probe) availableArtifacts.push("probe");
    if (artifacts.context) availableArtifacts.push("context");
    if (artifacts.workspace) availableArtifacts.push("workspace");
    if (artifacts.poc) availableArtifacts.push("poc");
    if (artifacts.patch) availableArtifacts.push("patch");
    if (artifacts.validatedPatch) availableArtifacts.push("validated_patch");
    if (artifacts.evidenceRed) availableArtifacts.push("evidence_red");
    if (artifacts.evidence) availableArtifacts.push("evidence");
    if (artifacts.governance) availableArtifacts.push("governance");
    if (artifacts.submissionIntent)
      availableArtifacts.push("submission_intent");
    if (artifacts.approval) availableArtifacts.push("approval");
    if (artifacts.submission) availableArtifacts.push("submission");
    if (artifacts.prDraft) availableArtifacts.push("pr_draft");
    if (artifacts.result) availableArtifacts.push("result");
    if (artifacts.securityDisclosure) availableArtifacts.push("security_disclosure");

    const latestSummary = {
      hasOpportunity: !!artifacts.opportunity,
      hasProbe: !!artifacts.probe,
      hasContext: !!artifacts.context,
      hasWorkspace: !!artifacts.workspace,
      hasPoc: !!artifacts.poc,
      hasPatch: !!artifacts.patch,
      hasEvidence: !!artifacts.evidence,
      hasGovernance: !!artifacts.governance,
      hasPrDraft: !!artifacts.prDraft,
      hasResult: !!artifacts.result,
    };

    const protocolPhase =
      PROTOCOL_CONTRACT_PHASES[summary.manifest.currentPhase];
    const suggestedNextAction = protocolPhase?.suggestedNextAction || "none";
    const guidance: ProtocolGuidance = protocolPhase
      ? getProtocolGuidance(summary.manifest.currentPhase)
      : {
          suggestedNextAction,
          cliExample: "",
          mcpTool: "",
          forbiddenActions: [],
          invariants: [],
        };

    return {
      runId,
      currentPhase: summary.manifest.currentPhase,
      manifest: summary.manifest,
      availableArtifacts,
      latestArtifactSummary: latestSummary,
      suggestedNextAction,
      guidance,
    };
  }
}

export const defaultRunManager = new ContributionRunManager();
