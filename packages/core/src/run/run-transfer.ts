import { z } from "zod";
import { RedEvidenceSchema } from "../contracts/schemas.js";
import type {
  ContributionRunManifest,
  ContributionRunSummary,
} from "./types.js";
import type { ContributionRunManager } from "./run-manager.js";

/**
 * Data sent from an agent process to a trusted Run Host.
 *
 * This is intentionally a proposal, not a canonical artifact bundle. The host
 * never imports agent Evidence, Governance, Approval, or Submission artifacts.
 * It only uses the patch and RED recipe to reproduce the run in its own
 * workspace and then appends new canonical artifacts to its protected store.
 */
export const RunTransferBundleSchema = z.object({
  protocolVersion: z.literal("1.0"),
  manifest: z.object({
    schemaVersion: z.string(),
    runId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    repoFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    issueNumber: z.number().optional(),
    issueTitle: z.string().optional(),
    createdAt: z.string(),
    tags: z.array(z.string()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  patch: z.union([z.string(), z.record(z.string(), z.unknown())]),
  prDraft: z.string().min(1),
  redRecipe: z.object({
    command: z.string().min(1).max(8_000),
    expectedAssertion: z.string().min(1).max(2_000),
    testFiles: z.array(z.string()).min(1).max(500),
  }),
});

export type RunTransferBundle = z.infer<typeof RunTransferBundleSchema>;

/** Build the non-authoritative transfer envelope from an agent-local run. */
export function buildRunTransferBundle(
  runManager: ContributionRunManager,
  runId: string,
): RunTransferBundle {
  const run = runManager.getRun(runId);
  if (!run) throw new Error(`RunTransferError: run ${runId} does not exist.`);

  const patch = run.artifacts.patch;
  if (!patch || (typeof patch === "string" && patch.trim() === "")) {
    throw new Error("RunTransferError: patch artifact is required.");
  }
  if (
    typeof run.artifacts.prDraft !== "string" ||
    !run.artifacts.prDraft.trim()
  ) {
    throw new Error("RunTransferError: canonical PR draft is required.");
  }

  const redResult = RedEvidenceSchema.safeParse(run.artifacts.evidenceRed);
  if (!redResult.success) {
    throw new Error(
      "RunTransferError: canonical RED evidence is required before transfer.",
    );
  }
  const red = redResult.data;
  if (!red.expectedAssertion?.trim() || !red.testIdentity?.testFiles.length) {
    throw new Error(
      "RunTransferError: RED transfer requires an expected assertion and concrete test identity.",
    );
  }

  const bundle: RunTransferBundle = {
    protocolVersion: "1.0",
    manifest: {
      schemaVersion: run.manifest.schemaVersion,
      runId: run.manifest.runId,
      repoFullName: run.manifest.repoFullName,
      issueNumber: run.manifest.issueNumber,
      issueTitle: run.manifest.issueTitle,
      createdAt: run.manifest.createdAt,
      tags: run.manifest.tags,
      metadata: run.manifest.metadata,
    },
    patch,
    prDraft: run.artifacts.prDraft,
    redRecipe: {
      command: red.command,
      expectedAssertion: red.expectedAssertion,
      testFiles: red.testIdentity.testFiles.map((file) => file.path),
    },
  };
  return RunTransferBundleSchema.parse(bundle);
}

/** Metadata needed by the host before it allocates its own workspace. */
export type RunTransferManifest = RunTransferBundle["manifest"];

export function transferManifestToRunManifest(
  manifest: RunTransferManifest,
): ContributionRunManifest {
  return {
    ...manifest,
    currentPhase: "INITIALIZED",
    updatedAt: new Date().toISOString(),
  };
}

export function isTransferredRunSummary(
  value: ContributionRunSummary | null,
): value is ContributionRunSummary {
  return Boolean(value?.manifest.runId);
}
