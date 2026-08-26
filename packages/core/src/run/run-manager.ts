import { existsSync, readdirSync } from 'fs';
import { homedir as osHomedir } from 'os';
import { join } from 'path';
import { ArtifactBundleManager } from './artifact-bundle.js';

function getOpenContribHome(): string {
  return process.env.OPENCONTRIB_HOME || osHomedir();
}

import type {
  ArtifactType,
  ContributionRunManifest,
  ContributionRunPhase,
  ContributionRunSummary,
  SavedArtifactResult,
} from './types.js';

export interface CreateRunInput {
  repoFullName: string;
  issueNumber?: number;
  issueTitle?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

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

import { defaultActiveSessionManager } from './active-session.js';

export class ContributionRunManager {
  private bundleManager: ArtifactBundleManager;
  private baseDir: string;

  constructor(customBaseDir?: string) {
    this.baseDir = customBaseDir || join(getOpenContribHome(), '.opencontrib', 'runs');
    this.bundleManager = new ArtifactBundleManager(this.baseDir);
  }

  resolveRunId(runId?: string): string | undefined {
    if (runId) return runId;
    return defaultActiveSessionManager.getActiveRunId() || undefined;
  }

  generateRunId(repoFullName: string, issueNumber?: number): string {
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const cleanRepo = repoFullName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const issueSuffix = issueNumber ? `_issue_${issueNumber}` : '';
    const randomSuffix = Math.random().toString(36).substring(2, 6);
    return `run_${timestamp}_${cleanRepo}${issueSuffix}_${randomSuffix}`;
  }

  createRun(input: CreateRunInput): ContributionRunManifest {
    const runId = this.generateRunId(input.repoFullName, input.issueNumber);
    const now = new Date().toISOString();

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
    manifest.updatedAt = new Date().toISOString();
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
      manifest.updatedAt = new Date().toISOString();
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

    let suggestedNextAction = 'scout_opportunity';
    switch (summary.manifest.currentPhase) {
      case 'INITIALIZED':
        suggestedNextAction = 'scout_opportunity';
        break;
      case 'OPPORTUNITY_SCOUTED':
        suggestedNextAction = 'assemble_context';
        break;
      case 'CONTEXT_ASSEMBLED':
        suggestedNextAction = 'prepare_workspace';
        break;
      case 'WORKSPACE_PREPARED':
        suggestedNextAction = 'draft_patch';
        break;
      case 'PATCH_DRAFTED':
        suggestedNextAction = 'collect_evidence';
        break;
      case 'EVIDENCE_COLLECTED':
        suggestedNextAction = 'audit_governance';
        break;
      case 'GOVERNANCE_AUDITED':
        suggestedNextAction = 'render_pr_and_submit';
        break;
      case 'PR_SUBMITTED':
        suggestedNextAction = 'sync_flywheel';
        break;
      case 'COMPLETED':
        suggestedNextAction = 'none (run completed)';
        break;
      case 'FAILED':
        suggestedNextAction = 'inspect_failure_and_replan';
        break;
    }

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
