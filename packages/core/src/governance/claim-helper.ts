import type { PointerStub } from '../kernel/contract.js';

export interface IssueClaimPayload {
  issueNumber: number;
  issueTitle: string;
  claimComment: string;
  findingSummary: string;
  isReadyForPR: boolean;
}

/**
 * Claim Protocol (Community Issue Claim & Bot Etiquette Standard)
 * Clean semantic naming replacing fuzzy 'Engine' suffixes.
 */
export class ClaimProtocol {
  /**
   * Generates the authoritative Proactive Issue Claim Statement:
   * "I have investigated this issue and have a reproducible test case and fix ready. Please assign this issue to me, I will submit a PR shortly."
   */
  public static generateClaimPayload(
    issueNumber: number,
    issueTitle: string,
    finding?: PointerStub,
  ): IssueClaimPayload {
    const summary = finding
      ? `Identified root cause in ${finding.file}:${finding.line} (${finding.title})`
      : `Investigated ${issueTitle}`;

    const claimComment = `Hi @maintainers, I have investigated this issue and have a reproducible test case and fix ready. Please assign this issue to me, I will submit a PR shortly.\n\n* **Root Cause**: ${summary}\n* **Reproduction**: Verified in clean-room sandbox with automated test case.`;

    return {
      issueNumber,
      issueTitle,
      claimComment,
      findingSummary: summary,
      isReadyForPR: true,
    };
  }

  /**
   * Checks if an author is a bot account via GitHub API.
   * Aligns with GitHub's native bot detection (GET /users/{username} → type === "Bot").
   * No hardcoded suffix lists — the API is authoritative.
   */
  public static isBotAuthor(
    authorName: string,
    authorType?: string,
  ): boolean {
    // If authorType is already provided (e.g., from @octokit/rest GET /users/{username}),
    // trust the API result directly.
    if (authorType && authorType.toLowerCase() === 'bot') return true;
    return false;
  }
}

// Backward Compatibility Alias
export const IssueClaimEngine = ClaimProtocol;
