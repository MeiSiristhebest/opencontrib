import type {
  ArtifactType,
  ContributionRunManifest,
  ContributionRunPhase,
  SavedArtifactResult,
} from "./types.js";
import type { ContributionRunManager } from "./run-manager.js";
import { validatePhaseGate } from "./state-machine.js";
import {
  PatchAttemptArtifactSchema,
  SecurityDisclosureEventArtifactSchema,
} from "../contracts/schemas.js";

/**
 * Private application-layer capability used by canonical artifact services.
 * This module is deliberately not re-exported from the core barrel: agent-facing
 * CLI/MCP code can only use the generic RunManager API, which refuses
 * authoritative artifact types.
 */
export interface CanonicalRunWriter {
  saveArtifact(
    runId: string,
    type: ArtifactType,
    content: string | Record<string, unknown>,
  ): SavedArtifactResult;
  transition(
    runId: string,
    targetPhase: ContributionRunPhase,
  ): ContributionRunManifest;
  markFailed(
    runId: string,
    reason: string,
    retryable?: boolean,
    providerSideEffectPossible?: boolean,
  ): ContributionRunManifest;
  /** Record a retry/reconciliation outcome without changing lifecycle phase. */
  recordFailure(
    runId: string,
    reason: string,
    retryable?: boolean,
    providerSideEffectPossible?: boolean,
  ): ContributionRunManifest;
  /** Host-only hydration used by TrustedRunMaterializer before re-verification. */
  hydrateRun(manifest: ContributionRunManifest): ContributionRunManifest;
}

const writers = new WeakMap<object, CanonicalRunWriter>();

export function registerCanonicalRunWriter(
  manager: ContributionRunManager,
  writer: CanonicalRunWriter,
): void {
  writers.set(manager, writer);
}

function getWriter(manager: ContributionRunManager): CanonicalRunWriter {
  const writer = writers.get(manager);
  if (!writer) {
    throw new Error(
      "CanonicalRunWriterUnavailableError: run manager is not wired through the composition root.",
    );
  }
  return writer;
}

export function saveCanonicalArtifact(
  manager: ContributionRunManager,
  runId: string,
  type: ArtifactType,
  content: string | Record<string, unknown>,
  trustedTargetPhase?: ContributionRunPhase,
): SavedArtifactResult {
  const authoritativeTypes = new Set<ArtifactType>([
    "workspace",
    "validated_patch",
    "patch_attempt",
    "evidence_red",
    "evidence",
    "issue_binding",
    "security_disclosure",
    "security_disclosure_event",
    "governance",
    "submission_intent",
    "approval",
    "submission",
    "result",
  ]);
  if (!authoritativeTypes.has(type)) {
    throw new Error(
      `CanonicalArtifactTypeError: '${type}' is not an authoritative artifact type.`,
    );
  }
  if (type === "patch_attempt") {
    const parsed = PatchAttemptArtifactSchema.safeParse(content);
    if (!parsed.success) {
      throw new Error(
        `PatchAttemptIntegrityError: invalid patch attempt artifact (${parsed.error.issues[0]?.message ?? "invalid schema"}).`,
      );
    }
    content = parsed.data;
  }
  if (type === "security_disclosure_event") {
    const parsed = SecurityDisclosureEventArtifactSchema.safeParse(content);
    if (!parsed.success) {
      throw new Error(
        `SecurityDisclosureEventIntegrityError: invalid disclosure lifecycle event (${parsed.error.issues[0]?.message ?? "invalid schema"}).`,
      );
    }
    content = parsed.data;
  }
  const writer = getWriter(manager);
  const current = manager.getRun(runId);
  if (!current) {
    throw new Error(`Contribution run ${runId} does not exist`);
  }

  // Canonical services may request the lifecycle notification associated with
  // the artifact they just produced, but the writer capability itself never
  // accepts a caller-selected phase. Validate the prospective artifact before
  // writing so an invalid transition cannot leave a privileged artifact behind.
  if (
    trustedTargetPhase &&
    trustedTargetPhase !== current.manifest.currentPhase
  ) {
    const artifactKey =
      type === "pr_draft"
        ? "prDraft"
        : type === "evidence_red"
          ? "evidenceRed"
          : type === "validated_patch"
            ? "validatedPatch"
            : type === "submission_intent"
              ? "submissionIntent"
              : type;
    const prospective = {
      ...current,
      artifacts: {
        ...current.artifacts,
        [artifactKey]: content,
      },
    };
    const gateResult = validatePhaseGate(prospective, trustedTargetPhase);
    if (!gateResult.ok && gateResult.error) {
      throw gateResult.error;
    }
  }

  const saved = writer.saveArtifact(runId, type, content);
  if (
    trustedTargetPhase &&
    trustedTargetPhase !== current.manifest.currentPhase
  ) {
    writer.transition(runId, trustedTargetPhase);
  }
  return saved;
}

export function transitionCanonicalRun(
  manager: ContributionRunManager,
  runId: string,
  targetPhase: ContributionRunPhase,
): ContributionRunManifest {
  return getWriter(manager).transition(runId, targetPhase);
}

/**
 * Internal trusted-host entry point. Agent-facing adapters must not call this;
 * the host hydrates only run metadata and then regenerates all authoritative
 * artifacts from the transferred patch/RED recipe.
 */
export function markCanonicalRunFailed(
  manager: ContributionRunManager,
  runId: string,
  reason: string,
  retryable = true,
  providerSideEffectPossible = false,
): ContributionRunManifest {
  return getWriter(manager).markFailed(
    runId,
    reason,
    retryable,
    providerSideEffectPossible,
  );
}

/**
 * Record a retryable provider failure while preserving the approved lifecycle
 * phase. This is not a rollback: the next attempt must still pass all current
 * authorization and provenance checks.
 */
export function recordCanonicalRunFailure(
  manager: ContributionRunManager,
  runId: string,
  reason: string,
  retryable = true,
  providerSideEffectPossible = true,
): ContributionRunManifest {
  return getWriter(manager).recordFailure(
    runId,
    reason,
    retryable,
    providerSideEffectPossible,
  );
}

export function hydrateCanonicalRun(
  manager: ContributionRunManager,
  manifest: ContributionRunManifest,
): ContributionRunManifest {
  return getWriter(manager).hydrateRun(manifest);
}
