import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { detectCommunityGate } from '../src/governance/community-gate.js';

describe('Community Gate Detector', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('detects auto-close and lgtmi approval requirements from CONTRIBUTING.md', async () => {
    const contributingContent = `
# Contributing Guidelines

## Contribution Gate
All issues and PRs from new contributors are auto-closed by default.
Maintainers review auto-closed issues daily and reopen worthwhile ones.
Approval happens through maintainer replies on issues:
- \`lgtmi\`: your future issues will not be auto-closed
- \`lgtm\`: your future issues and PRs will not be auto-closed
`;

    fs.writeFileSync(path.join(tmpDir, 'CONTRIBUTING.md'), contributingContent, 'utf8');

    const gate = await detectCommunityGate(tmpDir);

    expect(gate.hasGatingRules).toBe(true);
    expect(gate.autoClosesNewIssues).toBe(true);
    expect(gate.hasLgtmApprovalProtocol).toBe(true);
    expect(gate.requiresIssueApprovalBeforePr).toBe(true);
    expect(gate.suggestedContributorAction).toContain('PAUSE pipeline');
  });

  it('detects weekend restricted triage hours', async () => {
    const contributingContent = `
# Contributing
Issues submitted Friday through Sunday are not guaranteed to be reviewed until the next working week.
`;

    fs.writeFileSync(path.join(tmpDir, 'CONTRIBUTING.md'), contributingContent, 'utf8');

    const gate = await detectCommunityGate(tmpDir);

    expect(gate.restrictedTriageHours).toBe(true);
    expect(gate.reasons.some((r) => r.includes('Weekend'))).toBe(true);
  });

  it('returns permissive policy when no governance files exist', async () => {
    const gate = await detectCommunityGate(tmpDir);

    expect(gate.hasGatingRules).toBe(false);
    expect(gate.requiresIssueApprovalBeforePr).toBe(false);
    expect(gate.autoClosesNewIssues).toBe(false);
  });
});
