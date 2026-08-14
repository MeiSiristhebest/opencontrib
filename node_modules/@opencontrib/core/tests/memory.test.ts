import { describe, expect, it } from 'bun:test';
import { ProfileFlywheel, RepoMemoryLedger } from '../src/index.js';

describe('Memory & Profile Flywheel Engine', () => {
  it('records failure and success signals in RepoMemoryLedger', () => {
    const memory = new RepoMemoryLedger();
    const testRepo = 'test-org/test-repo';

    memory.recordFailure(testRepo, 'Test failed on Node 18', 'Jest exit code 1');
    const entry = memory.getMemory(testRepo);

    expect(entry.pastFailures.length).toBeGreaterThan(0);
    expect(entry.pastFailures[entry.pastFailures.length - 1].reason).toBe('Test failed on Node 18');

    memory.recordSuccess(testRepo, {
      prUrl: 'https://github.com/test-org/test-repo/pull/1',
      title: 'fix: resolve memory leak',
      prNumber: 1,
      issueNumber: 10,
    });

    const updated = memory.getMemory(testRepo);
    expect(updated.successfulContributions.length).toBeGreaterThan(0);
    expect(updated.successfulContributions[0].title).toBe('fix: resolve memory leak');
  });

  it('renders dynamic profile markdown and SVG badge in ProfileFlywheel', () => {
    const flywheel = new ProfileFlywheel();
    const testRecords = [
      {
        id: '1',
        repoFullName: 'vercel/next.js',
        issueNumber: 12345,
        issueTitle: 'Memory leak in dev server',
        prNumber: 12346,
        prUrl: 'https://github.com/vercel/next.js/pull/12346',
        status: 'merged' as const,
        submittedAt: '2026-08-15T00:00:00Z',
        mergedAt: '2026-08-15T01:00:00Z',
        diffStat: '3 files changed, +45 -12',
        evidenceSummary: '20/20 stress loop clean, lsof clean',
      },
    ];

    const markdown = flywheel.renderProfileMarkdown(testRecords);
    expect(markdown).toContain('vercel/next.js');
    expect(markdown).toContain('🟣 **Merged**');
    expect(markdown).toContain('START_OPENCONTRIB_SECTION');

    const svg = flywheel.renderBadgeSvg(testRecords);
    expect(svg).toContain('<svg');
    expect(svg).toContain('1 Merged');
  });
});
