/**
 * Issue qualification — pure, dependency-free domain logic.
 *
 * Relocated into the `domain/` layer (Task 8). Performs only deterministic
 * decision-making over its inputs (no I/O, no process-environment access). `ApiStatus` is a
 * type-only import, so there is no runtime coupling to the GitHub client.
 */

import type { QualificationResult } from '../contracts/schemas.js';
import type { ApiStatus } from '../discovery/github-client.js';

export const ACTION_BLOCKING_LABELS = [
  'blocked',
  'duplicate',
  'invalid',
  'needs info',
  'needs-info',
  'needs information',
  'needs-information',
  'question',
  'discussion',
  'wontfix',
  'wont-fix',
  "won't fix",
  "won't-fix",
  'stale',
] as const;

export interface IssueCommentItem {
  id: number;
  body?: string;
  user?: { login?: string } | null;
  created_at: string;
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
  timelineApiStatus?: ApiStatus;
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
    commentsApiStatus = 'OK',
    existingLinkedPrsCount = 0,
    timelineApiStatus = 'OK',
  } = input;

  const normalizedLabels = labels.map((l) => l.toLowerCase().replace(/[-_]+/g, ' ').trim());
  const rawNormalizedLabels = labels.map((l) => l.toLowerCase().trim());
  const fullText = `${issueTitle} ${issueBody}`.toLowerCase();

  // 1. Basic State Gate
  if (!isOpen) {
    return {
      isQualified: false,
      disqualifyReason: 'Issue is already closed.',
      track: 'standard_track',
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
      disqualifyReason: `Issue already assigned to: ${assignees.join(', ')}`,
      track: 'standard_track',
      hasExistingPr: false,
      hasClaimant: true,
      authorFirstRightActive: false,
      inspectedCommentsCount: comments.length,
      botRules: [],
    };
  }

  // 3. Blocking Labels Gate (Exact & Alias Token Matching, preventing substring false positives)
  for (const blocking of ACTION_BLOCKING_LABELS) {
    const blockingNormalized = blocking.replace(/[-_]+/g, ' ');
    if (
      normalizedLabels.includes(blockingNormalized) ||
      rawNormalizedLabels.includes(blocking)
    ) {
      return {
        isQualified: false,
        disqualifyReason: `Issue contains blocking label: ${blocking}`,
        track: 'standard_track',
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
    s === 'NOT_FOUND' ||
    s === 'RATE_LIMITED' ||
    s === 'FORBIDDEN' ||
    s === 'NETWORK_ERROR' ||
    s === 'UNKNOWN_ERROR';

  if (isApiError(commentsApiStatus) || isApiError(timelineApiStatus)) {
    const reason = `GitHub API verification error (comments: ${commentsApiStatus}, timeline: ${timelineApiStatus})`;
    return {
      isQualified: false,
      disqualifyReason: `Unable to verify comments/timeline due to ${reason} (tri-state safety gate).`,
      track: 'standard_track',
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
      track: 'standard_track',
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
  let claimantDetails = '';
  const now = Date.now();

  // Pattern for developer actively announcing they opened a fix PR
  const fixPrAnnouncementRegex =
    /(?:i(?:\s*have|'ve|\s*just)?\s*(?:opened|submitted|created|pushed)\s*(?:a\s*)?(?:pr|pull\s*request)|fix(?:es)?\s*(?:in|via|at)\s*(?:pr|#\d+|pull))/i;

  // Track latest activity per claimant
  const claimantLatestActivity = new Map<string, number>();

  for (const comment of comments) {
    const cBody = comment.body || '';
    const user = comment.user?.login || 'unknown';
    const commentTime = Date.parse(comment.created_at);

    // Active Fix PR Announcement Detection (excludes conversational PR references like "PR #123 is unrelated")
    if (fixPrAnnouncementRegex.test(cBody)) {
      return {
        isQualified: false,
        disqualifyReason: `Another developer (@${user}) announced a fix PR in comments.`,
        track: 'standard_track',
        hasExistingPr: true,
        hasClaimant: true,
        authorFirstRightActive: false,
        inspectedCommentsCount: comments.length,
        botRules,
      };
    }

    // Contributor Claim Intent Detection with Latest Activity Tracking (30-Day Limit)
    const isAuthor = authorLogin && user.toLowerCase() === authorLogin.toLowerCase();
    if (!isAuthor && user !== 'unknown') {
      if (
        /\b(?:i am working on this|i'm working on this|can i work on this|please assign|working on a fix|\/claim|\/assign)\b/i.test(
          cBody,
        )
      ) {
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
    if (/\bcla\b/i.test(cBody) || /\bdco\b/i.test(cBody) || /contributor license agreement/i.test(cBody)) {
      botRules.push('Requires CLA/DCO sign-off');
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
      track: 'standard_track',
      hasExistingPr: false,
      hasClaimant: true,
      authorFirstRightActive: false,
      inspectedCommentsCount: comments.length,
      botRules,
    };
  }

  // 7. Initial Author-First-Right Check (7-Day Grace Period for Issue Author)
  let authorFirstRightActive = false;
  let authorFirstRightDetails = '';
  const authorFixPhrases = [
    'happy to open a pr',
    "i'll submit a fix",
    'i will submit a fix',
    'working on a pr',
    'i can fix this',
    'submitting a pr',
  ];

  // Check if initial issue body (by author) contained intent
  const bodyHasAuthorIntent = authorFixPhrases.some((phrase) => fullText.includes(phrase));
  let latestAuthorIntentTime = bodyHasAuthorIntent ? Date.parse(createdAt) : 0;

  for (const comment of comments) {
    const user = comment.user?.login;
    if (user && authorLogin && user.toLowerCase() === authorLogin.toLowerCase()) {
      const cBody = (comment.body || '').toLowerCase();
      if (authorFixPhrases.some((phrase) => cBody.includes(phrase))) {
        const commentTime = Date.parse(comment.created_at);
        if (!isNaN(commentTime) && commentTime > latestAuthorIntentTime) {
          latestAuthorIntentTime = commentTime;
        }
      }
    }
  }

  if (latestAuthorIntentTime > 0) {
    const daysSinceIntent = (now - latestAuthorIntentTime) / (1000 * 60 * 60 * 24);
    if (daysSinceIntent < 7) {
      authorFirstRightActive = true;
      authorFirstRightDetails = `Author expressed intent to fix ${Math.floor(daysSinceIntent)} days ago (< 7 days grace period).`;
    }
  }

  // 8. Track Routing (Fast-Track vs Standard-Track)
  const isFastTrack =
    normalizedLabels.some((l) => l.includes('doc') || l.includes('typo')) ||
    fullText.includes('typo') ||
    fullText.includes('readme') ||
    fullText.includes('documentation');

  return {
    isQualified: !authorFirstRightActive,
    disqualifyReason: authorFirstRightActive ? authorFirstRightDetails : undefined,
    track: isFastTrack ? 'fast_track' : 'standard_track',
    hasExistingPr: false,
    hasClaimant: false,
    authorFirstRightActive,
    authorFirstRightDetails,
    inspectedCommentsCount: comments.length,
    botRules,
  };
}
