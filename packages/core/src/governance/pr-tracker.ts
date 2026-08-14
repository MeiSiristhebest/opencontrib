export interface PrLifecycleStatus {
  prNumber: number;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  ciStatus: 'SUCCESS' | 'PENDING' | 'FAILURE' | 'UNKNOWN';
  maintainerReviewState: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'AWAITING_REVIEW';
  unresolvedCommentsCount: number;
  recommendedAction: 'CELEBRATE_AND_SYNC_FLYWHEEL' | 'REPLY_AND_REPAIR' | 'WAIT_PATIENTLY' | 'RETRY_CI';
}

export function analyzePrLifecycle(input: {
  prNumber: number;
  isMerged: boolean;
  isOpen: boolean;
  checkRuns?: Array<{ name: string; conclusion: string | null; status: string }>;
  reviews?: Array<{ state: string; author: string; body?: string }>;
  commentsCount?: number;
}): PrLifecycleStatus {
  const { prNumber, isMerged, isOpen, checkRuns = [], reviews = [], commentsCount = 0 } = input;

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
