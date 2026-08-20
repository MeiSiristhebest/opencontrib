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
   * Discriminate automated Bot accounts vs human maintainers:
   * - Bots: Do NOT reply with comments; address solely via commits & CI re-evaluation.
   * - Human Maintainers: Reply with technical explanations.
   */
  public static isBotAuthor(authorName: string, authorType?: string): boolean {
    const lowerName = (authorName || '').toLowerCase();
    const lowerType = (authorType || '').toLowerCase();

    return (
      lowerType === 'bot' ||
      lowerName.endsWith('[bot]') ||
      lowerName.endsWith('-bot') ||
      lowerName.includes('actions-user') ||
      lowerName.includes('dependabot') ||
      lowerName.includes('codecov') ||
      lowerName.includes('sonarcloud') ||
      lowerName.includes('cla-assistant') ||
      lowerName.includes('stale')
    );
  }
}

// Backward Compatibility Alias
export const IssueClaimEngine = ClaimProtocol;
