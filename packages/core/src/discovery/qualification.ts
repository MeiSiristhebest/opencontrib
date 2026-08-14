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
] as const;

export interface IssueCommentItem {
  id: number;
  body?: string;
  user?: { login?: string } | null;
  created_at: string;
}

export function qualifyIssue(input: {
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  labels: string[];
  isOpen: boolean;
  assignees: string[];
  createdAt: string;
  comments: IssueCommentItem[];
  existingLinkedPrsCount?: number;
}): QualificationResult {
  const { issueTitle, issueBody, labels, isOpen, assignees, createdAt, comments, existingLinkedPrsCount = 0 } = input;

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

  // 3. Blocking Labels Gate
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

  // 4. Duplicate / Existing PR Gate
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

  // 5. Comment History & Anti-Bandwagoning Audit
  const botRules: string[] = [];
  let hasClaimant = false;
  let claimantDetails = '';

  for (const comment of comments) {
    const cBody = (comment.body || '').toLowerCase();
    const user = comment.user?.login || 'unknown';

    // PR link detection
    if (cBody.includes('pull/') || cBody.includes('pr #') || cBody.includes('fixes #') || cBody.includes('opened a pr')) {
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

    // Active claiming detection
    if (
      cBody.includes('i am working on this') ||
      cBody.includes("i'm working on this") ||
      cBody.includes('can i work on this') ||
      cBody.includes('please assign') ||
      cBody.includes('/claim') ||
      cBody.includes('/assign')
    ) {
      hasClaimant = true;
      claimantDetails = `@${user} commented claim intent on ${comment.created_at}`;
    }

    // Bot instruction capture with word-boundary regex to prevent false positives (e.g. "class", "cleanup")
    if (/\bcla\b/i.test(cBody) || /\bdco\b/i.test(cBody) || cBody.includes('contributor license agreement')) {
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

  // 6. Author-First-Right Check (7-Day Rule)
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

  if (authorFixPhrases.some((phrase) => fullText.includes(phrase))) {
    const createdAtTime = new Date(createdAt).getTime();
    const nowTime = Date.now();
    const daysSinceCreation = (nowTime - createdAtTime) / (1000 * 60 * 60 * 24);

    if (daysSinceCreation < 7) {
      authorFirstRightActive = true;
      authorFirstRightDetails = `Author expressed intent to fix ${Math.floor(daysSinceCreation)} days ago (< 7 days grace period).`;
    }
  }

  // 7. Track Routing (Fast-Track vs Standard-Track)
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
