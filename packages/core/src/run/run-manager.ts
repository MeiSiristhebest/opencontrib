import { existsSync, readdirSync } from 'fs';
import { homedir as osHomedir } from 'os';
import { join } from 'path';
import { ArtifactBundleManager } from './artifact-bundle.js';


import type {
  ArtifactType,
  ContributionRunManifest,
  ContributionRunPhase,
  ContributionRunSummary,
  CreateRunInput,
  SavedArtifactResult,
} from './types.js';
import { SystemClock, type Clock } from '../ports/clock.port.js';
import { RandomIdGenerator, type IdGenerator } from '../ports/id-generator.port.js';
import { ActiveSessionManager, defaultActiveSessionManager } from './active-session.js';

/** Phase → next suggested CLI/MCP action. Replaces the 10-branch switch (OCP). */
const PHASE_TRANSITIONS: Record<ContributionRunPhase, string> = {
  INITIALIZED: 'scout_opportunity',
  OPPORTUNITY_SCOUTED: 'assemble_context',
  PROBE_COMPLETED: 'assemble_context',
  CONTEXT_ASSEMBLED: 'prepare_workspace',
  WORKSPACE_PREPARED: 'draft_patch',
  POC_GENERATED: 'draft_patch',
  PATCH_DRAFTED: 'collect_evidence',
  EVIDENCE_COLLECTED: 'audit_governance',
  GOVERNANCE_AUDITED: 'render_pr_and_submit',
  PR_SUBMITTED: 'sync_flywheel',
  COMPLETED: 'none (run completed)',
  FAILED: 'inspect_failure_and_replan',
};

export type { CreateRunInput };

export interface ResumeRunResult {
  runId: string;
  currentPhase: ContributionRunPhase;
  manifest: ContributionRunManifest;
  availableArtifacts: ArtifactType[];
  latestArtifactSummary: {
    hasOpportunity: boolean;
    hasContext: boolean;
    hasWorkspace: boolean;
    hasPatch: boolean;
    hasEvidence: boolean;
    hasGovernance: boolean;
    hasPrDraft: boolean;
    hasResult: boolean;
  };
  suggestedNextAction: string;
}

import { getOpenContribHome } from '../kernel/home.js';

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
    this.baseDir = deps.baseDir || join(getOpenContribHome(), '.opencontrib', 'runs');
    this.bundleManager = new ArtifactBundleManager(this.baseDir);
    this.clock = deps.clock ?? new SystemClock();
    this.idGenerator = deps.idGenerator ?? new RandomIdGenerator();
    this.activeSession = deps.activeSession ?? defaultActiveSessionManager;
  }

  resolveRunId(runId?: string): string | undefined {
    if (runId) return runId;
    return this.activeSession.getActiveRunId() || undefined;
  }

  generateRunId(repoFullName: string, issueNumber?: number): string {
    const timestamp = this.clock.nowIso().replace(/[-:T]/g, '').slice(0, 14);
    const cleanRepo = repoFullName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const issueSuffix = issueNumber ? `_issue_${issueNumber}` : '';
    const randomSuffix = this.idGenerator.generate();
    return `run_${timestamp}_${cleanRepo}${issueSuffix}_${randomSuffix}`;
  }

  createRun(input: CreateRunInput): ContributionRunManifest {
    const runId = this.generateRunId(input.repoFullName, input.issueNumber);
    const now = this.clock.nowIso();

    const manifest: ContributionRunManifest = {
      schemaVersion: '1.0.0',
      runId,
      repoFullName: input.repoFullName,
      issueNumber: input.issueNumber,
      issueTitle: input.issueTitle,
      currentPhase: 'INITIALIZED',
      createdAt: now,
      updatedAt: now,
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
    };

    this.bundleManager.saveManifest(manifest);
    this.bundleManager.appendEvent(runId, {
      phase: 'INITIALIZED',
      eventType: 'RUN_CREATED',
      payload: { repoFullName: input.repoFullName, issueNumber: input.issueNumber, issueTitle: input.issueTitle },
    });

    defaultActiveSessionManager.setActiveSession({
      runId,
      repoFullName: input.repoFullName,
      issueNumber: input.issueNumber,
      issueTitle: input.issueTitle,
      currentPhase: 'INITIALIZED',
    });

    return manifest;
  }

  updateRunPhase(runId: string, newPhase: ContributionRunPhase): ContributionRunManifest {
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
      eventType: 'PHASE_TRANSITION',
      payload: { fromPhase: previousPhase, toPhase: newPhase },
    });

    defaultActiveSessionManager.updatePhase(newPhase);

    return manifest;
  }

  saveArtifact(
    runId: string,
    type: ArtifactType,
    content: string | Record<string, unknown>,
    autoAdvancePhase?: ContributionRunPhase,
  ): SavedArtifactResult {
    const manifest = this.bundleManager.readManifest(runId);
    if (!manifest) {
      throw new Error(`Contribution run ${runId} does not exist`);
    }

    const saved = this.bundleManager.saveArtifact(runId, type, content);

    this.bundleManager.appendEvent(runId, {
      phase: autoAdvancePhase || manifest.currentPhase,
      eventType: 'ARTIFACT_SAVED',
      payload: { artifactType: type, byteSize: saved.byteSize },
    });

    if (autoAdvancePhase && autoAdvancePhase !== manifest.currentPhase) {
      this.updateRunPhase(runId, autoAdvancePhase);
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

    return manifests.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  resumeRun(runId: string): ResumeRunResult {
    const summary = this.bundleManager.getRunSummary(runId);
    if (!summary) {
      throw new Error(`Cannot resume: contribution run ${runId} not found`);
    }

    const artifacts = summary.artifacts;
    const availableArtifacts: ArtifactType[] = [];
    if (artifacts.opportunity) availableArtifacts.push('opportunity');
    if (artifacts.context) availableArtifacts.push('context');
    if (artifacts.workspace) availableArtifacts.push('workspace');
    if (artifacts.patch) availableArtifacts.push('patch');
    if (artifacts.evidence) availableArtifacts.push('evidence');
    if (artifacts.governance) availableArtifacts.push('governance');
    if (artifacts.prDraft) availableArtifacts.push('pr_draft');
    if (artifacts.result) availableArtifacts.push('result');

    const latestSummary = {
      hasOpportunity: !!artifacts.opportunity,
      hasContext: !!artifacts.context,
      hasWorkspace: !!artifacts.workspace,
      hasPatch: !!artifacts.patch,
      hasEvidence: !!artifacts.evidence,
      hasGovernance: !!artifacts.governance,
      hasPrDraft: !!artifacts.prDraft,
      hasResult: !!artifacts.result,
    };

    const suggestedNextAction = PHASE_TRANSITIONS[summary.manifest.currentPhase];

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
