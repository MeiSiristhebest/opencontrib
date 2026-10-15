import { describe, expect, it } from 'bun:test';
import {
  extractDynamicCommunityProfile,
  detectCommunityGateFromContents,
} from '../src/governance/index.js';
import { evaluateIntentSignals } from '../src/domain/intent-evaluator.js';
import { deriveCollaborationPlaybook } from '../src/domain/collaboration-playbook.js';
import { qualifyIssue } from '../src/domain/qualification.js';

describe('Dynamic Governance Extractor & Declarative Intent Architecture', () => {
  it('dynamically extracts Astral-style AI prohibition policy and Minimal Core philosophy', () => {
    const files = [
      {
        path: '.github/AI_POLICY.md',
        content: `
# AI Policy
We do not accept AI-generated pull requests or comments.
Autonomous agents prohibited from opening pull requests without maintainer pre-approval.
`,
      },
      {
        path: 'AGENTS.md',
        content: `
# Architecture Guidelines
We adhere to a minimal core philosophy. Keep the core small and avoid bloat.
Extensions should live outside the core repository.
`,
      },
      {
        path: '.github/ISSUE_TEMPLATE/bug.yml',
        content: `
name: Bug Report
labels: ["status:needs-triage", "needs-decision", "type:bug"]
`,
      },
    ];

    const profile = extractDynamicCommunityProfile(files);
    expect(profile.aiPolicy).toBe('prohibited');
    expect(profile.philosophy).toBe('minimal_core');
    expect(profile.dynamicBlockingLabels).toContain('needs-decision');

    const gate = detectCommunityGateFromContents(files);
    expect(gate.hasGatingRules).toBe(true);
    expect(gate.aiPolicy).toBe('prohibited');
    expect(gate.philosophy).toBe('minimal_core');
    expect(gate.dynamicBlockingLabels).toContain('needs-decision');
    expect(gate.reasons.some((r) => r.includes('AI_POLICY.md'))).toBe(true);
  });

  it('dynamically extracts Bun-style test rigor and variant matrix requirements from REVIEW.md', () => {
    const files = [
      {
        path: 'REVIEW.md',
        content: `
# Bun PR Review Standards
Prove the test fails for the right reason: a test that passes both ways is worse than no test.
Variant matrix: tests must verify cross-platform reproduction across Linux and Windows.
`,
      },
    ];

    const profile = extractDynamicCommunityProfile(files);
    expect(profile.testRigor?.variantsRequired).toBe(true);

    const gate = detectCommunityGateFromContents(files);
    expect(gate.testRigor?.variantsRequired).toBe(true);
    expect(gate.reasons.some((r) => r.includes('REVIEW.md'))).toBe(true);
  });

  it('evaluates declarative multi-signal intent without rigid hardcoded regexes', () => {
    // English author intent offer
    const authorOffer = evaluateIntentSignals(
      'I can fix this and submit a PR shortly.',
      'author_intent',
    );
    expect(authorOffer.isMatch).toBe(true);
    expect(authorOffer.score).toBeGreaterThanOrEqual(80);

    // Chinese author intent offer
    const authorZh = evaluateIntentSignals(
      '这个问题我可以提个 PR 修复一下。',
      'author_intent',
    );
    expect(authorZh.isMatch).toBe(true);
    expect(authorZh.score).toBeGreaterThanOrEqual(80);

    // Bystander question must NOT match work claim
    const bystander = evaluateIntentSignals(
      'Can someone open a PR for this bug?',
      'work_claim',
    );
    expect(bystander.isMatch).toBe(false);

    // Request for help must NOT match author claim
    const helpCry = evaluateIntentSignals(
      'I need help opening a PR for this issue.',
      'author_intent',
    );
    expect(helpCry.isMatch).toBe(false);

    // Maintainer approval wait
    const waitingLgtm = evaluateIntentSignals(
      'Waiting on maintainer lgtm before pushing the branch.',
      'approval_wait',
    );
    expect(waitingLgtm.isMatch).toBe(true);
  });

  it('synthesizes adaptive Chinese and English collaboration drafts with AI policy alerts', () => {
    // 1. English issue in AI-prohibited repository (like uv / astral)
    const enPlaybook = deriveCollaborationPlaybook({
      isOpen: true,
      hasExistingPr: false,
      hasClaimant: false,
      authorFirstRightActive: true,
      authorLogin: 'astralDev',
      issueNumber: 1234,
      issueTitle: 'Path normalization fails on Windows UNC paths',
      targetRepoPolicy: {
        aiPolicy: 'prohibited',
      },
    });

    expect(enPlaybook.language).toBe('en');
    expect(enPlaybook.commentDraft).toContain('Hi @astralDev');
    expect(enPlaybook.coAuthorAttribution?.suggestedGitTrailer).toContain('Co-authored-by: @astralDev');
    expect(enPlaybook.aiPolicyNotice).toContain('CAUTION: Target repository strictly prohibits automated or AI-generated comments');

    // 2. Chinese issue with adaptive Chinese draft
    const zhPlaybook = deriveCollaborationPlaybook({
      isOpen: true,
      hasExistingPr: false,
      hasClaimant: false,
      authorFirstRightActive: true,
      authorLogin: 'chineseDev',
      issueNumber: 5678,
      issueTitle: '高并发场景下缓存锁竞争导致数据漂移',
      targetRepoPolicy: {
        aiPolicy: 'disclosure_required',
        requiresAiDisclosure: true,
      },
    });

    expect(zhPlaybook.language).toBe('zh');
    expect(zhPlaybook.commentDraft).toContain('你好 @chineseDev');
    expect(zhPlaybook.commentDraft).toContain('Co-authored-by: @chineseDev');
    expect(zhPlaybook.commentDraft).toContain('AI 辅助');
  });

  it('qualifyIssue enforces dynamic community blocking labels and anti-poaching config', () => {
    const resBlocked = qualifyIssue({
      issueNumber: 99,
      issueTitle: 'Proposal: revamp configuration parser',
      issueBody: 'Discussion on architecture.',
      labels: ['needs-decision'],
      isOpen: true,
      assignees: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      comments: [],
      now: Date.parse('2026-01-02T00:00:00.000Z'),
      communityPolicy: {
        hasGatingRules: true,
        requiresIssueApprovalBeforePr: true,
        autoClosesNewIssues: false,
        hasLgtmApprovalProtocol: false,
        restrictedTriageHours: false,
        reasons: [],
        suggestedContributorAction: 'wait',
        matchedKeywords: [],
        dynamicBlockingLabels: ['needs-decision'],
        antiPoachingConfig: {
          authorGracePeriodDays: 14, // Extended 14 days grace period
        },
      },
    });

    expect(resBlocked.isQualified).toBe(false);
    expect(resBlocked.disqualifyReason).toContain('needs-decision');
  });
});
