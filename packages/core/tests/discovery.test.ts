import { describe, expect, it } from 'bun:test';
import { assessFeasibility, qualifyIssue } from '../src/discovery/index.js';
import { scoreCandidateIssue, applyDiversityReranking } from '../src/discovery/scoring-engine.js';

describe('Discovery & Qualification Engine', () => {
  it('qualifies a clean open bug issue', () => {
    const res = qualifyIssue({
      issueNumber: 101,
      issueTitle: 'fix(parser): unhandled null in token reader',
      issueBody: 'When passing empty string, null dereference occurs.',
      labels: ['bug', 'help wanted'],
      isOpen: true,
      assignees: [],
      createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days ago
      comments: [],
    });

    expect(res.isQualified).toBe(true);
    expect(res.track).toBe('standard_track');
    expect(res.authorFirstRightActive).toBe(false);
  });

  it('disqualifies issue if another developer posted a PR link in comments', () => {
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
          body: 'I have opened a PR to address this: https://github.com/org/repo/pull/204',
          user: { login: 'devA' },
          created_at: new Date().toISOString(),
        },
      ],
    });

    expect(res.isQualified).toBe(false);
    expect(res.disqualifyReason).toContain('PR reference in comments');
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
          created_at: new Date().toISOString(),
        },
      ],
    });

    expect(res.isQualified).toBe(false);
    expect(res.hasClaimant).toBe(true);
    expect(res.authorFirstRightActive).toBe(false);
    expect(res.disqualifyReason).toContain('claimed by another contributor');
  });

  it('fails safe with isQualified=false when GitHub comments API is unavailable', () => {
    const res = qualifyIssue({
      issueNumber: 105,
      issueTitle: 'Fix crash in parser',
      issueBody: 'Crash occurs when input is malformed.',
      labels: ['bug'],
      isOpen: true,
      assignees: [],
      createdAt: new Date().toISOString(),
      comments: [],
      commentsApiStatus: 'API_UNAVAILABLE',
    });

    expect(res.isQualified).toBe(false);
    expect(res.disqualifyReason).toContain('tri-state safety gate');
  });

  it('uses word-boundary token matching to avoid substring false positives', () => {
    const scoring = scoreCandidateIssue({
      profile: {
        techStack: ['js', 'go'],
        focusAreas: ['tooling'],
      },
      issue: {
        title: 'Fix json parser and good algorithms',
        body: 'JSON serialization algorithm needs improvement.',
        createdAt: new Date().toISOString(),
        labels: ['bug'],
      },
      feasibility: {
        level: 'fully_feasible',
        scorePenalty: 0,
        scope: 'small_code_change',
        detectedRisks: [],
        missingCapabilities: [],
        mitigations: [],
        rationale: 'Clean',
      },
    });

    // Neither 'js' (matching 'json') nor 'go' (matching 'good') should match because of word boundaries
    expect(scoring.matchedSignals.techStack).not.toContain('js');
    expect(scoring.matchedSignals.techStack).not.toContain('go');
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
    expect(reranked[0].finalScore).toBe(90); // First occurrence: 90 - 0 = 90
    // Second occurrence of orgA/repoA: 88 - 4 = 84
    // orgB/repoB: 86 - 0 = 86 -> ranks 2nd!
    expect(reranked[1].item.repoFullName).toBe('orgB/repoB');
    expect(reranked[1].finalScore).toBe(86);
    expect(reranked[2].item.repoFullName).toBe('orgA/repoA');
    expect(reranked[2].finalScore).toBe(84);
  });

  it('penalizes macOS-specific issues when running on non-macOS platforms', () => {
    const assessment = assessFeasibility(
      'Kernel panic on Apple Silicon M2 under macOS 14',
      'Requires darwin native build toolchain and arm64 Mac.',
      ['macos', 'crash'],
      {
        os: 'win32',
        hasWsl: true,
        hasDocker: false,
        hasHyperV: false,
        toolchains: { node: true, bun: true, python: true, go: false, rust: false },
      },
    );

    expect(assessment.level).toBe('likely_blocked');
    expect(assessment.scorePenalty).toBeGreaterThanOrEqual(30);
    expect(assessment.missingCapabilities).toContain('macos_surface');
  });
});
