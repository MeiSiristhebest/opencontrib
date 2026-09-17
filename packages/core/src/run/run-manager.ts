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
import {
  ActiveSessionManager,
  defaultActiveSessionManager,
} from "./active-session.js";
// `defaultActiveSessionManager` is still re-exported below for backward-
// compatibility with callers that construct a manager without injecting an
// active session; it is only used as a *constructor default*, never bypassed
// at runtime (transition/updatePhase go through `this.activeSession`).

import { PROTOCOL_CONTRACT_PHASES } from "../workflow/protocol-contract.js";

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
}

import { validatePhaseGate } from "./state-machine.js";
import { getOpenContribHome } from "../kernel/home.js";
import { registerCanonicalRunWriter } from "./canonical-writer.js";

export const PRIVILEGED_PHASES = new Set<ContributionRunPhase>([
  "EVIDENCE_COLLECTED",
  "GOVERNANCE_AUDITED",
  "PR_SUBMITTED",
  "COMPLETED",
]);

/**
 * Authoritative artifacts that CANNOT be created or overwritten via generic saveArtifact.
 * They must only be written through trusted internal services (e.g. EvidenceService,
 * GovernanceService, ApprovalService, SubmissionService).
 */
export const AUTHORITATIVE_ARTIFACT_TYPES = new Set<ArtifactType>([
  "workspace",
  "evidence_red",
  "evidence",
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
    this.baseDir =
      deps.baseDir || join(getOpenContribHome(), ".opencontrib", "runs");
    this.bundleManager = new ArtifactBundleManager(this.baseDir);
    this.clock = deps.clock ?? new SystemClock();
    this.idGenerator = deps.idGenerator ?? new RandomIdGenerator();
    this.activeSession = deps.activeSession ?? defaultActiveSessionManager;

    // Register the service-only capability after construction. The capability
    // is held in a private WeakMap and is not exposed through the public core
    // barrel; canonical services use it to persist authoritative artifacts.
    registerCanonicalRunWriter(this, {
      saveArtifact: (runId, type, content, autoAdvancePhase) =>
        this._saveArtifactInternal(runId, type, content, autoAdvancePhase),
      transition: (runId, targetPhase) => this.transition(runId, targetPhase),
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

  /**
   * Public, gate-validated phase transition. This is the ONLY sanctioned path
   * for advancing a contribution run to a new phase from external callers
   * (CLI flywheel, autonomous pipeline, MCP tools, submission service).
   * It runs validatePhaseGate() before persisting, so it rejects invalid
   * jumps (e.g. PR_SUBMITTED without a governance artifact, or COMPLETED
   * without a verified submission). Callers that must move a run forward
   * use this method — there is no public raw phase-persistence primitive.
   */
  transition(
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
    autoAdvancePhase?: ContributionRunPhase,
  ): SavedArtifactResult {
    if (AUTHORITATIVE_ARTIFACT_TYPES.has(type)) {
      throw new Error(
        `AuthoritativeArtifactViolationError: Artifact type '${type}' is authoritative and cannot be written via generic save. Use canonical service.`,
      );
    }
    if (autoAdvancePhase && PRIVILEGED_PHASES.has(autoAdvancePhase)) {
      throw new Error(
        `PrivilegedPhaseViolationError: Phase '${autoAdvancePhase}' is privileged and cannot be advanced via generic save. Use canonical service.`,
      );
    }
    return this._saveArtifactInternal(runId, type, content, autoAdvancePhase);
  }

  private _saveArtifactInternal(
    runId: string,
    type: ArtifactType,
    content: string | Record<string, unknown>,
    autoAdvancePhase?: ContributionRunPhase,
  ): SavedArtifactResult {
    const manifest = this.bundleManager.readManifest(runId);
    if (!manifest) {
      throw new Error(`Contribution run ${runId} does not exist`);
    }

    // Prospective validation: if autoAdvancePhase is requested, pre-validate before writing artifact
    if (autoAdvancePhase && autoAdvancePhase !== manifest.currentPhase) {
      const prospectiveSummary = this.getRun(runId);
      if (prospectiveSummary) {
        // Construct prospective artifacts record
        const prospectiveArtifacts = {
          ...prospectiveSummary.artifacts,
          [type === "pr_draft" ? "prDraft" : type]: content,
        };
        const prospective = {
          ...prospectiveSummary,
          artifacts: prospectiveArtifacts,
        };
        const gateResult = validatePhaseGate(prospective, autoAdvancePhase);
        if (!gateResult.ok && gateResult.error) {
          throw gateResult.error;
        }
      }
    }

    const saved = this.bundleManager.saveArtifact(runId, type, content);

    this.bundleManager.appendEvent(runId, {
      phase: autoAdvancePhase || manifest.currentPhase,
      eventType: "ARTIFACT_SAVED",
      payload: { artifactType: type, byteSize: saved.byteSize },
    });

    if (autoAdvancePhase && autoAdvancePhase !== manifest.currentPhase) {
      this.transition(runId, autoAdvancePhase);
    } else {
      manifest.updatedAt = this.clock.nowIso();
      this.bundleManager.saveManifest(manifest);
    }

    return saved;
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
    if (artifacts.evidence) availableArtifacts.push("evidence");
    if (artifacts.governance) availableArtifacts.push("governance");
    if (artifacts.prDraft) availableArtifacts.push("pr_draft");
    if (artifacts.result) availableArtifacts.push("result");

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

    const suggestedNextAction =
      PROTOCOL_CONTRACT_PHASES[summary.manifest.currentPhase]?.suggestedNextAction ||
      "none";

    return {
      runId,
      currentPhase: summary.manifest.currentPhase,
      manifest: summary.manifest,
      availableArtifacts,
      latestArtifactSummary: latestSummary,
      suggestedNextAction,
    };
  }
}

export const defaultRunManager = new ContributionRunManager();
