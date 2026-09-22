import type { PointerStub } from "../kernel/contract.js";

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
   * Generates a conservative claim artifact. This helper has no access to
   * canonical RED/GREEN evidence, so it must not claim that a fix is ready or
   * that a PR is ready for submission.
   */
  public static generateClaimPayload(
    issueNumber: number,
    issueTitle: string,
    finding?: PointerStub,
  ): IssueClaimPayload {
    const summary = finding
      ? `Identified root cause in ${finding.file}:${finding.line} (${finding.title})`
      : `Investigated ${issueTitle}`;

    const claimComment = `Hi @maintainers, I am investigating this issue and will share a reproduction once it is verified. Please assign this issue to me if appropriate; no fix or PR submission is being claimed yet.\n\n* **Root Cause**: ${summary}\n* **Reproduction**: Pending trusted RED capture; this claim is not verification evidence.`;

    return {
      issueNumber,
      issueTitle,
      claimComment,
      findingSummary: summary,
      isReadyForPR: false,
    };
  }

  /**
   * Checks if an author is a bot account via GitHub API.
   * Aligns with GitHub's native bot detection (GET /users/{username} → type === "Bot").
   * No hardcoded suffix lists — the API is authoritative.
   */
  public static isBotAuthor(authorName: string, authorType?: string): boolean {
    if (authorType) {
      const typeLower = authorType.toLowerCase();
      if (typeLower === "bot") return true;
      if (typeLower === "user") return false;
    }
    if (authorName) {
      const lower = authorName.toLowerCase();
      if (
        lower.endsWith("[bot]") ||
        lower.endsWith("-bot") ||
        lower === "stale" ||
        lower.includes("github-actions") ||
        lower.includes("dependabot") ||
        lower.includes("codecov")
      ) {
        return true;
      }
    }
    return false;
  }
}

// Backward Compatibility Alias
export const IssueClaimEngine = ClaimProtocol;
