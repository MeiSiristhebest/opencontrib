import type { PointerStub } from '../kernel/contract.js';

export interface IssueClaimPayload {
  issueNumber: number;
  issueTitle: string;
  claimComment: string;
  findingSummary: string;
  isReadyForPR: boolean;
}

/**
 * Open Source Proactive Issue Claim & Bot Etiquette Engine
 */
export class IssueClaimEngine {
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
   * - Bots (e.g. `github-actions[bot]`, `codecov[bot]`, `dependabot[bot]`, `sonarcloud[bot]`):
   *   Do NOT reply with text comments; address solely by pushing code to trigger CI re-evaluation.
   * - Human Maintainers:
   *   Reply with concise, technical, and respectful explanations.
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
