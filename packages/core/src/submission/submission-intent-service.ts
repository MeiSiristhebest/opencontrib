import { createHash } from "node:crypto";
import type { ContributionRunManager } from "../run/run-manager.js";
import { saveCanonicalArtifact } from "../run/canonical-writer.js";
import { runBranchName } from "../run/run-branch.js";
import {
  GovernanceDecisionArtifactSchema,
  SubmissionIntentArtifactSchema,
  type SubmissionIntentArtifact,
  type SubmissionIntentFile,
} from "../contracts/schemas.js";

export interface CreateSubmissionIntentInput {
  runId: string;
  upstreamOwner: string;
  upstreamRepo: string;
  baseBranch?: string;
  branchName?: string;
  title?: string;
  body?: string;
  commitMessage?: string;
  isDraft?: boolean;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactHash(value: unknown): string {
  return sha256(typeof value === "string" ? value : JSON.stringify(value ?? ""));
}

export function isSafeRepositoryPath(path: string): boolean {
  if (!path || path.includes("\0") || path.includes("\\")) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function runOwnedBranch(runId: string): string {
  return `opencontrib/run-${runId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export class SubmissionIntentService {
  constructor(private readonly runManager: ContributionRunManager) {}

  /**
   * Create the immutable submission payload from run-owned artifacts. Every
   * caller-provided submission field is either compared with the stored
   * governance/draft values or bound into the intent that a trusted authority
   * must approve. No file content is accepted directly from the caller.
   */
  createIntent(input: CreateSubmissionIntentInput): SubmissionIntentArtifact {
    const run = this.runManager.getRun(input.runId);
    if (!run) {
      throw new Error(`Contribution run ${input.runId} does not exist`);
    }
    if (run.manifest.currentPhase !== "GOVERNANCE_AUDITED") {
      throw new Error(
        `Cannot create submission intent: run is in phase "${run.manifest.currentPhase}", expected "GOVERNANCE_AUDITED".`,
      );
    }

    const existingRaw = run.artifacts.submissionIntent;
    if (existingRaw) {
      const existing = SubmissionIntentArtifactSchema.safeParse(existingRaw);
      if (!existing.success) {
        throw new Error(
          `SubmissionIntentIntegrityError: existing intent for run ${input.runId} is invalid and cannot be replaced.`,
        );
      }
      if (
        input.upstreamOwner.toLowerCase() !== existing.data.upstreamOwner.toLowerCase() ||
        input.upstreamRepo.toLowerCase() !== existing.data.upstreamRepo.toLowerCase() ||
        (input.baseBranch && input.baseBranch !== existing.data.baseBranch) ||
        (input.branchName && input.branchName !== existing.data.branchName) ||
        (input.title && input.title !== existing.data.title) ||
        (input.body !== undefined && input.body !== existing.data.body) ||
        (input.commitMessage && input.commitMessage !== existing.data.commitMessage) ||
        (input.isDraft !== undefined && input.isDraft !== existing.data.isDraft)
      ) {
        throw new Error(
          "SubmissionIntentImmutableError: a run already has an immutable intent; requested submission parameters differ.",
        );
      }
      return existing.data;
    }

    const expectedRepo = run.manifest.repoFullName.toLowerCase();
    if (`${input.upstreamOwner}/${input.upstreamRepo}`.toLowerCase() !== expectedRepo) {
      throw new Error(
        `SubmissionTargetMismatchError: target ${input.upstreamOwner}/${input.upstreamRepo} does not match run repository ${run.manifest.repoFullName}.`,
      );
    }

    const patchRaw = run.artifacts.patch;
    if (!patchRaw || (typeof patchRaw === "string" && patchRaw.trim() === "")) {
      throw new Error(
        `Cannot create submission intent: missing required patch artifact for run ${input.runId}.`,
      );
    }
    const evidenceArtifact = run.artifacts.evidence;
    if (!evidenceArtifact) {
      throw new Error(
        `Cannot create submission intent: missing required evidence artifact for run ${input.runId}.`,
      );
    }
    const governanceRaw = run.artifacts.governance;
    const governanceResult = GovernanceDecisionArtifactSchema.safeParse(governanceRaw);
    if (!governanceResult.success || !governanceResult.data.passed) {
      throw new Error(
        `Cannot create submission intent: run ${input.runId} has no passing canonical governance decision.`,
      );
    }

    const patchContent = typeof patchRaw === "string" ? patchRaw : JSON.stringify(patchRaw);
    const patchSha256 = sha256(patchContent);
    const evidenceSha256 = artifactHash(evidenceArtifact);
    const governanceSha256 = artifactHash(governanceRaw);
    if (
      governanceResult.data.patchSha256 !== patchSha256 ||
      governanceResult.data.evidenceSha256 !== evidenceSha256
    ) {
      throw new Error(
        "SubmissionIntentProvenanceError: governance hashes do not match the current run artifacts.",
      );
    }

    const storedBody = run.artifacts.prDraft;
    if (typeof storedBody !== "string") {
      throw new Error(
        "Cannot create submission intent: the exact PR body must be stored as pr_draft and audited before approval.",
      );
    }
    if (input.body !== undefined && input.body !== storedBody) {
      throw new Error(
        "SubmissionIntentProvenanceError: requested PR body differs from the audited pr_draft artifact.",
      );
    }
    const body = storedBody;

    const title = governanceResult.data.prTitle;
    if (input.title !== undefined && input.title !== title) {
      throw new Error(
        "SubmissionIntentProvenanceError: requested PR title differs from the audited governance title.",
      );
    }

    const branchName = runBranchName(input.runId);
    if (input.branchName !== undefined && input.branchName !== branchName) {
      throw new Error(
        `SubmissionBranchMismatchError: branch must be the run-owned branch '${branchName}'.`,
      );
    }

    const wsArtifact = run.artifacts.workspace as Record<string, unknown> | undefined;
    const baseBranch =
      input.baseBranch ||
      (typeof wsArtifact?.baseBranch === "string" ? wsArtifact.baseBranch : undefined) ||
      "main";
    const commitMessage = input.commitMessage || title;
    const isDraft = input.isDraft ?? true;

    let parsedPatch: any;
    try {
      parsedPatch = typeof patchRaw === "string" ? JSON.parse(patchRaw) : patchRaw;
    } catch {
      throw new Error(
        "Cannot create submission intent: trusted patch must be a PatchDraft JSON object with concrete files.",
      );
    }
    if (!parsedPatch || !Array.isArray(parsedPatch.files)) {
      throw new Error(
        "Cannot create submission intent: trusted patch contains no concrete file list.",
      );
    }

    const seenPaths = new Set<string>();
    const files: SubmissionIntentFile[] = parsedPatch.files.map((file: any) => {
      const path = typeof file?.path === "string" ? file.path : "";
      if (!isSafeRepositoryPath(path)) {
        throw new Error(`SubmissionPathError: unsafe patch path '${path}'.`);
      }
      if (seenPaths.has(path)) {
        throw new Error(`SubmissionPathError: duplicate patch path '${path}'.`);
      }
      seenPaths.add(path);
      const operation = file.operation === "DELETE" || file.operation === "CREATE" || file.operation === "MODIFY"
        ? file.operation
        : "MODIFY";
      const content = operation === "DELETE" ? String(file.content ?? "") : String(file.content ?? "");
      const mode = file.mode === "100755" || file.mode === "120000" ? file.mode : "100644";
      return {
        path,
        content,
        mode,
        operation,
        contentSha256: sha256(content),
      };
    });

    if (files.length === 0) {
      throw new Error(
        `Trusted patch for run ${input.runId} contains zero files; cannot create a submission intent for an empty contribution.`,
      );
    }
    files.sort((a, b) => a.path.localeCompare(b.path));

    const bodySha256 = sha256(body);
    const intentPayload = JSON.stringify({
      runId: input.runId,
      upstreamOwner: input.upstreamOwner,
      upstreamRepo: input.upstreamRepo,
      baseBranch,
      branchName,
      title,
      bodySha256,
      commitMessage,
      isDraft,
      files: files.map((file) => ({
        operation: file.operation,
        path: file.path,
        mode: file.mode,
        contentSha256: file.contentSha256,
      })),
      patchSha256,
      evidenceSha256,
      governanceSha256,
    });

    const intent: SubmissionIntentArtifact = {
      runId: input.runId,
      upstreamOwner: input.upstreamOwner,
      upstreamRepo: input.upstreamRepo,
      baseBranch,
      branchName,
      title,
      body,
      bodySha256,
      commitMessage,
      isDraft,
      files,
      patchSha256,
      evidenceSha256,
      governanceSha256,
      intentSha256: sha256(intentPayload),
      createdAt: new Date().toISOString(),
    };

    SubmissionIntentArtifactSchema.parse(intent);
    saveCanonicalArtifact(this.runManager, input.runId, "submission_intent", intent as any);
    return intent;
  }
}
