import { describe, expect, it } from 'bun:test';
import { assessFeasibility, qualifyIssue } from '../src/discovery/index.js';

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
          body: 'I have opened a PR to address this: pull/204',
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
      comments: [],
    });

    expect(res.isQualified).toBe(false);
    expect(res.authorFirstRightActive).toBe(true);
    expect(res.track).toBe('fast_track');
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
