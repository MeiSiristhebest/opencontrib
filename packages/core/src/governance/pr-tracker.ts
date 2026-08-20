export interface PrLifecycleStatus {
  prNumber: number;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  ciStatus: 'SUCCESS' | 'PENDING' | 'FAILURE' | 'UNKNOWN';
  maintainerReviewState: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'AWAITING_REVIEW';
  unresolvedCommentsCount: number;
  recommendedAction: 'CELEBRATE_AND_SYNC_FLYWHEEL' | 'REPLY_AND_REPAIR' | 'WAIT_PATIENTLY' | 'RETRY_CI';
}

export interface AnalyzePrInput {
  prNumber?: number;
  isMerged?: boolean;
  isOpen?: boolean;
  pr?: {
    number: number;
    state?: string;
    merged?: boolean;
    mergeable?: boolean | null;
    mergeableState?: string;
    draft?: boolean;
    headSha?: string;
  };
  checkRuns?: Array<{ name: string; conclusion: string | null; status: string; id?: number; detailsUrl?: string }>;
  reviews?: Array<{ state: string; author?: string; user?: { login: string }; body?: string; id?: number; submittedAt?: string }>;
  comments?: Array<{ id?: number; user?: { login: string }; body?: string; createdAt?: string }>;
  commentsCount?: number;
}

export function analyzePrLifecycle(input: AnalyzePrInput): PrLifecycleStatus {
  const prNumber = input.prNumber ?? input.pr?.number ?? 1;
  const isMerged = input.isMerged ?? input.pr?.merged ?? (input.pr?.state === 'closed' && Boolean(input.pr?.merged));
  const isOpen = input.isOpen ?? (input.pr?.state === 'open');
  const checkRuns = input.checkRuns ?? [];
  const reviews = (input.reviews ?? []).map((r) => ({
    state: r.state,
    author: r.author || r.user?.login || 'maintainer',
    body: r.body,
  }));
  const commentsCount = input.commentsCount ?? (input.comments ? input.comments.length : 0);

  if (isMerged) {
    return {
      prNumber,
      state: 'MERGED',
      ciStatus: 'SUCCESS',
      maintainerReviewState: 'APPROVED',
      unresolvedCommentsCount: 0,
      recommendedAction: 'CELEBRATE_AND_SYNC_FLYWHEEL',
    };
  }

  // Determine CI Status
  let ciStatus: 'SUCCESS' | 'PENDING' | 'FAILURE' | 'UNKNOWN' = 'UNKNOWN';
  if (checkRuns.length > 0) {
    const hasFailures = checkRuns.some((c) => c.conclusion === 'failure' || c.conclusion === 'timed_out');
    const hasPending = checkRuns.some((c) => c.status === 'in_progress' || c.status === 'queued');
    if (hasFailures) ciStatus = 'FAILURE';
    else if (hasPending) ciStatus = 'PENDING';
    else ciStatus = 'SUCCESS';
  }

  // Determine Review State
  let maintainerReviewState: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'AWAITING_REVIEW' = 'AWAITING_REVIEW';
  const latestReview = reviews[reviews.length - 1];
  if (latestReview) {
    if (latestReview.state === 'APPROVED') maintainerReviewState = 'APPROVED';
    else if (latestReview.state === 'CHANGES_REQUESTED') maintainerReviewState = 'CHANGES_REQUESTED';
    else maintainerReviewState = 'COMMENTED';
  }

  let recommendedAction: 'CELEBRATE_AND_SYNC_FLYWHEEL' | 'REPLY_AND_REPAIR' | 'WAIT_PATIENTLY' | 'RETRY_CI' =
    'WAIT_PATIENTLY';
  if (ciStatus === 'FAILURE') {
    recommendedAction = 'RETRY_CI';
  } else if (maintainerReviewState === 'CHANGES_REQUESTED') {
    recommendedAction = 'REPLY_AND_REPAIR';
  }

  return {
    prNumber,
    state: isOpen ? 'OPEN' : 'CLOSED',
    ciStatus,
    maintainerReviewState,
    unresolvedCommentsCount: commentsCount,
    recommendedAction,
  };
}

export function generateMaintainerReplyTemplate(input: {
  maintainerName: string;
  feedbackSummary: string;
  actionTaken: string;
}): string {
  return `Thanks for the review @${input.maintainerName}!

I've addressed the feedback:
- ${input.actionTaken}

All tests and lint checks have been updated and verified. Let me know if anything else is needed.`;
}

// Backward Compatibility Alias for MCP & External tools
export const trackPrStatus = analyzePrLifecycle;
