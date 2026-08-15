import type { QualificationResult } from '../contracts/schemas.js';

export const ACTION_BLOCKING_LABELS = [
  'blocked',
  'duplicate',
  'invalid',
  'needs info',
  'needs information',
  'question',
  'discussion',
  'wontfix',
  'wont-fix',
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
  commentsApiStatus?: 'OK' | 'API_UNAVAILABLE';
  existingLinkedPrsCount?: number;
  timelineApiStatus?: 'OK' | 'API_UNAVAILABLE';
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

  // 3. Blocking Labels Gate (Single Source of Truth)
  for (const blocking of ACTION_BLOCKING_LABELS) {
    if (normalizedLabels.some((l) => l.includes(blocking))) {
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

  // 4. Tri-State API Safety Gate (Fail-Safe)
  if (commentsApiStatus === 'API_UNAVAILABLE' || timelineApiStatus === 'API_UNAVAILABLE') {
    return {
      isQualified: false,
      disqualifyReason: 'Unable to verify comments/timeline due to GitHub API error (tri-state safety gate).',
      track: 'standard_track',
      hasExistingPr: false,
      hasClaimant: false,
      authorFirstRightActive: false,
      inspectedCommentsCount: comments.length,
      botRules: [],
    };
  }

  // 5. Duplicate / Active Linked PR Gate
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

  // 6. Comment History, Anti-Bandwagoning & Structured PR Detection
  const botRules: string[] = [];
  let hasClaimant = false;
  let claimantDetails = '';

  const prUrlRegex = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/i;
  const prRefRegex = /\b(?:pull\s*request|pr|fixes|closes|resolves)\s*#\d+\b/i;

  for (const comment of comments) {
    const cBody = comment.body || '';
    const user = comment.user?.login || 'unknown';

    // Robust PR Link Detection (URL or explicit PR reference)
    if (prUrlRegex.test(cBody) || prRefRegex.test(cBody)) {
      return {
        isQualified: false,
        disqualifyReason: `Another developer (@${user}) posted a PR reference in comments.`,
        track: 'standard_track',
        hasExistingPr: true,
        hasClaimant: true,
        authorFirstRightActive: false,
        inspectedCommentsCount: comments.length,
        botRules,
      };
    }

    // Contributor Claim Intent Detection (Non-author claimants)
    const isAuthor = authorLogin && user.toLowerCase() === authorLogin.toLowerCase();
    if (!isAuthor) {
      if (
        /\b(?:i am working on this|i'm working on this|can i work on this|please assign|working on a fix|\/claim|\/assign)\b/i.test(
          cBody,
        )
      ) {
        hasClaimant = true;
        claimantDetails = `@${user} commented claim intent on ${comment.created_at}`;
      }
    }

    // Bot instruction capture
    if (/\bcla\b/i.test(cBody) || /\bdco\b/i.test(cBody) || /contributor license agreement/i.test(cBody)) {
      botRules.push('Requires CLA/DCO sign-off');
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

  // 7. Author-First-Right Check (7-Day Grace Period for Issue Author)
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

  // Check if issue body (authored by issue creator) contains intent
  const bodyHasAuthorIntent = authorFixPhrases.some((phrase) => fullText.includes(phrase));

  // Check if any comment by the author contains intent within last 7 days
  const nowTime = Date.now();
  let latestAuthorIntentTime = bodyHasAuthorIntent ? new Date(createdAt).getTime() : 0;

  for (const comment of comments) {
    const user = comment.user?.login;
    if (user && authorLogin && user.toLowerCase() === authorLogin.toLowerCase()) {
      const cBody = (comment.body || '').toLowerCase();
      if (authorFixPhrases.some((phrase) => cBody.includes(phrase))) {
        const commentTime = new Date(comment.created_at).getTime();
        if (commentTime > latestAuthorIntentTime) {
          latestAuthorIntentTime = commentTime;
        }
      }
    }
  }

  if (latestAuthorIntentTime > 0) {
    const daysSinceIntent = (nowTime - latestAuthorIntentTime) / (1000 * 60 * 60 * 24);
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
