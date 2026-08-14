import { describe, expect, it } from 'bun:test';
import { buildPrDescription } from '../src/governance/template-merger.js';

describe('Native Template Merger & Fallback', () => {
  it('merges PR data into target repository native template', () => {
    const nativeTemplate = `
## Description
<!-- Please explain your changes -->

## Test Plan
<!-- How did you test this? -->

## Checklist
- [ ] Documentation updated
`;

    const prData = {
      issueNumber: 42,
      problemSummary: 'Fix race condition in store',
      rootCause: 'Concurrent writes without lock',
      keyChanges: ['Add mutex lock around write()', 'Add concurrent unit tests'],
      reproductionCommand: 'npm test -- -t "race"',
      verificationCommand: 'npm test',
      testCount: 15,
    };

    const merged = buildPrDescription(prData, nativeTemplate);

    expect(merged).toContain('Fixes #42');
    expect(merged).toContain('Fix race condition in store');
    expect(merged).toContain('Root Cause');
    expect(merged).toContain('Reproduction: `npm test -- -t "race"`');
    expect(merged).toContain('15 tests passed');
    expect(merged).toContain('## Checklist');
  });

  it('falls back to master PR template when native template is empty or absent', () => {
    const prData = {
      issueNumber: 99,
      problemSummary: 'Upgrade dependencies',
      rootCause: 'Old dependencies',
      keyChanges: ['Bump versions'],
      reproductionCommand: 'npm test',
      verificationCommand: 'npm test',
      testCount: 20,
    };

    const fallback = buildPrDescription(prData);
    expect(fallback).toContain('Fixes #99');
    expect(fallback).toContain('### Motivation');
    expect(fallback).toContain('### Verification');
  });
});
