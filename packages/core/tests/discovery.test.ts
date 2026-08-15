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

    // General discussion referencing PR numbers should not trigger a false-positive hard disqualification
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

    // A stale claim from 45 days ago with no active PR is considered abandoned and should NOT block new contributors
    expect(res.isQualified).toBe(true);
    expect(res.hasClaimant).toBe(false);
  });

  it('flags author-first-right if author expressed intent < 7 days ago', () => {
    const res = qualifyIssue({
      issueNumber: 103,
      issueTitle: 'Typo in error message',
      issueBody: 'Found a typo in logger. Happy to open a PR to fix this!',
      labels: ['documentation'],
      isOpen: true,
      assignees: [],
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days ago
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

  it('fails safe with isQualified=false when GitHub comments API encounters an error (Tri-State)', () => {
    const res = qualifyIssue({
      issueNumber: 105,
      issueTitle: 'Fix crash in parser',
      issueBody: 'Crash occurs when input is malformed.',
      labels: ['bug'],
      isOpen: true,
      assignees: [],
      createdAt: new Date().toISOString(),
      comments: [],
      commentsApiStatus: 'RATE_LIMITED',
    });

    expect(res.isQualified).toBe(false);
    expect(res.disqualifyReason).toContain('tri-state safety gate');
  });

  it('applies single feasibility penalty without double-deduction in scoring engine', () => {
    const input = {
      profile: {
        techStack: ['typescript'],
        focusAreas: ['compiler'],
      },
      issue: {
        title: 'fix(compiler): type inference failure in typescript',
        body: '```ts\nfunction f() {}\n```\nSteps to reproduce: run build',
        createdAt: new Date().toISOString(),
        labels: ['bug'],
      },
      feasibility: {
        level: 'likely_fixable' as const,
        scorePenalty: 30, // 30 point penalty
        scope: 'runtime_bug' as const,
        detectedRisks: ['linux_specific'],
        missingCapabilities: ['linux_surface'],
        mitigations: [],
        rationale: 'Environment mismatch',
      },
    };

    const scoring = scoreCandidateIssue(input);
    // Feasibility score = 100 - 30 = 70.
    // In weighted formula: 0.30 * 70 = 21 (a 9-point loss from perfect 30).
    // Adjusted score must equal rawScore without subtracting 30 again!
    expect(scoring.breakdown.feasibilityScore).toBe(70);
    expect(scoring.adjustedScore).toBe(scoring.rawScore);
  });

  it('calculates latest activity timestamp strictly using Math.max across all date sources', () => {
    const now = Date.now();
    const created = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
    const commentLatest = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
    const updatedNewer = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago (newest!)

    // Case 1: updatedAt is newer than latestCommentAt
    const maxTs1 = calculateLatestActivityTimestamp({
      createdAt: created,
      updatedAt: updatedNewer,
      latestCommentAt: commentLatest,
    });
    expect(maxTs1).toBe(new Date(updatedNewer).getTime());

    // Case 2: latestCommentAt is newer than updatedAt
    const commentNewer = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago
    const maxTs2 = calculateLatestActivityTimestamp({
      createdAt: created,
      updatedAt: updatedNewer,
      latestCommentAt: commentNewer,
    });
    expect(maxTs2).toBe(new Date(commentNewer).getTime());
  });

  it('builds canonical search aliases for C#, C++, and .NET without stripping syntax characters', () => {
    expect(getSearchAliasQuery('c#')).toBe('("c#" OR "csharp")');
    expect(getSearchAliasQuery('c++')).toBe('("c++" OR "cpp")');
    expect(getSearchAliasQuery('.net')).toBe('(".net" OR "dotnet")');
    expect(getSearchAliasQuery('f#')).toBe('("f#" OR "fsharp")');
    expect(getSearchAliasQuery('typescript')).toBe('"typescript"');
  });

  it('matches profile terms token-accurately and handles C# and word boundaries', () => {
    expect(matchesProfileTerm('Crash in C# worker runtime', 'c#')).toBe(true);
    expect(matchesProfileTerm('Crash in csharp worker runtime', 'c#')).toBe(true);
    expect(matchesProfileTerm('Building with .NET 8 runtime', '.net')).toBe(true);
    expect(matchesProfileTerm('Building with dotnet 8 runtime', '.net')).toBe(true);
    // Boundary check
    expect(matchesProfileTerm('Fix json parser and good algorithms', 'js')).toBe(false);
    expect(matchesProfileTerm('Fix json parser and good algorithms', 'go')).toBe(false);
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
    // All items should have rankScore and diversityPenalty
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
      },
    );

    expect(['impossible', 'likely_blocked']).toContain(assessment.level);
    expect(assessment.scorePenalty).toBeGreaterThanOrEqual(30);
    expect(assessment.detectedRisks).toContain('macos_specific');
  });
});
