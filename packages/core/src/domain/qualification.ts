/**
 * Issue qualification — pure, dependency-free domain logic.
 *
 * Relocated into the `domain/` layer (Task 8). Performs only deterministic
 * decision-making over its inputs (no I/O, no process-environment access). `ApiStatus` is a
 * type-only import, so there is no runtime coupling to the GitHub client.
 */

import type { QualificationResult } from "../contracts/schemas.js";
import type { ApiStatus } from "../discovery/github-client.js";

export type { QualificationResult };
export type QualificationTrack = "fast_track" | "standard_track";

export const ACTION_BLOCKING_LABELS = [
  "blocked",
  "duplicate",
  "invalid",
  "needs info",
  "needs-info",
  "needs information",
  "needs-information",
  "question",
  "discussion",
  "wontfix",
  "wont-fix",
  "won't fix",
  "won't-fix",
  "stale",
] as const;

export interface IssueCommentItem {
  id: number;
  body?: string;
  user?: { login?: string } | null;
  author_association?: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Extensible Intent Rule Registry
// ---------------------------------------------------------------------------

export interface IntentRule {
  /** Which kind of contributor intent this rule detects */
  category: 'pr_announcement' | 'work_claim' | 'approval_wait' | 'author_intent';
  /** Regex pattern to match against comment body */
  pattern: RegExp;
  /** How strongly this signal indicates intent */
  strength: 'strong' | 'moderate' | 'weak';
  /** Human-readable description */
  description: string;
}

/**
 * Default built-in intent detection rules.
 * External callers can extend this set via `qualifyIssue(input, { customRules })`.
 */
export const DEFAULT_INTENT_RULES: IntentRule[] = [
  // --- PR Announcement (immediate disqualification) ---
  { category: 'pr_announcement', pattern: /i(?:\s*have|'ve|\s*just)?\s*(?:opened|submitted|created|pushed)\s*(?:a\s*)?(?:pr|pull\s*request)/i, strength: 'strong', description: 'Developer announces opened PR' },
  { category: 'pr_announcement', pattern: /fix(?:es)?\s*(?:in|via|at)\s*(?:pr|#\d+|pull)/i, strength: 'strong', description: 'Developer references fix in PR' },

  // --- Work Claim (30-day activity window) ---
  { category: 'work_claim', pattern: /\b(?:i am working on this|i'm working on this)\b/i, strength: 'strong', description: 'Explicit "working on this"' },
  { category: 'work_claim', pattern: /\b(?:can i work on this|please assign)\b/i, strength: 'strong', description: 'Request for assignment' },
  { category: 'work_claim', pattern: /\bi(?:'m| am) working on a fix\b/i, strength: 'strong', description: 'Working on a fix' },
  { category: 'work_claim', pattern: /\b(?:i(?:'m| am) taking this|i(?:'ll| will) take this)\b/i, strength: 'strong', description: 'Taking ownership' },
  { category: 'work_claim', pattern: /\bi(?:'m| am) looking into this\b/i, strength: 'moderate', description: 'Looking into the issue' },
  { category: 'work_claim', pattern: /\b(?:i(?:'m| am) opening a pr|i(?:'ll| will) submit a pr|my wip pr|i have (?:a )?wip pr)\b/i, strength: 'strong', description: 'PR submission intent' },
  { category: 'work_claim', pattern: /\b(?:\/claim|\/assign)\b/i, strength: 'strong', description: 'Bot claim/assign command' },
  { category: 'work_claim', pattern: /\b(?:i'd like to work on this|i would like to work on this)\b/i, strength: 'strong', description: 'Polite work request' },
  { category: 'work_claim', pattern: /\b(?:i'd like to implement|i would like to implement)\b/i, strength: 'strong', description: 'Implementation intent' },
  { category: 'work_claim', pattern: /\b(?:i'd like to contribute)\b/i, strength: 'moderate', description: 'Contribution intent' },
  { category: 'work_claim', pattern: /\bi(?:'m| am) happy to (?:send|open) (?:the )?pr\b/i, strength: 'strong', description: 'Eager PR offer' },
  { category: 'work_claim', pattern: /\bi can (?:send|open) (?:the )?pr\b/i, strength: 'moderate', description: 'PR offer' },
  { category: 'work_claim', pattern: /\bi(?:'ve| have)? prepared (?:a fix|a diff)\b/i, strength: 'strong', description: 'Fix already prepared' },
  { category: 'work_claim', pattern: /\bmy fix and regression tests are ready\b/i, strength: 'strong', description: 'Fix and tests ready' },
  { category: 'work_claim', pattern: /\bmy pr (?:is )?coming shortly\b/i, strength: 'strong', description: 'PR imminent' },

  // --- Approval Wait (indicates contributor waiting for maintainer) ---
  { category: 'approval_wait', pattern: /\b(?:waiting on `?lgtm`?|waiting for `?lgtm`?)\b/i, strength: 'strong', description: 'Waiting for LGTM approval' },
  { category: 'approval_wait', pattern: /\b(?:could a maintainer approve|could you approve)\b/i, strength: 'moderate', description: 'Requesting maintainer approval' },

  // --- Author Intent (7-day grace period) ---
  { category: 'author_intent', pattern: /\bi(?:'m| am) happy to open a pr\b/i, strength: 'strong', description: 'Author offers PR' },
  { category: 'author_intent', pattern: /\b(?:i'll submit a fix|i will submit a fix)\b/i, strength: 'strong', description: 'Author will submit fix' },
  { category: 'author_intent', pattern: /\bi(?:'m| am) working on a pr\b/i, strength: 'strong', description: 'Author working on PR' },
  { category: 'author_intent', pattern: /\bi can fix this\b/i, strength: 'strong', description: 'Author can fix' },
  { category: 'author_intent', pattern: /\bi(?:'m| am) submitting a pr\b/i, strength: 'strong', description: 'Author submitting PR' },
  { category: 'author_intent', pattern: /\bi(?:'m| am) opening a pr\b/i, strength: 'strong', description: 'Author opening PR' },
  { category: 'author_intent', pattern: /\bi(?:'ll| will) open a pr\b/i, strength: 'strong', description: 'Author will open PR' },
  { category: 'author_intent', pattern: /\b(?:i'll create a pr|i will create a pr)\b/i, strength: 'strong', description: 'Author will create PR' },
  { category: 'author_intent', pattern: /\bi can submit a pr\b/i, strength: 'moderate', description: 'Author can submit PR' },
  { category: 'author_intent', pattern: /\b(?:i'll take care of this|i will take care of this)\b/i, strength: 'strong', description: 'Author taking ownership' },
];

export interface QualifyIssueInput {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  labels: string[];
  isOpen: boolean;
  assignees: string[];
  createdAt: string;
  authorLogin?: string;
  comments: IssueCommentItem[];
  commentsApiStatus?: ApiStatus;
  existingLinkedPrsCount?: number;
  timelineApiStatus?: ApiStatus;
  /** Optional custom rules to extend the default intent detection rules */
  customIntentRules?: IntentRule[];
  /** Optional custom blocking labels to supplement ACTION_BLOCKING_LABELS */
  customBlockingLabels?: string[];
  /**
   * Required clock for claim-expiry and author-first-right time windows.
   * Production callers obtain this from the `Clock` port (infrastructure);
   * tests pass a fixed timestamp for deterministic assertions. Required so
   * the domain layer never reaches for the wall clock directly.
   */
  now: number;
}

function matchesIntentRule(rule: IntentRule, text: string): boolean {
  const pattern = new RegExp(
    rule.pattern.source,
    rule.pattern.flags.replace(/[gy]/g, ""),
  );
  return pattern.test(text);
}

export function qualifyIssue(input: QualifyIssueInput): QualificationResult {
  const {
    issueTitle,
    issueBody,
    labels,
    isOpen,
    assignees,
    createdAt,
    authorLogin,
    comments,
    commentsApiStatus = "OK",
    existingLinkedPrsCount = 0,
    timelineApiStatus = "OK",
    customIntentRules,
    customBlockingLabels,
    now,
  } = input;

  const normalizedLabels = labels.map((l) =>
    l.toLowerCase().replace(/[-_]+/g, " ").trim(),
  );
  const rawNormalizedLabels = labels.map((l) => l.toLowerCase().trim());
  const fullText = `${issueTitle} ${issueBody}`.toLowerCase();

  // 1. Basic State Gate
  if (!isOpen) {
    return {
      isQualified: false,
      disqualifyReason: "Issue is already closed.",
      track: "standard_track",
      hasExistingPr: false,
      hasClaimant: false,
      authorFirstRightActive: false,
      inspectedCommentsCount: comments.length,
      botRules: [],
    };
  }

  // 2. Assignee Gate
  if (assignees.length > 0) {
    return {
      isQualified: false,
      disqualifyReason: `Issue already assigned to: ${assignees.join(", ")}`,
      track: "standard_track",
      hasExistingPr: false,
      hasClaimant: true,
      authorFirstRightActive: false,
      inspectedCommentsCount: comments.length,
      botRules: [],
    };
  }

  // 3. Blocking Labels Gate (Exact & Alias Token Matching, preventing substring false positives)
  const allBlockingLabels = [
    ...ACTION_BLOCKING_LABELS,
    ...(customBlockingLabels || []).map((label) => label.toLowerCase().trim()),
  ];
  for (const blocking of allBlockingLabels) {
    const blockingNormalized = blocking.replace(/[-_]+/g, " ").trim();
    if (
      normalizedLabels.includes(blockingNormalized) ||
      rawNormalizedLabels.includes(blocking)
    ) {
      return {
        isQualified: false,
        disqualifyReason: `Issue contains blocking label: ${blocking}`,
        track: "standard_track",
        hasExistingPr: false,
        hasClaimant: false,
        authorFirstRightActive: false,
        inspectedCommentsCount: comments.length,
        botRules: [],
      };
    }
  }

  // 4. Tri-State API Safety Gate (Fail-Safe on NOT_FOUND, Auth, or Rate-Limit Errors)
  const isApiError = (s: ApiStatus) =>
    s === "NOT_FOUND" ||
    s === "RATE_LIMITED" ||
    s === "FORBIDDEN" ||
    s === "NETWORK_ERROR" ||
    s === "UNKNOWN_ERROR";

  if (isApiError(commentsApiStatus) || isApiError(timelineApiStatus)) {
    const reason = `GitHub API verification error (comments: ${commentsApiStatus}, timeline: ${timelineApiStatus})`;
    return {
      isQualified: false,
      disqualifyReason: `Unable to verify comments/timeline due to ${reason} (tri-state safety gate).`,
      track: "standard_track",
      hasExistingPr: false,
      hasClaimant: false,
      authorFirstRightActive: false,
      inspectedCommentsCount: comments.length,
      botRules: [],
    };
  }

  // 5. Duplicate / Active Linked PR Gate (Authoritative GitHub Timeline)
  if (existingLinkedPrsCount > 0) {
    return {
      isQualified: false,
      disqualifyReason: `Issue already has ${existingLinkedPrsCount} active PR(s) associated with it.`,
      track: "standard_track",
      hasExistingPr: true,
      hasClaimant: false,
      authorFirstRightActive: false,
      inspectedCommentsCount: comments.length,
      botRules: [],
    };
  }

  // 6. Comment History, Claim Expiry & Contributor Intent Audit
  const botRules: string[] = [];
  let hasClaimant = false;
  let claimantDetails = "";

  // Compile active intent rules
  const activeIntentRules = [
    ...DEFAULT_INTENT_RULES,
    ...(customIntentRules || []),
  ];
  const prAnnouncementRules = activeIntentRules.filter((r) => r.category === 'pr_announcement');
  const claimRules = activeIntentRules.filter((r) => r.category === 'work_claim' || r.category === 'approval_wait');
  const authorIntentRules = activeIntentRules.filter((r) => r.category === 'author_intent');

  // Track latest activity per claimant
  const claimantLatestActivity = new Map<string, number>();

  for (const comment of comments) {
    const cBody = comment.body || "";
    const user = comment.user?.login || "unknown";
    const commentTime = Date.parse(comment.created_at);

    // Active Fix PR Announcement Detection
    const matchingPrRule = prAnnouncementRules.find((rule) =>
      matchesIntentRule(rule, cBody),
    );
    if (matchingPrRule) {
      return {
        isQualified: false,
        disqualifyReason: `Another developer (@${user}) announced a fix PR in comments.`,
        track: "standard_track",
        hasExistingPr: true,
        hasClaimant: true,
        authorFirstRightActive: false,
        inspectedCommentsCount: comments.length,
        botRules,
      };
    }

    // Contributor Claim Intent Detection with Latest Activity Tracking (30-Day Limit)
    const isAuthor =
      authorLogin && user.toLowerCase() === authorLogin.toLowerCase();
    if (!isAuthor && user !== "unknown") {
      const matchingClaimRule = claimRules.find((rule) =>
        matchesIntentRule(rule, cBody),
      );
      if (matchingClaimRule) {
        const prev = claimantLatestActivity.get(user.toLowerCase()) || 0;
        if (!isNaN(commentTime) && commentTime > prev) {
          claimantLatestActivity.set(user.toLowerCase(), commentTime);
        }
      } else if (claimantLatestActivity.has(user.toLowerCase())) {
        // Any subsequent follow-up comment by the claimant refreshes their activity timestamp
        const prev = claimantLatestActivity.get(user.toLowerCase()) || 0;
        if (!isNaN(commentTime) && commentTime > prev) {
          claimantLatestActivity.set(user.toLowerCase(), commentTime);
        }
      }
    }

    // Bot instruction capture
    if (
      /\bcla\b/i.test(cBody) ||
      /\bdco\b/i.test(cBody) ||
      /contributor license agreement/i.test(cBody)
    ) {
      botRules.push("Requires CLA/DCO sign-off");
    }
  }

  // Check if any claimant has active claim within 30 days
  for (const [claimant, latestActivity] of claimantLatestActivity.entries()) {
    const daysSinceActivity = (now - latestActivity) / (1000 * 60 * 60 * 24);
    if (daysSinceActivity <= 30) {
      hasClaimant = true;
      claimantDetails = `@${claimant} active claim (${Math.floor(daysSinceActivity)} days ago)`;
      break;
    }
  }

  if (hasClaimant) {
    return {
      isQualified: false,
      disqualifyReason: `Issue is claimed by another contributor: ${claimantDetails}`,
      track: "standard_track",
      hasExistingPr: false,
      hasClaimant: true,
      authorFirstRightActive: false,
      inspectedCommentsCount: comments.length,
      botRules,
    };
  }

  // 7. Initial Author-First-Right Check (7-Day Grace Period for Issue Author)
  let authorFirstRightActive = false;
  let authorFirstRightDetails = "";

  // Check if initial issue body (by author) contained intent
  const bodyHasAuthorIntent = authorIntentRules.some((rule) =>
    matchesIntentRule(rule, fullText),
  );
  let latestAuthorIntentTime = bodyHasAuthorIntent ? Date.parse(createdAt) : 0;

  for (const comment of comments) {
    const user = comment.user?.login;
    if (
      user &&
      authorLogin &&
      user.toLowerCase() === authorLogin.toLowerCase()
    ) {
      const cBody = comment.body || "";
      if (authorIntentRules.some((rule) => matchesIntentRule(rule, cBody))) {
        const commentTime = Date.parse(comment.created_at);
        if (!isNaN(commentTime) && commentTime > latestAuthorIntentTime) {
          latestAuthorIntentTime = commentTime;
        }
      }
    }
  }

  if (latestAuthorIntentTime > 0) {
    const daysSinceIntent =
      (now - latestAuthorIntentTime) / (1000 * 60 * 60 * 24);
    if (daysSinceIntent < 7) {
      authorFirstRightActive = true;
      authorFirstRightDetails = `Author-first-right active: expressed intent to fix ${Math.floor(daysSinceIntent)} days ago (< 7 days grace period).`;
    }
  }

  // 8. Track Routing (Fast-Track vs Standard-Track)
  const isFastTrack =
    normalizedLabels.some((l) => /\b(?:docs?|documentation|typos?|spelling)\b/i.test(l)) ||
    /\b(?:typos?|documentation|readme)\b/i.test(fullText);

  return {
    isQualified: !authorFirstRightActive,
    disqualifyReason: authorFirstRightActive
      ? authorFirstRightDetails
      : undefined,
    track: isFastTrack ? "fast_track" : "standard_track",
    hasExistingPr: false,
    hasClaimant: false,
    authorFirstRightActive,
    authorFirstRightDetails,
    inspectedCommentsCount: comments.length,
    botRules,
  };
}
