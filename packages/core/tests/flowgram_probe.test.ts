import { describe, expect, it } from 'bun:test';
import {
  auditGovernance,
  detectSystemCapabilities,
  assessFeasibility,
  renderMasterPrTemplate,
  RepoMemoryLedger,
  ProfileFlywheel,
} from '../src/index.js';

describe('Proactive Probe End-to-End Test for bytedance/flowgram.ai', () => {
  it('performs full proactive workflow on real flowgram.ai manifests', () => {
    // 1. Feasibility Assessment
    const capabilities = detectSystemCapabilities();
    const feasibility = assessFeasibility(
      'ci: upgrade actions/checkout and actions/setup-node to v4',
      'Upgrade deprecated GitHub Actions in CI workflows to v4 for Node 20 LTS compatibility',
      ['ci', 'dx', 'tooling'],
      capabilities
    );
    expect(feasibility.level).toBe('fully_feasible');
    expect(feasibility.scorePenalty).toBeLessThanOrEqual(5);

    // 2. Diff Construction & Governance Audit
    const diff = `
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -10,2 +10,2 @@ jobs:
-      - uses: actions/checkout@v3
+      - uses: actions/checkout@v4
         with:
@@ -20,2 +20,2 @@ jobs:
-      - uses: actions/setup-node@v3
+      - uses: actions/setup-node@v4
         with:
-          node-version: 18
+          node-version: 20
--- a/.github/workflows/common-pr-checks.yml
+++ b/.github/workflows/common-pr-checks.yml
@@ -11,2 +11,2 @@ jobs:
-      - uses: actions/checkout@v3
+      - uses: actions/checkout@v4
@@ -18,2 +18,2 @@ jobs:
-      - uses: actions/setup-node@v3
+      - uses: actions/setup-node@v4
`;

    const prBody = `
### Motivation
Upgrade deprecated \`actions/checkout@v3\` and \`actions/setup-node@v3\` in CI workflows to \`v4\`.

### Key Changes
- Upgrade \`actions/checkout\` to \`v4\` in \`ci.yml\` and \`common-pr-checks.yml\`
- Upgrade \`actions/setup-node\` to \`v4\` aligned with Node 20 LTS

### Verification Plan
- Tested GitHub Actions YAML workflow schema
- Verified Rush build and install scripts syntax
`;

    const audit = auditGovernance({
      diffText: diff,
      prBodyText: prBody,
      lineCount: 14,
      confidenceBreakdown: {
        rootCause: 95,
        implementation: 95,
        regression: 90,
        defensiveCoverage: 90,
        testCoverage: 90,
        styleMatch: 95,
        securityAudit: 95,
      },
      humanApproved: true,
    });

    expect(audit.isGatedPassed).toBe(true);
    expect(audit.antiAiCheckPassed).toBe(true);
    expect(audit.rfcGatePassed).toBe(true);
    expect(audit.overallScore).toBeGreaterThanOrEqual(90);

    // 3. Render Master PR Template with ByteDance / CloudWeGo formatting & DCO
    const renderedPr = renderMasterPrTemplate({
      issueNumber: 0,
      problemSummary: 'Upgrade deprecated actions/checkout and actions/setup-node to v4 across CI workflows',
      rootCause: 'Workflows were using deprecated v3 GitHub Actions which are transitioning to Node 20 runtime runners.',
      keyChanges: [
        'Upgrade actions/checkout from v3 to v4 in .github/workflows/ci.yml and common-pr-checks.yml',
        'Upgrade actions/setup-node from v3 to v4',
      ],
      reproductionCommand: 'act -j build (or push to branch for CI)',
      verificationCommand: 'rush check && rush lint',
      testCount: 48,
      dcoAuthorName: 'Mei',
      dcoAuthorEmail: 'mei@example.com',
      conditionalAiRequired: false,
    });

    expect(renderedPr).toContain('Mei <mei@example.com>');
    expect(renderedPr).toContain('Motivation');
    expect(renderedPr).not.toContain('I have carefully analyzed');

    // 4. Memory & Flywheel Sync
    const memory = new RepoMemoryLedger();
    memory.recordSuccess('bytedance/flowgram.ai', {
      title: 'ci: upgrade checkout and setup-node to v4',
      prUrl: 'https://github.com/bytedance/flowgram.ai/pull/999',
    });

    const flywheel = new ProfileFlywheel();
    flywheel.saveRecord({
      id: 'bytedance/flowgram.ai#999',
      repoFullName: 'bytedance/flowgram.ai',
      issueTitle: 'ci: upgrade checkout and setup-node to v4',
      prUrl: 'https://github.com/bytedance/flowgram.ai/pull/999',
      status: 'submitted',
      submittedAt: new Date().toISOString(),
      diffStat: '+14 -14 (2 files)',
      evidenceSummary: 'Passed all CI schema checks, 0 AI smell',
    });

    const markdown = flywheel.renderProfileMarkdown();
    expect(markdown).toContain('bytedance/flowgram.ai');
  });
});
