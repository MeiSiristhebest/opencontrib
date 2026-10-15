/**
 * Issue qualification — pure, dependency-free domain logic.
 *
 * Relocated into the `domain/` layer (Task 8). Performs only deterministic
 * decision-making over its inputs (no I/O, no process-environment access). `ApiStatus` is a
 * type-only import, so there is no runtime coupling to the GitHub client.
 */

import type { QualificationResult, CommunityGatePolicy } from "../contracts/schemas.js";
import type { ApiStatus } from "../discovery/github-client.js";
import { deriveCollaborationPlaybook } from "./collaboration-playbook.js";
import {
  DEFAULT_INTENT_RULES,
  matchesIntentRule,
  evaluateIntentSignals,
  type IntentRule,
} from "./intent-evaluator.js";

export type { QualificationResult, IntentRule };
export { DEFAULT_INTENT_RULES, matchesIntentRule, evaluateIntentSignals };
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
  // Top modern OSS blocking labels (astral-sh/uv, vllm, fastapi)
  "needs-decision",
  "needs decision",
  "needs-design",
  "needs design",
  "design-needed",
  "rfc",
  "rfc-needed",
  "proposal",
] as const;

export interface IssueCommentItem {
  id: number;
  body?: string;
  user?: { login?: string } | null;
  author_association?: string;
  created_at: string;
}

export interface LinkedPrItem {
  number?: number;
  title?: string;
  state?: string;
  url?: string;
  isMerged?: boolean;
}

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
  hasPrLinked?: boolean;
  linkedPrs?: LinkedPrItem[];
  timelineApiStatus?: ApiStatus;
  /** Optional custom rules to extend the default intent detection rules */
  customIntentRules?: IntentRule[];
  /** Optional custom blocking labels to supplement ACTION_BLOCKING_LABELS */
  customBlockingLabels?: string[];
  /** Optional community gate policy to supply dynamic labels, philosophy, and anti-poaching config */
  communityPolicy?: CommunityGatePolicy;
  /**
   * Required clock for claim-expiry and author-first-right time windows.
   * Production callers obtain this from the `Clock` port (infrastructure);
   * tests pass a fixed timestamp for deterministic assertions. Required so
   * the domain layer never reaches for the wall clock directly.
   */
  now?: number;
}

export function qualifyIssue(input: QualifyIssueInput): QualificationResult {
  const {
    issueNumber = 1,
    issueTitle,
    issueBody,
    labels,
    isOpen,
    assignees,
    createdAt,
    authorLogin,
    comments,
    commentsApiStatus = "OK",
    existingLinkedPrsCount,
    hasPrLinked,
    linkedPrs,
    timelineApiStatus = "OK",
    customIntentRules,
    customBlockingLabels,
    communityPolicy,
  } = input;

  // Use explicitly passed deterministic now (or 0 fallback for tests without clock)
  const now = input.now ?? 0;

  const linkedPrsList: LinkedPrItem[] = [...(linkedPrs || [])];

  const effectiveLinkedPrsCount =
    linkedPrsList.length > 0
      ? linkedPrsList.length
      : existingLinkedPrsCount !== undefined && existingLinkedPrsCount > 0
        ? existingLinkedPrsCount
        : hasPrLinked
          ? 1
          : 0;

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

  // 3. Blocking Labels Gate (Exact & Alias Token Matching, dynamic community labels)
  const dynamicBlockingFromPolicy = communityPolicy?.dynamicBlockingLabels || [];
  const allBlockingLabels = [
    ...ACTION_BLOCKING_LABELS,
    ...dynamicBlockingFromPolicy,
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
  if (effectiveLinkedPrsCount > 0) {
    const hasMerged = linkedPrsList.some(
      (p) => p.isMerged || p.state === "merged" || p.state === "closed",
    );
    const detail =
      linkedPrsList.length > 0
        ? ` (${linkedPrsList.map((p) => `#${p.number ?? "PR"}`).join(", ")})`
        : "";
    return {
      isQualified: false,
      disqualifyReason: hasMerged
        ? `Issue already has merged/closed PR(s) addressing it${detail}.`
        : `Issue already has ${effectiveLinkedPrsCount} active PR(s) associated with it${detail}.`,
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

  // 5.5 Active Fix PR Announcement in Issue Description
  const matchingBodyPrRule = prAnnouncementRules.find((rule) =>
    matchesIntentRule(rule, issueBody),
  );
  const bodyPrSignal = evaluateIntentSignals(issueBody, 'pr_announcement', {
    customRules: customIntentRules,
  });
  if (matchingBodyPrRule || bodyPrSignal.isMatch) {
    return {
      isQualified: false,
      disqualifyReason: "Issue description already announces or links an existing PR.",
      track: "standard_track",
      hasExistingPr: true,
      hasClaimant: false,
      authorFirstRightActive: false,
      inspectedCommentsCount: comments.length,
      botRules: [],
    };
  }

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
    const commentPrSignal = evaluateIntentSignals(cBody, 'pr_announcement', {
      customRules: customIntentRules,
    });
    if (matchingPrRule || commentPrSignal.isMatch) {
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
      const claimSignal = evaluateIntentSignals(cBody, 'work_claim', {
        customRules: customIntentRules,
      });
      const approvalSignal = evaluateIntentSignals(cBody, 'approval_wait', {
        customRules: customIntentRules,
      });
      if (matchingClaimRule || claimSignal.isMatch || approvalSignal.isMatch) {
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

  // Dynamic claim expiry window
  const claimExpiryDays = communityPolicy?.antiPoachingConfig?.claimExpiryDays ?? 30;

  // Check if any claimant has active claim within claimExpiryDays
  for (const [claimant, latestActivity] of claimantLatestActivity.entries()) {
    const daysSinceActivity = (now - latestActivity) / (1000 * 60 * 60 * 24);
    if (daysSinceActivity <= claimExpiryDays) {
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
      collaborationPlaybook: deriveCollaborationPlaybook({
        isOpen,
        hasExistingPr: false,
        hasClaimant: true,
        claimantDetails,
        authorFirstRightActive: false,
        authorLogin,
        issueNumber,
        issueTitle,
        targetRepoPolicy: communityPolicy
          ? {
              aiPolicy: communityPolicy.aiPolicy,
              requiresAiDisclosure: communityPolicy.requiresAiDisclosure,
              philosophy: communityPolicy.philosophy,
            }
          : undefined,
      }),
    };
  }

  // 7. Initial Author-First-Right Check (Grace Period for Issue Author)
  const authorGracePeriodDays = communityPolicy?.antiPoachingConfig?.authorGracePeriodDays ?? 7;
  let authorFirstRightActive = false;
  let authorFirstRightDetails = "";

  // Check if initial issue body (by author) contained intent
  const bodyHasAuthorIntent =
    authorIntentRules.some((rule) => matchesIntentRule(rule, fullText)) ||
    evaluateIntentSignals(fullText, 'author_intent', {
      isAuthor: true,
      customRules: customIntentRules,
    }).isMatch;
  let latestAuthorIntentTime = bodyHasAuthorIntent ? Date.parse(createdAt) : 0;

  for (const comment of comments) {
    const user = comment.user?.login;
    if (
      user &&
      authorLogin &&
      user.toLowerCase() === authorLogin.toLowerCase()
    ) {
      const cBody = comment.body || "";
      if (
        authorIntentRules.some((rule) => matchesIntentRule(rule, cBody)) ||
        evaluateIntentSignals(cBody, 'author_intent', {
          isAuthor: true,
          customRules: customIntentRules,
        }).isMatch
      ) {
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
    if (daysSinceIntent < authorGracePeriodDays) {
      authorFirstRightActive = true;
      authorFirstRightDetails = `Author-first-right active: author expressed intent to fix ${Math.floor(daysSinceIntent)} days ago (< ${authorGracePeriodDays} days grace period). Anti-poaching protection active; prefer supportive co-authoring or waiting for author approval.`;
    }
  }

  // 8. Track Routing (Fast-Track vs Standard-Track)
  const isFastTrack =
    normalizedLabels.some((l) => /\b(?:docs?|documentation|typos?|spelling)\b/i.test(l)) ||
    /\b(?:typos?|documentation|readme)\b/i.test(fullText);

  const collaborationPlaybook = deriveCollaborationPlaybook({
    isOpen,
    hasExistingPr: effectiveLinkedPrsCount > 0,
    hasClaimant: false,
    authorFirstRightActive,
    authorLogin,
    issueNumber,
    issueTitle,
    targetRepoPolicy: communityPolicy
      ? {
          aiPolicy: communityPolicy.aiPolicy,
          requiresAiDisclosure: communityPolicy.requiresAiDisclosure,
          philosophy: communityPolicy.philosophy,
        }
      : undefined,
  });

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
    collaborationPlaybook,
  };
}
