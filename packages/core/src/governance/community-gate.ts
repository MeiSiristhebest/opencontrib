import { createHash } from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import {
  CommunityGatePolicySchema,
  CommunityGateSnapshotSchema,
  type CommunityGatePolicy,
  type CommunityGateSnapshot,
} from "../contracts/schemas.js";

export type { CommunityGatePolicy, CommunityGateSnapshot };

/** Contribution-policy files read from the verified repository baseline. */
export const COMMUNITY_GATE_POLICY_PATHS = [
  "CONTRIBUTING.md",
  "CONTRIBUTING",
  "contributing.md",
  ".github/CONTRIBUTING.md",
  ".github/contributing.md",
  "AGENTS.md",
  ".github/AGENTS.md",
  "SECURITY.md",
  ".github/SECURITY.md",
  ".github/ISSUE_TEMPLATE/bug.yml",
  ".github/ISSUE_TEMPLATE/bug.yaml",
  ".github/ISSUE_TEMPLATE/bug_report.md",
] as const;

export interface CommunityGateFileReader {
  listTree(policyPath: string): {
    success: boolean;
    stdout: string;
    stderr: string;
  };
  show(policyPath: string): {
    success: boolean;
    stdout: string;
    stderr: string;
  };
}

const ISSUE_APPROVAL_PATTERNS = [
  /auto-closed by default/i,
  /auto-close/i,
  /reopen worthwhile ones/i,
  /\blgtmi\b/i,
  /\blgtm\b.*issue/i,
  /approval happens through maintainer/i,
  /wait for (?:maintainer|author|triager) (?:approval|response|review|reopen)/i,
  /do not (?:open|submit|create) a pr until/i,
  /discuss in (?:an )?issue before (?:opening|submitting) (?:a )?pr/i,
  /must be approved before/i,
];

const AUTO_CLOSE_PATTERNS = [
  /auto-closed by default/i,
  /new issues.*auto-closed/i,
  /bot.*automatically close/i,
  /will be closed automatically/i,
];

const LGTM_PROTOCOL_PATTERNS = [
  /\blgtmi\b/i,
  /\blgtm\b.*approved/i,
  /approved-contributors/i,
];

const RESTRICTED_HOURS_PATTERNS = [
  /friday through sunday/i,
  /weekend.*not guaranteed/i,
  /working hours/i,
  /review queue.*monday/i,
];

function permissivePolicy(reason: string): CommunityGatePolicy {
  return {
    hasGatingRules: false,
    requiresIssueApprovalBeforePr: false,
    autoClosesNewIssues: false,
    hasLgtmApprovalProtocol: false,
    restrictedTriageHours: false,
    reasons: [reason],
    suggestedContributorAction:
      "Follow standard Issue-First workflow and create PR with linked issue.",
    matchedKeywords: [],
  };
}

/**
 * Detect community policy from already-read repository files.
 *
 * This pure entry point is used by workspace preparation so detection can be
 * pinned to a verified Git commit rather than the mutable worktree.
 */
export function detectCommunityGateFromContents(
  files: ReadonlyArray<{ path: string; content: string }>,
): CommunityGatePolicy {
  if (files.length === 0) {
    return permissivePolicy(
      "No CONTRIBUTING.md or community governance files detected.",
    );
  }

  const combinedContent = files
    .map(({ path: filePath, content }) => `\n--- ${filePath} ---\n${content}`)
    .join("");
  const reasons: string[] = [];
  const matchedKeywords: string[] = [];

  let requiresIssueApprovalBeforePr = false;
  let autoClosesNewIssues = false;
  let hasLgtmApprovalProtocol = false;
  let restrictedTriageHours = false;
  let maxDiffCeiling: number | undefined;

  for (const pattern of ISSUE_APPROVAL_PATTERNS) {
    const match = combinedContent.match(pattern);
    if (match) {
      requiresIssueApprovalBeforePr = true;
      matchedKeywords.push(match[0]);
    }
  }

  for (const pattern of AUTO_CLOSE_PATTERNS) {
    const match = combinedContent.match(pattern);
    if (match) {
      autoClosesNewIssues = true;
      matchedKeywords.push(match[0]);
    }
  }

  for (const pattern of LGTM_PROTOCOL_PATTERNS) {
    const match = combinedContent.match(pattern);
    if (match) {
      hasLgtmApprovalProtocol = true;
      matchedKeywords.push(match[0]);
    }
  }

  for (const pattern of RESTRICTED_HOURS_PATTERNS) {
    const match = combinedContent.match(pattern);
    if (match) {
      restrictedTriageHours = true;
      matchedKeywords.push(match[0]);
    }
  }

  const diffPatterns = [
    /(\d+)\s*(?:lines|loc)\s*(?:limit|ceiling|max)/i,
    /(?:max(?:imum)?|limit|ceiling|over|more than)\D{0,20}(\d+)\s*(?:lines|loc)/i,
  ];
  for (const pattern of diffPatterns) {
    const diffMatch = combinedContent.match(pattern);
    if (!diffMatch) continue;
    maxDiffCeiling = parseInt(diffMatch[1], 10);
    matchedKeywords.push(diffMatch[0]);
    break;
  }

  if (autoClosesNewIssues) {
    reasons.push(
      "Repository automatically closes new contributor issues until maintainer reviews daily triage.",
    );
  }
  if (hasLgtmApprovalProtocol) {
    reasons.push(
      "Repository uses an explicit lgtmi / lgtm contributor gating protocol.",
    );
  }
  if (requiresIssueApprovalBeforePr) {
    reasons.push(
      "Maintainer approval (reopen / lgtmi reply) is strictly required BEFORE creating a Pull Request.",
    );
  }
  if (restrictedTriageHours) {
    reasons.push(
      "Weekend or non-working-hour triage delays apply; issues may queue until regular working hours.",
    );
  }
  if (maxDiffCeiling !== undefined) {
    reasons.push(
      `Repository declares a maximum diff ceiling of ${maxDiffCeiling} lines.`,
    );
  }

  const hasGatingRules =
    requiresIssueApprovalBeforePr ||
    autoClosesNewIssues ||
    hasLgtmApprovalProtocol;

  let suggestedContributorAction =
    "Proceed with standard Issue creation and PR submission.";
  if (requiresIssueApprovalBeforePr || autoClosesNewIssues) {
    suggestedContributorAction =
      'Create GitHub Issue first. PAUSE pipeline and wait for maintainer to reopen or comment "lgtmi" before submitting PR.';
  }

  return CommunityGatePolicySchema.parse({
    hasGatingRules,
    requiresIssueApprovalBeforePr,
    autoClosesNewIssues,
    hasLgtmApprovalProtocol,
    restrictedTriageHours,
    maxDiffCeiling,
    reasons,
    suggestedContributorAction,
    matchedKeywords: Array.from(new Set(matchedKeywords)),
  });
}

/**
 * Scan a local repository for community policy.
 *
 * This compatibility entry point is diagnostic only. Canonical runs use
 * readCommunityGateAtCommit() below so mutable worktree files cannot change
 * the policy after workspace preparation.
 */
export async function detectCommunityGate(
  repoPath: string,
): Promise<CommunityGatePolicy> {
  const resolved = path.resolve(repoPath);
  const files: Array<{ path: string; content: string }> = [];

  for (const relPath of COMMUNITY_GATE_POLICY_PATHS) {
    const fullPath = path.join(resolved, relPath);
    try {
      files.push({ path: relPath, content: fs.readFileSync(fullPath, "utf8") });
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw new Error(
        `CommunityGateReadError: cannot read community policy file "${relPath}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return detectCommunityGateFromContents(files);
}

/** Read and pin community policy files from a verified Git commit. */
export function readCommunityGateAtCommit(
  reader: CommunityGateFileReader,
  sourceCommitSha: string,
  errorPrefix = "CommunityGateSnapshotError",
): CommunityGateSnapshot {
  const files: Array<{ path: string; content: string }> = [];

  for (const policyPath of COMMUNITY_GATE_POLICY_PATHS) {
    const listing = reader.listTree(policyPath);
    if (!listing.success) {
      throw new Error(
        `${errorPrefix}: cannot inspect baseline community policy path "${policyPath}" at base commit ${sourceCommitSha}: ${listing.stderr.trim() || "git ls-tree failed"}.`,
      );
    }
    const existsInBase = listing.stdout
      .split(/\r?\n/)
      .some((line) => line.trim() === policyPath);
    if (!existsInBase) continue;

    const result = reader.show(policyPath);
    if (!result.success) {
      throw new Error(
        `${errorPrefix}: cannot read baseline community policy path "${policyPath}" at base commit ${sourceCommitSha}: ${result.stderr.trim() || "git show failed"}.`,
      );
    }
    files.push({ path: policyPath, content: result.stdout });
  }

  const snapshot = {
    sourceCommitSha,
    policy: detectCommunityGateFromContents(files),
  };
  return CommunityGateSnapshotSchema.parse(snapshot);
}

/** Treat any detected maintainer protocol as approval-gated, even if a
 * malformed or stale producer forgot to set the aggregate flag. */
export function communityPolicyRequiresExplicitApproval(
  policy: CommunityGatePolicy,
): boolean {
  return Boolean(
    policy.hasGatingRules ||
    policy.requiresIssueApprovalBeforePr ||
    policy.autoClosesNewIssues ||
    policy.hasLgtmApprovalProtocol,
  );
}

export function hashCommunityGateSnapshot(
  snapshot: CommunityGateSnapshot,
): string {
  return createHash("sha256")
    .update(JSON.stringify(CommunityGateSnapshotSchema.parse(snapshot)))
    .digest("hex");
}

export function isCommunityGateSnapshot(
  value: unknown,
): value is CommunityGateSnapshot {
  return CommunityGateSnapshotSchema.safeParse(value).success;
}
