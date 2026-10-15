/**
 * Context-Aware Collaboration Playbook & Synthesizer
 *
 * Pure domain logic: Determines the most respectful, effective, and ethically sound
 * collaboration strategy for a given issue, strictly preventing "issue poaching" (反摘桃子)
 * and synthesizing tailored, multi-lingual, and policy-compliant co-authoring communications.
 *
 * Domain layer: Zero I/O, zero global non-determinism.
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
  /** Repository governance policy (AI policy, requirements) */
  targetRepoPolicy?: {
    aiPolicy?: 'prohibited' | 'disclosure_required' | 'allowed';
    requiresAiDisclosure?: boolean;
    philosophy?: string;
  };
  /** Preferred or detected language for drafts ('auto' | 'en' | 'zh') */
  preferredLanguage?: 'auto' | 'en' | 'zh';
  /** Technical context for synthesis (e.g., test name, repro command) */
  technicalContext?: {
    reproTestSummary?: string;
    affectedComponent?: string;
  };
}

function detectLanguage(ctx: CollaborationContext): 'zh' | 'en' {
  if (ctx.preferredLanguage === 'zh') return 'zh';
  if (ctx.preferredLanguage === 'en') return 'en';
  // Auto-detect based on issue title characters
  if (ctx.issueTitle && /[\u4e00-\u9fa5]/.test(ctx.issueTitle)) {
    return 'zh';
  }
  return 'en';
}

function synthesizeSupportiveComment(
  author: string,
  lang: 'zh' | 'en',
  ctx: CollaborationContext,
): { commentDraft: string; aiPolicyNotice?: string } {
  const isAiProhibited = ctx.targetRepoPolicy?.aiPolicy === 'prohibited';
  const requiresAiDisclosure = ctx.targetRepoPolicy?.requiresAiDisclosure;
  const reproNote = ctx.technicalContext?.reproTestSummary
    ? ` (${ctx.technicalContext.reproTestSummary})`
    : '';

  let aiPolicyNotice: string | undefined;
  if (isAiProhibited) {
    aiPolicyNotice =
      'CAUTION: Target repository strictly prohibits automated or AI-generated comments (AI_POLICY.md). This draft is for HUMAN reference and manual adaptation only. Do NOT auto-post via bot.';
  }

  let commentDraft = '';
  if (lang === 'zh') {
    commentDraft = `你好 @${author}，非常精彩的发现！我在本地沙箱深入分析了这个问题，并构造了一份确定性的最小复现单测${reproNote}供你参考。如果你近期时间紧张或遇到环境配置阻碍，我很乐意协助起草 PR 并严格在提交中附加 \`Co-authored-by: @${author}\` 共同作者署名；如果你计划亲自推进，非常期待你的修复 PR！`;
    if (requiresAiDisclosure) {
      commentDraft += '\n\n*(注：本协助分析与单测整理遵循社区规范，由人工审校并在必要处声明 AI 辅助)*';
    }
  } else {
    commentDraft = `Hi @${author}, brilliant catch on this issue! I investigated this and constructed a minimal deterministic reproduction test locally${reproNote} in case it helps verify the fix. If you're busy or encounter environment constraints, I'd be glad to help draft the PR and will explicitly credit you via \`Co-authored-by: @${author}\`. Otherwise, looking forward to your PR!`;
    if (requiresAiDisclosure) {
      commentDraft += '\n\n*(Note: Prepared in compliance with repository AI disclosure policy; human reviewed)*';
    }
  }

  return { commentDraft, aiPolicyNotice };
}

/**
 * Calculates the exact collaboration playbook tailored to the issue context.
 */
export function deriveCollaborationPlaybook(
  ctx: CollaborationContext,
): CollaborationPlaybook {
  const author = ctx.authorLogin || 'the author';
  const lang = detectLanguage(ctx);

  // Playbook 1: Supportive Co-Authoring (Author wants to solve it / waiting for maintainer)
  if (ctx.authorFirstRightActive) {
    const { commentDraft, aiPolicyNotice } = synthesizeSupportiveComment(author, lang, ctx);

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
      commentDraft,
      language: lang,
      aiPolicyNotice,
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
      language: lang,
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
      language: lang,
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
    language: lang,
  };
}
