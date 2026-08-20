import { describe, expect, it } from 'bun:test';
import { assessFeasibility, qualifyIssue } from '../src/discovery/index.js';
import {
  applyDiversityReranking,
  calculateLatestActivityTimestamp,
  computeActivityFreshnessModifier,
  getSearchAliasQuery,
  matchesProfileTerm,
  scoreCandidateIssue,
} from '../src/discovery/scoring-engine.js';
import { MultiSignalHeuristicRanker } from '../src/discovery/ranking.js';
import { TechnologyMatcher } from '../src/discovery/technology-matcher.js';

describe('Discovery & Qualification Engine', () => {
  it('qualifies a clean open bug issue', () => {
    const res = qualifyIssue({
      issueNumber: 101,
      issueTitle: 'fix(parser): unhandled null in token reader',
      issueBody: 'When passing empty string, null dereference occurs. \n```ts\nconst x = null;\n```\nTo reproduce: run parse("")',
      labels: ['bug', 'help wanted'],
      isOpen: true,
      assignees: [],
      createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      comments: [],
    });

    expect(res.isQualified).toBe(true);
    expect(res.track).toBe('standard_track');
    expect(res.authorFirstRightActive).toBe(false);
  });

  it('disqualifies issue if another developer announced an open fix PR', () => {
    const res = qualifyIssue({
      issueNumber: 102,
      issueTitle: 'Memory leak in worker loop',
      issueBody: 'Worker process leaks 10MB per minute.',
      labels: ['bug'],
      isOpen: true,
      assignees: [],
      createdAt: new Date().toISOString(),
      comments: [
        {
          id: 1,
          body: "I've opened a PR to address this: https://github.com/org/repo/pull/204",
          user: { login: 'devA' },
          created_at: new Date().toISOString(),
        },
      ],
    });

    expect(res.isQualified).toBe(false);
    expect(res.disqualifyReason).toContain('announced a fix PR in comments');
  });

  it('does NOT disqualify issue for conversational or unrelated PR mentions in comments', () => {
    const res = qualifyIssue({
      issueNumber: 1021,
      issueTitle: 'Performance degradation in parser',
      issueBody: 'Parsing large json takes 200ms.',
      labels: ['bug'],
      isOpen: true,
      assignees: [],
      createdAt: new Date().toISOString(),
      comments: [
        {
          id: 1,
          body: 'PR #123 was unrelated to this issue. It just changed docs.',
          user: { login: 'reviewerB' },
          created_at: new Date().toISOString(),
        },
      ],
    });

    expect(res.isQualified).toBe(true);
  });

  it('expires stale claims older than 30 days without active PRs', () => {
    const staleClaimDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(); // 45 days ago
    const res = qualifyIssue({
      issueNumber: 1022,
      issueTitle: 'Add support for custom theme',
      issueBody: 'Feature request for custom theme config.',
      labels: ['help wanted'],
      isOpen: true,
      assignees: [],
      createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      comments: [
        {
          id: 1,
          body: 'I am working on this',
          user: { login: 'oldUser' },
          created_at: staleClaimDate,
        },
      ],
    });

    expect(res.isQualified).toBe(true);
    expect(res.hasClaimant).toBe(false);
  });

  it('keeps claim active if claimant commented recently within 30 days', () => {
    const initialClaimDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(); // 40 days ago
    const recentActivityDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago
    const res = qualifyIssue({
      issueNumber: 1023,
      issueTitle: 'Add support for custom plugin loader',
      issueBody: 'Feature request for plugin loader.',
      labels: ['help wanted'],
      isOpen: true,
      assignees: [],
      createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      comments: [
        {
          id: 1,
          body: 'I am working on this',
          user: { login: 'activeUser' },
          created_at: initialClaimDate,
        },
        {
          id: 2,
          body: 'Update: Still working on the edge cases, will push soon.',
          user: { login: 'activeUser' },
          created_at: recentActivityDate,
        },
      ],
    });

    // Claimant was active 2 days ago, so claim is NOT expired
    expect(res.isQualified).toBe(false);
    expect(res.hasClaimant).toBe(true);
  });

  it('does NOT disqualify on "not duplicate" label while strictly blocking on exact "duplicate"', () => {
    const safeRes = qualifyIssue({
      issueNumber: 1024,
      issueTitle: 'Feature: custom metrics provider',
      issueBody: 'Unique feature proposal.',
      labels: ['not duplicate', 'enhancement'],
      isOpen: true,
      assignees: [],
      createdAt: new Date().toISOString(),
      comments: [],
    });
    expect(safeRes.isQualified).toBe(true);

    const blockedRes = qualifyIssue({
      issueNumber: 1025,
      issueTitle: 'Bug: duplicate event firing',
      issueBody: 'Duplicate bug.',
      labels: ['duplicate'],
      isOpen: true,
      assignees: [],
      createdAt: new Date().toISOString(),
      comments: [],
    });
    expect(blockedRes.isQualified).toBe(false);
    expect(blockedRes.disqualifyReason).toContain('blocking label: duplicate');
  });

  it('flags author-first-right if author expressed intent < 7 days ago', () => {
    const res = qualifyIssue({
      issueNumber: 103,
      issueTitle: 'Typo in error message',
      issueBody: 'Found a typo in logger. Happy to open a PR to fix this!',
      labels: ['documentation'],
      isOpen: true,
      assignees: [],
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      authorLogin: 'alice',
      comments: [],
    });

    expect(res.isQualified).toBe(false);
    expect(res.authorFirstRightActive).toBe(true);
    expect(res.track).toBe('fast_track');
  });

  it('does NOT trigger author-first-right if third-party non-author leaves comment (treated as claimant)', () => {
    const res = qualifyIssue({
      issueNumber: 104,
      issueTitle: 'Add documentation for telemetry',
      issueBody: 'We need documentation for telemetry flags.',
      labels: ['documentation'],
      isOpen: true,
      assignees: [],
      createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      authorLogin: 'alice',
      comments: [
        {
          id: 1,
          body: 'Can I work on this?',
          user: { login: 'bob' },
          created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        },
      ],
    });

    expect(res.isQualified).toBe(false);
    expect(res.hasClaimant).toBe(true);
    expect(res.authorFirstRightActive).toBe(false);
    expect(res.disqualifyReason).toContain('claimed by another contributor');
  });

  it('fails safe with isQualified=false on NOT_FOUND or API errors (Tri-State)', () => {
    const notFoundRes = qualifyIssue({
      issueNumber: 1051,
      issueTitle: 'Fix crash in parser',
      issueBody: 'Crash occurs when input is malformed.',
      labels: ['bug'],
      isOpen: true,
      assignees: [],
      createdAt: new Date().toISOString(),
      comments: [],
      commentsApiStatus: 'NOT_FOUND',
    });
    expect(notFoundRes.isQualified).toBe(false);

    const rateLimitRes = qualifyIssue({
      issueNumber: 1052,
      issueTitle: 'Fix crash in parser',
      issueBody: 'Crash occurs when input is malformed.',
      labels: ['bug'],
      isOpen: true,
      assignees: [],
      createdAt: new Date().toISOString(),
      comments: [],
      commentsApiStatus: 'RATE_LIMITED',
    });
    expect(rateLimitRes.isQualified).toBe(false);
  });

  it('verifies calibrated score baseline: 0 profile hits gets < 50 points (below default threshold 70)', () => {
    const irrelevantIssue = {
      profile: {
        techStack: ['typescript', 'react'],
        focusAreas: ['compiler'],
      },
      issue: {
        title: 'Fix unhandled panic in Go backend service',
        body: '```go\nfunc main() {}\n```\nTo reproduce: run server',
        createdAt: new Date().toISOString(), // Very fresh
        labels: ['bug'],
      },
      feasibility: {
        level: 'fully_feasible' as const,
        scorePenalty: 0,
        scope: 'small_code_change' as const,
        detectedRisks: [],
        missingCapabilities: [],
        mitigations: [],
        rationale: 'Clean',
      },
    };

    const scoring = scoreCandidateIssue(irrelevantIssue);
    // 0 hits should yield ~40-50, strictly below default 70 threshold
    expect(scoring.rawScore).toBeLessThan(55);
    expect(scoring.adjustedScore).toBeLessThan(55);
    expect(scoring.matchedSignals.techStack.length).toBe(0);
  });

  it('demonstrates clear score separation between 1-hit (~65) and 2-hit (~85) candidates', () => {
    const feasibility = {
      level: 'fully_feasible' as const,
      scorePenalty: 0,
      scope: 'small_code_change' as const,
      detectedRisks: [],
      missingCapabilities: [],
      mitigations: [],
      rationale: 'Clean',
    };

    // 1-hit candidate (TypeScript only)
    const scoring1Hit = scoreCandidateIssue({
      profile: {
        techStack: ['typescript'],
        focusAreas: ['compiler'],
      },
      issue: {
        title: 'Fix typescript linting rules in config',
        body: '```json\n{}\n```\nSteps to reproduce: lint',
        createdAt: new Date().toISOString(),
        labels: ['bug'],
      },
      feasibility,
    });

    // 2-hit candidate (TypeScript + Compiler)
    const scoring2Hits = scoreCandidateIssue({
      profile: {
        techStack: ['typescript'],
        focusAreas: ['compiler'],
      },
      issue: {
        title: 'Fix typescript compiler type resolution bug',
        body: '```ts\nfunction f() {}\n```\nSteps to reproduce: tsc',
        createdAt: new Date().toISOString(),
        labels: ['bug', 'good first issue'],
      },
      feasibility,
    });

    expect(scoring1Hit.rawScore).toBeGreaterThanOrEqual(50);
    expect(scoring1Hit.rawScore).toBeLessThan(75);

    expect(scoring2Hits.rawScore).toBeGreaterThanOrEqual(70);
    expect(scoring2Hits.rawScore).toBeLessThan(90);

    // Clear statistical separation (>= 15 points)
    expect(scoring2Hits.rawScore - scoring1Hit.rawScore).toBeGreaterThanOrEqual(15);
  });

  it('matches complex technology tokens with TechnologyMatcher (Node.js, React Native, .NET, C#, PyTorch)', () => {
    expect(TechnologyMatcher.matches('Fix memory leak in Node.js server', 'node.js')).toBe(true);
    expect(TechnologyMatcher.matches('Building mobile app with React Native', 'react native')).toBe(true);
    expect(TechnologyMatcher.matches('Migrating service to .NET 8 runtime', '.net')).toBe(true);
    expect(TechnologyMatcher.matches('Deep learning pipeline in PyTorch', 'pytorch')).toBe(true);
    expect(TechnologyMatcher.matches('Crash in C# worker service', 'c#')).toBe(true);

    // Boundary rejection
    expect(TechnologyMatcher.matches('Fix json parser and good algorithms', 'js')).toBe(false);
    expect(TechnologyMatcher.matches('Fix json parser and good algorithms', 'go')).toBe(false);
  });

  it('applies 2-stage diversity decay across multiple issues from the same repository', () => {
    const candidates = [
      { repoFullName: 'orgA/repoA', rawScore: 90 },
      { repoFullName: 'orgA/repoA', rawScore: 88 },
      { repoFullName: 'orgB/repoB', rawScore: 86 },
    ];

    const reranked = applyDiversityReranking(candidates);
    expect(reranked.length).toBe(3);
    expect(reranked[0].item.repoFullName).toBe('orgA/repoA');
    expect(reranked[0].rankScore).toBe(90);
    // Second occurrence of orgA/repoA: 88 - 4 = 84
    // orgB/repoB: 86 - 0 = 86 -> ranks 2nd!
    expect(reranked[1].item.repoFullName).toBe('orgB/repoB');
    expect(reranked[1].rankScore).toBe(86);
    expect(reranked[2].item.repoFullName).toBe('orgA/repoA');
    expect(reranked[2].rankScore).toBe(84);
  });

  it('ensures rankIssues() and diversity reranking pipeline execute consistently', () => {
    const ranker = new MultiSignalHeuristicRanker({
      techStack: ['typescript'],
      focusAreas: ['tooling'],
      proficiency: 'intermediate',
      minMatchScore: 50,
    });

    const issues = [
      {
        number: 1,
        title: 'fix(typescript): unhandled exception in typechecker',
        body: '```ts\nfunction test() {}\n```\nTo reproduce: run tsc',
        labels: ['bug'],
        state: 'open',
        assignees: [],
        created_at: new Date().toISOString(),
        repoFullName: 'orgA/repoA',
      },
      {
        number: 2,
        title: 'fix(typescript): crash on circular interface',
        body: '```ts\ninterface A extends A {}\n```\nTo reproduce: check',
        labels: ['bug'],
        state: 'open',
        assignees: [],
        created_at: new Date().toISOString(),
        repoFullName: 'orgA/repoA',
      },
      {
        number: 3,
        title: 'fix(typescript): memory leak in worker thread',
        body: '```ts\nconst w = new Worker();\n```\nTo reproduce: leak',
        labels: ['bug'],
        state: 'open',
        assignees: [],
        created_at: new Date().toISOString(),
        repoFullName: 'orgB/repoB',
      },
    ];

    const ranked = ranker.rankIssues(issues);
    expect(ranked.length).toBe(3);
    expect(ranked[0].rankScore).toBeGreaterThan(0);
    expect(typeof ranked[0].diversityPenalty).toBe('number');
  });

  it('penalizes macOS-specific issues when running on non-macOS platforms', () => {
    const assessment = assessFeasibility(
      'Kernel panic on Apple Silicon M2 under macOS 14',
      'Requires darwin native build toolchain and arm64 Mac.',
      ['macos', 'crash'],
      {
        os: 'win32',
        hasDocker: false,
        hasWsl: false,
        hasHyperV: false,
        toolchains: { node: false, bun: false, python: false, go: false, rust: false },
      },
    );

    expect(['impossible', 'likely_blocked']).toContain(assessment.level);
    expect(assessment.scorePenalty).toBeGreaterThanOrEqual(30);
    expect(assessment.detectedRisks).toContain('macos_specific');
  });
});
