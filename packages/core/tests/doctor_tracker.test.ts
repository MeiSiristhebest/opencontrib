import { describe, expect, it } from 'bun:test';
import { runDoctorAudit } from '../src/discovery/doctor.js';
import { analyzePrLifecycle, generateMaintainerReplyTemplate } from '../src/governance/pr-tracker.js';

describe('Doctor Audit & PR Lifecycle Tracker', () => {
  it('runs doctor audit successfully on host system', () => {
    const report = runDoctorAudit();
    expect(['HEALTHY', 'NEEDS_ATTENTION', 'DEGRADED']).toContain(report.overallHealth);
    expect(report.checks.length).toBeGreaterThan(3);
    expect(report.environment.os).toBeDefined();
  });

  it('correctly tracks merged PR state and recommends flywheel sync', () => {
    const status = analyzePrLifecycle({
      prNumber: 42,
      isOpen: false,
      isMerged: true,
    });
    expect(status.state).toBe('MERGED');
    expect(status.recommendedAction).toBe('CELEBRATE_AND_SYNC_FLYWHEEL');
  });

  it('correctly tracks open PR with changes requested and generates maintainer reply', () => {
    const status = analyzePrLifecycle({
      prNumber: 43,
      isOpen: true,
      isMerged: false,
      reviews: [{ author: 'maintainerA', state: 'CHANGES_REQUESTED' }],
    });
    expect(status.maintainerReviewState).toBe('CHANGES_REQUESTED');
    expect(status.recommendedAction).toBe('REPLY_AND_REPAIR');

    const reply = generateMaintainerReplyTemplate({
      maintainerName: 'maintainerA',
      feedbackSummary: 'Missing falsy test case',
      actionTaken: 'Added unit tests for false, 0, and empty string',
    });
    expect(reply).toContain('@maintainerA');
    expect(reply).toContain('Added unit tests');
  });
});
