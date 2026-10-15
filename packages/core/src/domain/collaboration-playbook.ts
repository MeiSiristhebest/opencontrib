/**
 * Collaboration Playbook Engine
 *
 * Pure domain logic: Determines the most respectful, effective, and ethically sound
 * collaboration strategy for a given issue, strictly preventing "issue poaching" (摘桃子)
 * and providing actionable co-authoring workflows.
 */

import type { CollaborationPlaybook } from '../contracts/schemas.js';

export interface CollaborationContext {
  isOpen: boolean;
  hasExistingPr: boolean;
  hasClaimant: boolean;
  claimantDetails?: string;
  authorFirstRightActive: boolean;
  authorLogin?: string;
  issueNumber?: number;
  issueTitle?: string;
  hasVariantGap?: boolean;
}

/**
 * Calculates the exact collaboration playbook tailored to the issue context.
 */
export function deriveCollaborationPlaybook(
  ctx: CollaborationContext,
): CollaborationPlaybook {
  const author = ctx.authorLogin || 'the author';

  // Playbook 1: Supportive Co-Authoring (Author wants to solve it / waiting for maintainer)
  if (ctx.authorFirstRightActive) {
    return {
      playbook: 'supportive_coauthor',
      title: 'Playbook 1: 礼貌助攻与共同作者模式 (Supportive Co-Authoring)',
      rationale: `原作者 @${author} 已明确表达修复意向或正在等待批准。社区严禁绕过原作者擅自提交竞争性 PR（反摘桃子保护）。`,
      actionableSteps: [
        `切勿直接向仓库提交独立 PR，尊重 @${author} 的原创发现权。`,
        '在本地沙箱中构造确定性的可复现单测（RED Test 用例），确保问题真实、机理明晰。',
        `在 Issue 下友善留言，分享复现测试用例协助 @${author}，并询问是否需要协助起草。`,
        `若进行联合协助，必须在 Git commit 尾部附加 Co-authored-by 署名。`,
      ],
      coAuthorAttribution: {
        authorLogin: author,
        suggestedGitTrailer: `Co-authored-by: @${author} <${author}@users.noreply.github.com>`,
      },
      commentDraft: `Hi @${author}, brilliant catch on this issue! I investigated this and constructed a minimal deterministic reproduction test locally in case it helps verify the fix. If you're busy or encounter environment constraints, I'd be glad to help draft the PR and will explicitly credit you via \`Co-authored-by: @${author}\`. Otherwise, looking forward to your PR!`,
    };
  }

  // Playbook 2: Graceful Watchdog (Third-party contributor claimed)
  if (ctx.hasClaimant) {
    const claimant = ctx.claimantDetails || 'another contributor';
    return {
      playbook: 'graceful_watchdog',
      title: 'Playbook 2: 宽限期守护与退避模式 (Graceful Watchdog)',
      rationale: `该 Issue 已被认领 (${claimant})。根据社区礼仪，遵守 30 天保护期，避免重复劳动冲突。`,
      actionableSteps: [
        '将该 Issue 归入观察池，暂不开展本地改动。',
        '若认领人超过 30 天无活跃 PR 或明确表示放弃，系统才可重新评估。',
      ],
    };
  }

  // Playbook 4: Sibling Variant Extension (PR already exists, but lacks multi-platform variants)
  if (ctx.hasExistingPr && ctx.hasVariantGap) {
    return {
      playbook: 'variant_extension',
      title: 'Playbook 4: 跨平台变体补全模式 (Sibling Variant Extension)',
      rationale: '现有 PR 已在进行中，但根据顶流社区准则（如 Bun REVIEW.md），需补齐多平台/边界变体矩阵。',
      actionableSteps: [
        '不与正在进行的主 PR 竞争，避免造成评审分裂。',
        '在原 PR 下以友好 Review 形式分享变体测试用例，或待其合并后提交后续变体 PR。',
      ],
    };
  }

  // Playbook 3: Autonomous Strike (Unclaimed, open, genuine defect)
  return {
    playbook: 'autonomous_strike',
    title: 'Playbook 3: 独占未认领真实缺陷攻坚模式 (Autonomous Strike)',
    rationale: '该 Issue 完全处于空闲开放状态，无主无认领，可遵循目标仓库规范全速执行标准贡献流程。',
    actionableSteps: [
      '在本地沙箱完成 RED 测试（证明因正确原因失败）。',
      '产出 30~50 行极简高内聚补丁（遵循 Minimal Core 哲学）。',
      '确保无无关格式化或防御性噪音，按仓库指引提交高质量 PR。',
    ],
  };
}
