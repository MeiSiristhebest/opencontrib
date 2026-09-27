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
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".github/pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
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

export interface PolicyRule {
  /** Which policy flag this rule contributes to */
  target: keyof Pick<CommunityGatePolicy, 
    'requiresIssueApprovalBeforePr' | 'autoClosesNewIssues' | 'hasLgtmApprovalProtocol' | 
    'restrictedTriageHours' | 'privateVulnerabilityDisclosure' | 'requiresDco' | 'requiresAiDisclosure'>;
  /** Regex pattern to match against combined policy file content */
  pattern: RegExp;
  /** Human-readable description of what this rule detects */
  description: string;
  /** Whether to apply negation-aware matching (findRequiredPolicyMatch) */
  negationAware?: boolean;
}

/** Default built-in policy rules. External callers can extend this set. */
export const DEFAULT_POLICY_RULES: PolicyRule[] = [
  { target: 'requiresIssueApprovalBeforePr', pattern: /auto-closed by default/i, description: 'Auto-closed by default' },
  { target: 'requiresIssueApprovalBeforePr', pattern: /auto-close/i, description: 'Auto-close' },
  { target: 'requiresIssueApprovalBeforePr', pattern: /reopen worthwhile ones/i, description: 'Reopen worthwhile ones' },
  { target: 'requiresIssueApprovalBeforePr', pattern: /\blgtmi\b/i, description: 'LGTMI' },
  { target: 'requiresIssueApprovalBeforePr', pattern: /\blgtm\b.*issue/i, description: 'LGTM on issue' },
  { target: 'requiresIssueApprovalBeforePr', pattern: /approval happens through maintainer/i, description: 'Approval by maintainer' },
  { target: 'requiresIssueApprovalBeforePr', pattern: /wait for (?:maintainer|author|triager) (?:approval|response|review|reopen)/i, description: 'Wait for approval' },
  { target: 'requiresIssueApprovalBeforePr', pattern: /do not (?:open|submit|create) a pr until/i, description: 'Do not open PR until' },
  { target: 'requiresIssueApprovalBeforePr', pattern: /discuss in (?:an )?issue before (?:opening|submitting) (?:a )?pr/i, description: 'Discuss in issue before PR' },
  { target: 'requiresIssueApprovalBeforePr', pattern: /must be approved before/i, description: 'Must be approved before' },

  { target: 'autoClosesNewIssues', pattern: /auto-closed by default/i, description: 'Auto-closed by default' },
  { target: 'autoClosesNewIssues', pattern: /new issues.*auto-closed/i, description: 'New issues auto-closed' },
  { target: 'autoClosesNewIssues', pattern: /bot.*automatically close/i, description: 'Bot automatically closes' },
  { target: 'autoClosesNewIssues', pattern: /will be closed automatically/i, description: 'Will be closed automatically' },

  { target: 'privateVulnerabilityDisclosure', pattern: /do not open.*public.*issue/i, description: 'Do not open public issue' },
  { target: 'privateVulnerabilityDisclosure', pattern: /do not.*submit.*public.*issue/i, description: 'Do not submit public issue' },
  { target: 'privateVulnerabilityDisclosure', pattern: /do not.*create.*public.*issue/i, description: 'Do not create public issue' },
  { target: 'privateVulnerabilityDisclosure', pattern: /private.*vulnerability.*disclosure/i, description: 'Private vulnerability disclosure' },
  { target: 'privateVulnerabilityDisclosure', pattern: /report.*vulnerabilit.*privately/i, description: 'Report vulnerabilities privately' },
  { target: 'privateVulnerabilityDisclosure', pattern: /security.*report.*private/i, description: 'Security report private' },
  { target: 'privateVulnerabilityDisclosure', pattern: /contact.*security.*maintainer/i, description: 'Contact security maintainer' },
  { target: 'privateVulnerabilityDisclosure', pattern: /private.*security.*channel/i, description: 'Private security channel' },

  { target: 'hasLgtmApprovalProtocol', pattern: /\blgtmi\b/i, description: 'LGTMI' },
  { target: 'hasLgtmApprovalProtocol', pattern: /\blgtm\b.*approved/i, description: 'LGTM approved' },
  { target: 'hasLgtmApprovalProtocol', pattern: /approved-contributors/i, description: 'Approved contributors' },

  { target: 'restrictedTriageHours', pattern: /friday through sunday/i, description: 'Friday through Sunday' },
  { target: 'restrictedTriageHours', pattern: /weekend.*not guaranteed/i, description: 'Weekend not guaranteed' },
  { target: 'restrictedTriageHours', pattern: /working hours/i, description: 'Working hours' },
  { target: 'restrictedTriageHours', pattern: /review queue.*monday/i, description: 'Review queue Monday' },

  { target: 'requiresDco', pattern: /developer certificate of origin/i, description: 'Developer Certificate of Origin', negationAware: true },
  { target: 'requiresDco', pattern: /signed-off-by/i, description: 'Signed-off-by', negationAware: true },
  { target: 'requiresDco', pattern: /sign[- ]off (?:your )?commits/i, description: 'Sign-off commits', negationAware: true },
  { target: 'requiresDco', pattern: /dco (?:required|sign[- ]off)/i, description: 'DCO required', negationAware: true },
  { target: 'requiresDco', pattern: /commits?\s+(?:must|shall)\s+be\s+sign(?:ed)?[- ]off/i, description: 'Commits must be signed off', negationAware: true },

  { target: 'requiresAiDisclosure', pattern: /(?:ai|automated|copilot)[ -]?(?:assisted|generated) disclosure/i, description: 'AI disclosure', negationAware: true },
  { target: 'requiresAiDisclosure', pattern: /disclose (?:the use of )?(?:ai|automated|copilot)/i, description: 'Disclose use of AI', negationAware: true },
  { target: 'requiresAiDisclosure', pattern: /ai disclosure is required/i, description: 'AI disclosure required', negationAware: true },
  { target: 'requiresAiDisclosure', pattern: /generated with (?:ai|copilot)/i, description: 'Generated with AI', negationAware: true },
  { target: 'requiresAiDisclosure', pattern: /(?:ai|artificial intelligence|copilot)[^.!?\n;]{0,50}\b(?:must|shall|has to|needs? to)\b[^.!?\n;]{0,40}\bdisclos(?:e|ed|ure)\b/i, description: 'AI must disclose', negationAware: true },
  { target: 'requiresAiDisclosure', pattern: /\b(?:must|shall|has to|needs? to)\b[^.!?\n;]{0,50}\bdisclos(?:e|ed|ure)\b[^.!?\n;]{0,50}(?:ai|artificial intelligence|copilot|llm|model)/i, description: 'Must disclose AI', negationAware: true },
  { target: 'requiresAiDisclosure', pattern: /\bdisclosed\b[^.!?\n;]{0,40}(?:ai|artificial intelligence|copilot|llm|tool\/model|model)/i, description: 'Disclosed AI', negationAware: true },
];

const POLICY_NEGATION_PATTERN =
  /\b(?:not\s+(?:required|mandatory|necessary|needed|expected)|(?:is|are)\s+optional|optional|no\s+(?:such\s+)?requirement|(?:do|does|did)\s+not\s+(?:require|need)|(?:don't|doesn't|didn't)\s+(?:require|need))\b/i;

function findRequiredPolicyMatch(
  content: string,
  pattern: RegExp,
): string | undefined {
  const matcher = new RegExp(
    pattern.source,
    `${pattern.flags.replace(/g/g, "")}g`,
  );
  for (const match of content.matchAll(matcher)) {
    const index = match.index ?? 0;
    const matchEnd = index + match[0].length;
    const previousBoundaries = ["\n", ".", "!", "?", ";"].map((token) =>
      content.lastIndexOf(token, index - 1),
    );
    const nextBoundaries = ["\n", ".", "!", "?", ";"]
      .map((token) => content.indexOf(token, matchEnd))
      .filter((boundary) => boundary >= 0);
    const sentenceStart = Math.max(...previousBoundaries) + 1;
    const sentenceEnd = nextBoundaries.length
      ? Math.min(...nextBoundaries)
      : content.length;
    const contrastClauses = Array.from(
      content.matchAll(/,\s*(?:and|or)\b|\b(?:but|however|although|except|unless|yet)\b/gi),
      (connector) => {
        const start = connector.index ?? 0;
        return { start, end: start + connector[0].length };
      },
    );
    const clauseStart = contrastClauses
      .filter((connector) => connector.end <= index)
      .reduce((start, connector) => Math.max(start, connector.end), sentenceStart);
    const clauseEnd = contrastClauses
      .filter((connector) => connector.start >= matchEnd)
      .reduce((end, connector) => Math.min(end, connector.start), sentenceEnd);
    if (!POLICY_NEGATION_PATTERN.test(content.slice(clauseStart, clauseEnd))) {
      return match[0];
    }
  }
  return undefined;
}

function permissivePolicy(reason: string): CommunityGatePolicy {
  return {
    hasGatingRules: false,
    requiresIssueApprovalBeforePr: false,
    autoClosesNewIssues: false,
    hasLgtmApprovalProtocol: false,
    restrictedTriageHours: false,
    reasons: [reason],
    suggestedContributorAction:
      "Use the provider-verified public IssueBinding route, or the private security-disclosure route when policy requires it.",
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
  customRules?: PolicyRule[],
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
  let privateVulnerabilityDisclosure = false;
  let requiresDco = false;
  let requiresAiDisclosure = false;
  let maxDiffCeiling: number | undefined;

  const rules = [...DEFAULT_POLICY_RULES, ...(customRules || [])];

  for (const rule of rules) {
    let matchedStr: string | undefined;
    if (rule.negationAware) {
      matchedStr = findRequiredPolicyMatch(combinedContent, rule.pattern);
    } else {
      const match = combinedContent.match(rule.pattern);
      if (match) {
        matchedStr = match[0];
      }
    }
    
    if (matchedStr) {
      if (rule.target === 'requiresIssueApprovalBeforePr') requiresIssueApprovalBeforePr = true;
      else if (rule.target === 'autoClosesNewIssues') autoClosesNewIssues = true;
      else if (rule.target === 'hasLgtmApprovalProtocol') hasLgtmApprovalProtocol = true;
      else if (rule.target === 'restrictedTriageHours') restrictedTriageHours = true;
      else if (rule.target === 'privateVulnerabilityDisclosure') privateVulnerabilityDisclosure = true;
      else if (rule.target === 'requiresDco') requiresDco = true;
      else if (rule.target === 'requiresAiDisclosure') requiresAiDisclosure = true;
      
      matchedKeywords.push(matchedStr);
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

  if (requiresDco) {
    reasons.push(
      "Repository requires Developer Certificate of Origin sign-off on contribution commits.",
    );
  }
  if (requiresAiDisclosure) {
    reasons.push(
      "Repository requires explicit disclosure of AI or automated assistance.",
    );
  }

  if (privateVulnerabilityDisclosure) {
    reasons.push(
      "Repository requires private vulnerability disclosure (SECURITY.md DO-NOT-OPEN-PUBLIC-ISSUE); the private security route replaces the public Issue route.",
    );
  }

  const hasGatingRules =
    requiresIssueApprovalBeforePr ||
    autoClosesNewIssues ||
    hasLgtmApprovalProtocol;

  let suggestedContributorAction =
    "Use the provider-backed public Issue route and bind the resulting Issue before PR submission.";
  if (privateVulnerabilityDisclosure) {
    suggestedContributorAction =
      'Repository requires PRIVATE vulnerability disclosure. DO NOT open a public issue. Contact security maintainer via private channel before any public submission.';
  } else if (requiresIssueApprovalBeforePr || autoClosesNewIssues) {
    suggestedContributorAction =
      'Create and bind the provider-backed Issue first. PAUSE pipeline and wait for maintainer to reopen or comment "lgtmi" before submitting PR.';
  } else if (requiresDco || requiresAiDisclosure) {
    const requirements = [
      ...(requiresDco ? ["commit sign-off"] : []),
      ...(requiresAiDisclosure ? ["AI-assistance disclosure"] : []),
    ];
    suggestedContributorAction =
      `Follow the pinned ${requirements.join(" and ")} requirements before requesting approval.`;
  }

  return CommunityGatePolicySchema.parse({
    hasGatingRules,
    requiresIssueApprovalBeforePr,
    autoClosesNewIssues,
    hasLgtmApprovalProtocol,
    restrictedTriageHours,
    privateVulnerabilityDisclosure,
    requiresDco,
    requiresAiDisclosure,
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
    policy.hasLgtmApprovalProtocol ||
    policy.privateVulnerabilityDisclosure,
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
