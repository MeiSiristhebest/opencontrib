import { describe, expect, it } from 'bun:test';
import { ContributionStateMachine } from '../src/orchestration/state-machine.js';
import { ContextAssembler } from '../src/discovery/context-assembler.js';
import { HybridIssueRanker } from '../src/discovery/ranking.js';

describe('Intelligence & Orchestration Upgrades', () => {
  it('manages pipeline state machine transitions and execution policy checks', () => {
    const sm = new ContributionStateMachine({
      allowRealPr: false,
      minConfidenceScore: 90,
    });

    expect(sm.getState().stage).toBe('IDLE');
    sm.transition('DISCOVERY', 'Scouting opportunities');
    expect(sm.getState().stage).toBe('DISCOVERY');

    sm.setReproductionCaptured(true);
    sm.setConfidenceScore(95);

    // Should be blocked because allowRealPr is false in policy
    const check = sm.canProceedToSubmission();
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain('Policy forbids real PR');
  });

  it('assembles multi-dimensional context combining problem, repo, memory, and environment', () => {
    const assembler = new ContextAssembler();
    const ctx = assembler.assemble({
      repoFullName: 'bytedance/flowgram.ai',
      issueNumber: 1160,
      issueTitle: 'createShortCache falsy bypass',
      issueBody: 'ShortCache evaluates if (cache), bypassing false / 0 values.',
      primaryLanguage: 'TypeScript',
      packageManifest: '{"name": "flowgram", "scripts": {"test": "vitest"}}',
    });

    expect(ctx.problemContext.repoFullName).toBe('bytedance/flowgram.ai');
    expect(ctx.environmentContext.os).toBeDefined();
    expect(ctx.repoContext.testCommandHint).toContain('vitest');

    const formattedPrompt = assembler.formatContextPrompt(ctx);
    expect(formattedPrompt).toContain('# Assembled OSS Contribution Context');
    expect(formattedPrompt).toContain('createShortCache falsy bypass');
  });

  it('ranks issues with hybrid profile matching, feasibility, and real linked PR gates', () => {
    const ranker = new HybridIssueRanker({
      techStack: ['typescript', 'react'],
      focusAreas: ['tooling', 'dx'],
      proficiency: 'intermediate',
      os: 'windows',
      hasDocker: false,
    });

    const issues = [
      {
        number: 101,
        title: 'Fix React TypeScript component state leak',
        body: 'In React components with TypeScript, memory leak occurs on unmount.',
        htmlUrl: 'https://github.com/org/repo/issues/101',
        labels: [{ name: 'bug' }, { name: 'good first issue' }],
        assignee: null,
        commentsCount: 0,
        createdAt: '2026-08-01T00:00:00Z',
      },
      {
        number: 102,
        title: 'macOS specific Darwin kernel panic',
        body: 'Only happens on macOS Darwin kernel.',
        htmlUrl: 'https://github.com/org/repo/issues/102',
        labels: [{ name: 'macos' }],
        assignee: null,
        commentsCount: 0,
        createdAt: '2026-08-01T00:00:00Z',
      },
    ];

    const ranked = ranker.rankIssues(issues, 'org/repo');
    expect(ranked.length).toBe(2);
    expect(ranked[0].issueNumber).toBe(101); // Issue 101 should rank highest
    expect(ranked[0].matchedKeywords).toContain('typescript');
    expect(ranked[0].matchedKeywords).toContain('react');
    expect(ranked[0].finalScore).toBeGreaterThan(ranked[1].finalScore);
  });
});
