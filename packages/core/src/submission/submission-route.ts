import { createHash } from "node:crypto";
import {
  CommunityGateSnapshotSchema,
  IssueBindingArtifactSchema,
  SecurityDisclosureArtifactSchema,
  SecurityDisclosureEventArtifactSchema,
  type IssueBindingArtifact,
  type SecurityDisclosureArtifact,
  type SecurityDisclosureEventArtifact,
  type SubmissionRoute,
} from "../contracts/schemas.js";
import type { ContributionRunSummary } from "../run/types.js";

export interface CanonicalSubmissionRoute {
  route: SubmissionRoute;
  policy: ReturnType<typeof CommunityGateSnapshotSchema.parse>["policy"];
  issueBinding?: IssueBindingArtifact;
  securityDisclosure?: SecurityDisclosureArtifact;
}

/** Hash the exact canonical JSON representation used for artifact bindings. */
export function hashSubmissionArtifact(value: unknown): string {
  const content = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Resolve the only submission route permitted by the pinned workspace policy.
 * Discovery metadata and manifest.issueNumber are intentionally not inputs.
 */
export function resolveCanonicalSubmissionRoute(
  run: ContributionRunSummary,
): CanonicalSubmissionRoute {
  const workspace = run.artifacts.workspace as
    | { communityGate?: unknown }
    | undefined;
  const gate = CommunityGateSnapshotSchema.safeParse(workspace?.communityGate);
  if (!gate.success) {
    throw new Error(
      "SubmissionRouteIntegrityError: canonical workspace is missing a valid community policy snapshot.",
    );
  }

  if (gate.data.policy.privateVulnerabilityDisclosure === true) {
    const disclosure = SecurityDisclosureArtifactSchema.safeParse(
      run.artifacts.securityDisclosure,
    );
    if (
      !disclosure.success ||
      disclosure.data.runId !== run.manifest.runId ||
      disclosure.data.repoFullName.toLowerCase() !==
        run.manifest.repoFullName.toLowerCase() ||
      disclosure.data.providerVerified !== true
    ) {
      throw new Error(
        "SecurityDisclosureRequiredError: the pinned private-vulnerability policy requires a provider-verified security disclosure artifact.",
      );
    }
    return {
      route: "PRIVATE_SECURITY",
      policy: gate.data.policy,
      securityDisclosure: disclosure.data,
    };
  }

  const binding = IssueBindingArtifactSchema.safeParse(
    run.artifacts.issueBinding,
  );
  if (
    !binding.success ||
    binding.data.runId !== run.manifest.runId ||
    binding.data.repoFullName.toLowerCase() !==
      run.manifest.repoFullName.toLowerCase() ||
    binding.data.providerVerified !== true ||
    binding.data.state !== "open"
  ) {
    throw new Error(
      "IssueBindingRequiredError: public submission requires a provider-verified open IssueBindingArtifact for the canonical run.",
    );
  }
  return {
    route: "PUBLIC_ISSUE",
    policy: gate.data.policy,
    issueBinding: binding.data,
  };
}

/**
 * Public security disclosure authorization is a lifecycle event, not a
 * mutable boolean on the initial SECURITY.md discovery artifact.
 */
export function hasPublicSecurityDisclosureAuthorization(
  run: ContributionRunSummary,
): boolean {
  const base = SecurityDisclosureArtifactSchema.safeParse(
    run.artifacts.securityDisclosure,
  );
  if (
    !base.success ||
    base.data.runId !== run.manifest.runId ||
    base.data.repoFullName.toLowerCase() !==
      run.manifest.repoFullName.toLowerCase() ||
    base.data.providerVerified !== true
  ) {
    return false;
  }
  const rawEvents = run.artifacts.securityDisclosureEvents ?? [];
  const events: SecurityDisclosureEventArtifact[] = [];
  for (const rawEvent of rawEvents) {
    const result = SecurityDisclosureEventArtifactSchema.safeParse(rawEvent);
    if (!result.success) return false;
    events.push(result.data);
  }
  const lifecycle = [
    "DISCLOSED",
    "ACKNOWLEDGED",
    "PUBLIC_FIX_AUTHORIZED",
  ] as const;
  if (
    events.length !== lifecycle.length ||
    new Set(events.map((event) => event.providerEventId)).size !== events.length ||
    events.some(
      (event, index) =>
        event.runId !== run.manifest.runId ||
        event.repoFullName.toLowerCase() !==
          run.manifest.repoFullName.toLowerCase() ||
        event.providerVerified !== true ||
        event.stage !== lifecycle[index],
    )
  ) {
    return false;
  }
  const latest = events[events.length - 1];
  if (!latest) return false;
  return (
    latest.stage === "PUBLIC_FIX_AUTHORIZED" &&
    latest.providerVerified === true &&
    latest.publicDisclosureAllowed === true &&
    latest.runId === run.manifest.runId &&
    latest.repoFullName.toLowerCase() === run.manifest.repoFullName.toLowerCase()
  );
}
