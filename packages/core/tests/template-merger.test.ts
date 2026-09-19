import { describe, expect, it } from "bun:test";
import { buildPrDescription } from "../src/governance/template-merger.js";

describe("Native Template Merger & Fallback", () => {
  it("merges PR data into target repository native template", () => {
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
      problemSummary: "Fix race condition in store",
      rootCause: "Concurrent writes without lock",
      keyChanges: [
        "Add mutex lock around write()",
        "Add concurrent unit tests",
      ],
      reproductionCommand: 'npm test -- -t "race"',
      verificationCommand: "npm test",
      testCount: 15,
      evidence: {
        baselineTestedAt: "2026-01-01T00:00:00.000Z",
        stressLoopRuns: 1,
        stressLoopPassed: true,
        executionCount: 1,
        maxConcurrentObserved: 1,
        handleLeakCheckPassed: "PASS" as const,
        testCoverageStatus: "PASS" as const,
        changedCodeCoverageStatus: "PASS" as const,
        reproductionVerified: true,
        redEvidence: {
          command: 'npm test -- -t "race"',
          observedOutputSnippet: "race failed",
          exitCode: 1,
          sourceTreeSha256: "red-tree",
          capturedAt: "2026-01-01T00:00:00.000Z",
          assertionMatched: true,
        },
        greenEvidence: {
          command: "npm test",
          exitCode: 0,
          outputSnippet: "15 passed",
          passed: true,
          sourceTreeSha256: "green-tree",
          capturedAt: "2026-01-01T00:01:00.000Z",
          treeChangedComparedToRed: true,
          appliedPatchSha256: "patch",
        },
        passedUnitTestsCount: 15,
        baselineFlakyTests: [],
      },
    };

    const merged = buildPrDescription(prData, nativeTemplate);

    expect(merged).toContain("Fixes #42");
    expect(merged).toContain("Fix race condition in store");
    expect(merged).toContain("Root Cause");
    expect(merged).toContain('- **Reproduction**: `npm test -- -t "race"`');
    expect(merged).toContain("15 tests passed");
    expect(merged).toContain("## Checklist");

    const conflictingGreen = buildPrDescription(
      {
        ...prData,
        evidence: {
          ...prData.evidence,
          allTestsPassing: true,
          greenEvidence: {
            ...prData.evidence.greenEvidence,
            passed: false,
          },
        },
      },
      nativeTemplate,
    );
    expect(conflictingGreen).toContain("- **Verification**: Not recorded.");
  });

  it("falls back to master PR template when native template is empty or absent", () => {
    const prData = {
      issueNumber: 99,
      problemSummary: "Upgrade dependencies",
      rootCause: "Old dependencies",
      keyChanges: ["Bump versions"],
      reproductionCommand: "npm test",
      verificationCommand: "npm test",
      testCount: 20,
      evidence: {
        baselineTestedAt: "2026-01-01T00:00:00.000Z",
        stressLoopRuns: 1,
        stressLoopPassed: true,
        executionCount: 1,
        maxConcurrentObserved: 1,
        handleLeakCheckPassed: "PASS" as const,
        testCoverageStatus: "PASS" as const,
        changedCodeCoverageStatus: "PASS" as const,
        reproductionVerified: true,
        redEvidence: {
          command: "npm test",
          observedOutputSnippet: "failed",
          exitCode: 1,
          sourceTreeSha256: "red-tree",
          capturedAt: "2026-01-01T00:00:00.000Z",
          assertionMatched: true,
        },
        greenEvidence: {
          command: "npm test",
          exitCode: 0,
          outputSnippet: "20 passed",
          passed: true,
          sourceTreeSha256: "green-tree",
          capturedAt: "2026-01-01T00:01:00.000Z",
          treeChangedComparedToRed: true,
          appliedPatchSha256: "patch",
        },
        passedUnitTestsCount: 20,
        baselineFlakyTests: [],
      },
    };

    const fallback = buildPrDescription(prData);
    expect(fallback).toContain("Fixes #99");
    expect(fallback).toContain("### Motivation");
    expect(fallback).toContain("### Verification");
  });

  it("does not promote partial or missing evidence into verified claims", () => {
    const nativeTemplate = "## Test Plan\n\n## Checklist";
    const missing = buildPrDescription(
      {
        issueNumber: 7,
        problemSummary: "Missing evidence",
        rootCause: "Not recorded",
        keyChanges: [],
      },
      nativeTemplate,
    );
    const partial = buildPrDescription(
      {
        issueNumber: 8,
        problemSummary: "Partial evidence",
        rootCause: "Not recorded",
        keyChanges: [],
        evidence: {
          reproductionVerified: true,
          redEvidence: {
            command: "echo fail",
            assertionMatched: true,
          },
        } as any,
      },
      nativeTemplate,
    );

    for (const body of [missing, partial]) {
      expect(body).toContain("- **Reproduction**: Not recorded.");
      expect(body).toContain("- **Verification**: Not recorded.");
    }
  });
});
