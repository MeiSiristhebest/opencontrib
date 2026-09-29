import { describe, expect, it } from "bun:test";
import {
  auditGovernance as auditGovernanceRaw,
  calculateConfidenceScore,
  lintAntiAiText,
  lintAssertionQuality,
  lintPatchCommentHyperbole,
  renderMasterPrTemplate,
} from "../src/governance/index.js";
import { isSupportingFile } from "../src/governance/governance-auditor.js";

const auditGovernance: typeof auditGovernanceRaw = (input) =>
  auditGovernanceRaw({
    preflightLintResult: {
      executed: true,
      passed: true,
      summary: "Test fixture lint check passed.",
    },
    ...input,
  });

describe("Governance & Anti-AI Audit Engine", () => {
  it("detects forbidden AI phrases in text", () => {
    const textWithAi =
      "I have carefully analyzed the issue. Here is a breakdown of the changes: // helper function";
    const result = lintAntiAiText(textWithAi);

    expect(result.isClean).toBe(false);
    expect(result.flaggedPhrases).toContain("i have carefully analyzed");
    expect(result.flaggedPhrases).toContain(
      "here is a breakdown of the changes",
    );
    expect(result.flaggedPhrases).toContain("// helper function");
  });

  it("passes clean, direct humanized engineering text", () => {
    const cleanText =
      "Fixes #402 in opencontrib core by adding null checks in parseStream and releasing socket descriptors in finally block.";
    const result = lintAntiAiText(cleanText);

    expect(result.isClean).toBe(true);
    expect(result.flaggedPhrases.length).toBe(0);
  });

  it("calculates 7-dimension confidence score correctly and enforces weakest dimension gate", () => {
    // Overall = 0.25*95 + 0.25*95 + 0.20*90 + 0.10*90 + 0.10*90 + 0.05*90 + 0.05*90 = 93.0
    // Weakest = 90 (>= 80) -> PASS
    const passResult = calculateConfidenceScore({
      rootCause: 95,
      implementation: 95,
      regression: 90,
      defensiveCoverage: 90,
      testCoverage: 90,
      styleMatch: 90,
      securityAudit: 90,
    });

    expect(passResult.isPassed).toBe(true);
    expect(passResult.overallScore).toBeGreaterThanOrEqual(90);

    // Fail if any single dimension < 80% even if overall >= 90%
    const failWeakestResult = calculateConfidenceScore({
      rootCause: 100,
      implementation: 100,
      regression: 100,
      defensiveCoverage: 100,
      testCoverage: 60, // Weakest < 80%
      styleMatch: 100,
      securityAudit: 100,
    });

    expect(failWeakestResult.overallScore).toBeGreaterThanOrEqual(90);
    expect(failWeakestResult.isPassed).toBe(false); // Gated out because testCoverage is 60%
  });

  it("enforces RFC 100-line diff gate", () => {
    const auditPass = auditGovernance({
      diffText: "const clean = true;",
      prBodyText: "Fixes bug cleanly without robotic tags.",
      confidenceBreakdown: {
        rootCause: 95,
        implementation: 95,
        regression: 90,
        defensiveCoverage: 90,
        testCoverage: 90,
        styleMatch: 95,
        securityAudit: 95,
      },
      lineCount: 45, // <= 100 lines
    });

    expect(auditPass.isGatedPassed).toBe(true);
    expect(auditPass.rfcGatePassed).toBe(true);
    expect(auditPass.requiresHumanApproval).toBe(true);
    expect(auditPass.approvalGate).toEqual({
      status: "PENDING",
      approved: false,
    });

    // Test that unapproved draft is gated
    const auditUnapproved = auditGovernance({
      diffText: "const clean = true;",
      prBodyText: "Fixes bug cleanly.",
      confidenceBreakdown: {
        rootCause: 95,
        implementation: 95,
        regression: 90,
        defensiveCoverage: 90,
        testCoverage: 90,
        styleMatch: 95,
        securityAudit: 95,
      },
      lineCount: 45,
    });
    expect(auditUnapproved.isGatedPassed).toBe(true);
    expect(auditUnapproved.submissionDecision?.allowed).toBe(false);
    expect(auditUnapproved.requiresHumanApproval).toBe(true);

    const auditFailRfc = auditGovernance({
      diffText: "const x = 1;",
      prBodyText: "Fixes bug cleanly without fluff.",
      confidenceBreakdown: {
        rootCause: 95,
        implementation: 95,
        regression: 95,
        defensiveCoverage: 95,
        testCoverage: 95,
        styleMatch: 95,
        securityAudit: 95,
      },
      lineCount: 150, // > 100 lines
    });

    expect(auditFailRfc.isGatedPassed).toBe(false);
    expect(auditFailRfc.rfcGatePassed).toBe(false);
    expect(auditFailRfc.remediationSuggestions[0]).toContain(
      "configured limit of 100 lines",
    );
  });

  it("applies the RFC size gate to measured core lines while retaining total changed lines", () => {
    const confidenceBreakdown = {
      rootCause: 95,
      implementation: 95,
      regression: 95,
      defensiveCoverage: 95,
      testCoverage: 95,
      styleMatch: 95,
      securityAudit: 95,
    };
    const result = auditGovernance({
      prBodyText: "Fixes bug with regression tests and documentation.",
      lineCount: 150,
      coreDiffLines: 40,
      confidenceBreakdown,
    });
    const invalidCoreLineCount = auditGovernance({
      lineCount: 150,
      coreDiffLines: -1,
      confidenceBreakdown,
    });

    expect(result.diffLineCount).toBe(150);
    expect(result.rfcGatePassed).toBe(true);
    expect(result.isGatedPassed).toBe(true);
    expect(result.remediationSuggestions).toContain(
      "Supporting Engineering Exemption: Core production logic is within threshold (40/100 lines). Additional 110 lines are test matrices and documentation.",
    );
    expect(invalidCoreLineCount.rfcGatePassed).toBe(false);
  });

  it("classifies test and documentation paths without exempting application source", () => {
    expect(isSupportingFile("packages/core/tests/fixture.json")).toBe(true);
    expect(isSupportingFile("src/parser.test.py")).toBe(true);
    expect(isSupportingFile("docs/guide.txt")).toBe(true);
    expect(isSupportingFile("README.md")).toBe(true);
    expect(isSupportingFile("apps/web/pages/index.tsx")).toBe(false);
    expect(isSupportingFile("src/testHarness.ts")).toBe(false);
    expect(isSupportingFile("docs/guide.mdx")).toBe(true);
    expect(isSupportingFile("src/config.txt")).toBe(false);
  });

  it("applies the core limit to parsed supporting and application diff paths", () => {
    const diffFor = (filePath: string, lineCount: number) =>
      [
        `diff --git a/${filePath} b/${filePath}`,
        `--- a/${filePath}`,
        `+++ b/${filePath}`,
        `@@ -0,0 +1,${lineCount} @@`,
        ...Array.from({ length: lineCount }, (_, index) => `+line-${index}`),
      ].join("\n");
    const confidenceBreakdown = {
      rootCause: 95,
      implementation: 95,
      regression: 95,
      defensiveCoverage: 95,
      testCoverage: 95,
      styleMatch: 95,
      securityAudit: 95,
    };

    const supportingOnly = auditGovernance({
      diffText: [
        diffFor("docs/guide.md", 60),
        diffFor("tests/guide.test.ts", 60),
      ].join("\n"),
      confidenceBreakdown,
    });
    const applicationSource = auditGovernance({
      diffText: diffFor("apps/web/pages/index.tsx", 101),
      confidenceBreakdown,
    });
    const incrementLines = auditGovernance({
      diffText: [
        "diff --git a/src/counter.c b/src/counter.c",
        "--- a/src/counter.c",
        "+++ b/src/counter.c",
        "@@ -1 +1 @@",
        "---counter;",
        "+++counter;",
      ].join("\n"),
      confidenceBreakdown,
    });

    expect(supportingOnly.diffLineCount).toBe(120);
    expect(supportingOnly.rfcGatePassed).toBe(true);
    expect(applicationSource.diffLineCount).toBe(101);
    expect(applicationSource.rfcGatePassed).toBe(false);
    expect(incrementLines.diffLineCount).toBe(2);
  });

  it("tracks unified and quoted paths without treating hunk content as headers", () => {
    const confidenceBreakdown = {
      rootCause: 95,
      implementation: 95,
      regression: 95,
      defensiveCoverage: 95,
      testCoverage: 95,
      styleMatch: 95,
      securityAudit: 95,
    };
    const supportingDiff = [
      "--- docs/user guide.md",
      "+++ docs/user guide.md",
      "@@ -0,0 +1,2 @@",
      "+guide line",
      "+details line",
      'diff --git "a/tests/用户 guide.test.ts" "b/tests/用户 guide.test.ts"',
      '--- "a/tests/用户 guide.test.ts"',
      '+++ "b/tests/用户 guide.test.ts"',
      "@@ -0,0 +1,2 @@",
      "+test one",
      "+test two",
    ].join("\n");
    const supportingOnly = auditGovernance({
      diffText: supportingDiff,
      maxDiffLines: 1,
      confidenceBreakdown,
    });
    const hunkContentWithHeaderPrefix = auditGovernance({
      diffText: [
        "diff --git a/src/core.ts b/src/core.ts",
        "--- a/src/core.ts",
        "+++ b/src/core.ts",
        "@@ -0,0 +1,2 @@",
        "+++ b/tests/foo.test.ts",
        "+const coreFix = true;",
      ].join("\n"),
      maxDiffLines: 1,
      confidenceBreakdown,
    });

    expect(supportingOnly.diffLineCount).toBe(4);
    expect(supportingOnly.rfcGatePassed).toBe(true);
    expect(hunkContentWithHeaderPrefix.diffLineCount).toBe(2);
    expect(hunkContentWithHeaderPrefix.rfcGatePassed).toBe(false);
    expect(hunkContentWithHeaderPrefix.remediationSuggestions).toContain(
      "Diff exceeds the configured limit of 1 lines (2 core lines). Split into RFC Discussion issue first.",
    );
  });

  it("renders natural humanized PR template and bans robotic meta headers", () => {
    const template = renderMasterPrTemplate({
      issueNumber: 402,
      problemSummary: "Null dereference on empty input",
      rootCause: "Calling parse() with empty string accessed null property",
      keyChanges: ["Add null guard in parse()", "Add unit tests"],
      verificationCommand: "npm test",
    });

    expect(template).toContain("Null dereference on empty input");
    expect(template).toContain("Verification");
    expect(template).not.toContain("Signed-off-by:");
    expect(template).not.toContain("Google / ByteDance Standard");
    expect(template).not.toContain("I have carefully analyzed");

    // Test that anti-AI scanner rejects robotic meta headers
    const roboticCheck = lintAntiAiText(
      "## Summary (Google / ByteDance Standard)",
    );
    expect(roboticCheck.isClean).toBe(false);

    // Test without DCO
    const cleanTemplate = renderMasterPrTemplate({
      issueNumber: 100,
      problemSummary: "Clean fix",
      rootCause: "Fix logic",
      keyChanges: ["Fix"],
      verificationCommand: "test",
      validationOutputSnippet: "10 tests passed",
    });
    expect(cleanTemplate).not.toContain("Signed-off-by");
    expect(cleanTemplate).not.toContain("passed cleanly");
    expect(cleanTemplate).toContain(
      "User-provided validation note (not verified)",
    );

    // Test native PR template merger with Checkboxes and Related Issues
    const nativeTemplate = `
## Description
<!-- What does this PR do? -->

## Type of Change
- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] Documentation update

## How Has This Been Tested?
- [ ] \`make test\` passes locally

## Checklist
- [ ] I have signed the CLA
- [ ] I did not use AI/LLM to create this PR, or I disclosed the tool/model below

## Related Issues
<!-- Link related issues below. -->
`;
    const mergedNative = renderMasterPrTemplate({
      issueNumber: 1581,
      problemSummary: "Handle LLM truncated output",
      rootCause: "Truncation caused JSON parse error",
      keyChanges: ["Add IsTruncated helper"],
      nativeTemplateContent: nativeTemplate,
      dcoRequired: true,
      aiDisclosureRequired: true,
    });

    expect(mergedNative).toContain("- [x] Bug fix");
    expect(mergedNative).toContain("- [ ] `make test` passes locally");
    expect(mergedNative).toContain("- [ ] I have signed the CLA");
    expect(mergedNative).toContain("- [ ] I did not use AI/LLM");
    expect(mergedNative).toContain(
      "Automated assistance disclosure: This contribution was prepared using OpenContrib AI-assisted tooling; specific model details were not recorded in this run.",
    );
    expect(mergedNative).toContain(
      "DCO requirement: the commits must include a valid Signed-off-by trailer.",
    );
    expect(mergedNative).toContain("closes #1581");
    expect(mergedNative).toContain("Handle LLM truncated output");
    expect(mergedNative).not.toContain("<!-- What does this PR do? -->");
  });

  it("detects corrupted Unicode replacement characters and malformed headers", () => {
    const corruptedPr = `
### Problem Description
Fixes #1106

3## Key Implementation Changes
- Normalization: Strip enclosing brackets \uFFFD\uFFFD\uFFFD
`;
    const auditCorrupted = auditGovernance({
      patchContent: "diff --git a/foo b/foo\n+const a = 1;",
      prTitle: "fix(knowledge): normalize IPv6 SSRF",
      prBody: corruptedPr,
      confidenceBreakdown: {
        rootCause: 95,
        implementation: 95,
        regression: 95,
        defensiveCoverage: 95,
        testCoverage: 95,
        styleMatch: 95,
        securityAudit: 95,
      },
      lineCount: 20,
    });

    expect(auditCorrupted.isGatedPassed).toBe(false);
    expect(auditCorrupted.markdownIntegrityPassed).toBe(false);
    expect(
      auditCorrupted.corruptedMarkdownIssues?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      auditCorrupted.remediationSuggestions.some((s) =>
        s.includes("Markdown encoding/corruption"),
      ),
    ).toBe(true);
  });

  it("keeps advisory coverage separate from the explicit changed-code gate", () => {
    // Advisory coverage must not become an implicit hard gate.
    const advisoryAudit = auditGovernance({
      patchContent: "diff --git a/foo b/foo\n+const a = 1;",
      prTitle: "fix(ai): match subdomains",
      prBody: "Fixes #8736\n\n### Problem\nSubdomain proxy bug.",
      evidence: {
        reproductionVerified: true,
        allTestsPassing: true,
        passedUnitTestsCount: 5,
        testCoveragePercent: 70, // Below 85% threshold
      },
      lineCount: 15,
    });

    expect(advisoryAudit.isGatedPassed).toBe(true);
    expect(
      advisoryAudit.remediationSuggestions.some((s) =>
        s.includes(
          "PR accompanying test coverage is below the 85% advisory threshold",
        ),
      ),
    ).toBe(true);

    // Explicit changed-code coverage policy remains a hard gate.
    const passAudit = auditGovernance({
      patchContent: "diff --git a/foo b/foo\n+const a = 1;",
      prTitle: "fix(ai): match subdomains",
      prBody: "Fixes #8736\n\n### Problem\nSubdomain proxy bug.",
      evidence: {
        reproductionVerified: true,
        allTestsPassing: true,
        passedUnitTestsCount: 5,
        testCoveragePercent: 95, // Above 85% threshold
      },
      lineCount: 15,
    });

    expect(passAudit.isGatedPassed).toBe(true);
    expect(passAudit.overallScore).toBeGreaterThanOrEqual(90);

    const belowPolicyAudit = auditGovernance({
      patchContent: "diff --git a/foo b/foo\\n+const a = 1;",
      prTitle: "fix(ai): match subdomains",
      prBody: "Fixes #8736\\n\\n### Problem\\nSubdomain proxy bug.",
      evidence: {
        reproductionVerified: true,
        allTestsPassing: true,
        changedCodeCoverageStatus: "PASS",
        changedCodeCoveragePercent: 70,
        passedUnitTestsCount: 5,
      },
      coveragePolicy: { required: true, minimumChangedLineCoverage: 85 },
      lineCount: 15,
    });

    expect(belowPolicyAudit.technicalGate?.status).toBe("FAIL");
    expect(belowPolicyAudit.isGatedPassed).toBe(false);
  });

  it("fails closed when a repository requires unavailable changed-code coverage", () => {
    const audit = auditGovernance({
      patchContent: "diff --git a/foo b/foo\\n+const a = 1;",
      prBody: "Fixes #1",
      confidenceBreakdown: {
        rootCause: 95,
        implementation: 95,
        regression: 95,
        defensiveCoverage: 95,
        testCoverage: 95,
        styleMatch: 95,
        securityAudit: 95,
      },
      evidence: {
        changedCodeCoverageStatus: "UNAVAILABLE",
        passedUnitTestsCount: 4,
      },
      coveragePolicy: { required: true, minimumChangedLineCoverage: 85 },
      lineCount: 2,
    });

    expect(audit.technicalGate?.status).toBe("FAIL");
    expect(audit.isGatedPassed).toBe(false);
    expect(audit.remediationSuggestions.join(" ")).toContain(
      "coverage is unavailable",
    );
  });

  it("passes a required coverage policy only with measured changed-code coverage", () => {
    const audit = auditGovernance({
      patchContent: "diff --git a/foo b/foo\\n+const a = 1;",
      prBody: "Fixes #1",
      confidenceBreakdown: {
        rootCause: 95,
        implementation: 95,
        regression: 95,
        defensiveCoverage: 95,
        testCoverage: 95,
        styleMatch: 95,
        securityAudit: 95,
      },
      evidence: {
        changedCodeCoverageStatus: "PASS",
        changedCodeCoveragePercent: 90,
        passedUnitTestsCount: 4,
      },
      coveragePolicy: { required: true, minimumChangedLineCoverage: 85 },
      lineCount: 2,
    });

    expect(audit.technicalGate?.status).toBe("PASS");
    expect(audit.isGatedPassed).toBe(true);
  });

  it("uses measured coverage with the trusted policy threshold", () => {
    const audit = auditGovernance({
      patchContent: "diff --git a/foo b/foo\\n+const a = 1;",
      prBody: "Fixes #1",
      confidenceBreakdown: {
        rootCause: 95,
        implementation: 95,
        regression: 95,
        defensiveCoverage: 95,
        testCoverage: 95,
        styleMatch: 95,
        securityAudit: 95,
      },
      evidence: {
        changedCodeCoverageStatus: "PASS",
        changedCodeCoveragePercent: 75,
        passedUnitTestsCount: 4,
      },
      coveragePolicy: { required: true, minimumChangedLineCoverage: 70 },
      lineCount: 2,
    });

    expect(audit.technicalGate?.status).toBe("PASS");
    expect(audit.isGatedPassed).toBe(true);
  });

  it("fails closed when a resource-sensitive contribution lacks leak evidence", () => {
    const audit = auditGovernance({
      patchContent: "diff --git a/foo b/foo\\n+const a = 1;",
      prBody: "Fixes #1",
      confidenceBreakdown: {
        rootCause: 95,
        implementation: 95,
        regression: 95,
        defensiveCoverage: 95,
        testCoverage: 95,
        styleMatch: 95,
        securityAudit: 95,
      },
      evidence: {
        handleLeakCheckPassed: "UNAVAILABLE",
        passedUnitTestsCount: 4,
      },
      resourceLeakPolicy: { required: true },
      lineCount: 2,
    });

    expect(audit.technicalGate?.status).toBe("FAIL");
    expect(audit.remediationSuggestions.join(" ")).toContain(
      "Resource-leak evidence",
    );
  });

  it("detects and blocks tautological error assertions in test code", () => {
    const tautologicalPatch = `
diff --git a/foo_test.go b/foo_test.go
--- a/foo_test.go
+++ b/foo_test.go
@@ -10,3 +10,6 @@
+if !strings.Contains(result, "Error:") {
+    t.Fatalf("expected error")
+}
`;
    const check = lintAssertionQuality(tautologicalPatch);
    expect(check.isClean).toBe(false);
    expect(check.flaggedTautologicalAssertions.length).toBeGreaterThan(0);
    expect(check.flaggedTautologicalAssertions[0]).toContain("Tautological error assertion");

    const typescriptPatch = `
diff --git a/packages/core/tests/assertion.test.ts b/packages/core/tests/assertion.test.ts
--- a/packages/core/tests/assertion.test.ts
+++ b/packages/core/tests/assertion.test.ts
@@ -1,1 +1,1 @@
+expect(error.message).toContain("Error:");
`;
    const checkTypeScript = lintAssertionQuality(typescriptPatch);
    expect(checkTypeScript.isClean).toBe(false);

    for (const testPath of [
      "src/ParserTest.java",
      "src/ServiceTests.cs",
      "src/testParser.ts",
    ]) {
      const conventionalTestPatch = `
diff --git a/${testPath} b/${testPath}
--- a/${testPath}
+++ b/${testPath}
@@ -1,1 +1,1 @@
+expect(error.message).toContain("Error:");
`;
      expect(lintAssertionQuality(conventionalTestPatch).isClean).toBe(false);
    }

    const productionComparisonPatch = `
diff --git a/packages/core/src/error-utils.ts b/packages/core/src/error-utils.ts
--- a/packages/core/src/error-utils.ts
+++ b/packages/core/src/error-utils.ts
@@ -1,1 +1,1 @@
+if (!strings.Contains(err.Error(), "error")) return false;
`;
    expect(lintAssertionQuality(productionComparisonPatch).isClean).toBe(true);

    const concretePatch = `
diff --git a/foo_test.go b/foo_test.go
--- a/foo_test.go
+++ b/foo_test.go
@@ -10,3 +10,6 @@
+if !strings.Contains(result, "Error: invalid regular expression") {
+    t.Fatalf("expected specific error contract")
+}
`;
    const checkConcrete = lintAssertionQuality(concretePatch);
    expect(checkConcrete.isClean).toBe(true);
  });

  it("detects and blocks exaggerated comment severity when defect evidence is non-crash", () => {
    const hyperbolePatch = `
diff --git a/foo_test.go b/foo_test.go
--- a/foo_test.go
+++ b/foo_test.go
@@ -10,3 +10,4 @@
+// An unbalanced parenthesis in PCRE mode causes git grep to fail with exit code 128.
+// It should return a graceful error message for the model instead of crashing the tool execution.
`;
    // Non-crash RED evidence: exit code 1, normal git grep failure
    const check = lintPatchCommentHyperbole(hyperbolePatch, {
      exitCode: 1,
      observedOutputSnippet: "git grep failed: exit status 128: fatal: -e option: missing closing parenthesis",
    });
    expect(check.isClean).toBe(false);
    expect(check.flaggedCommentHyperboles.length).toBeGreaterThan(0);
    expect(check.flaggedCommentHyperboles[0]).toContain(
      "Unsubstantiated crash/panic claim in comment",
    );

    const highExitCodeWithoutCrashEvidence = lintPatchCommentHyperbole(
      hyperbolePatch,
      { exitCode: 129, observedOutputSnippet: "process exited with status 129" },
    );
    expect(highExitCodeWithoutCrashEvidence.isClean).toBe(false);

    const missingEvidence = lintPatchCommentHyperbole(hyperbolePatch);
    expect(missingEvidence.isClean).toBe(false);
    expect(missingEvidence.flaggedCommentHyperboles[0]).toContain(
      "available RED evidence does not establish",
    );

    // Clean factual comment
    const factualPatch = `
diff --git a/foo_test.go b/foo_test.go
--- a/foo_test.go
+++ b/foo_test.go
@@ -10,3 +10,4 @@
+// It should return a graceful error message for the model instead of failing the tool call with a Go error.
`;
    const checkFactual = lintPatchCommentHyperbole(factualPatch, {
      exitCode: 1,
      observedOutputSnippet: "git grep failed: exit status 128: fatal: -e option: missing closing parenthesis",
    });
    expect(checkFactual.isClean).toBe(true);

    // If RED evidence genuinely had panic:, the word panic is factual and allowed
    const genuinePanicCheck = lintPatchCommentHyperbole(`
diff --git a/foo.go b/foo.go
--- a/foo.go
+++ b/foo.go
@@ -10,3 +10,4 @@
+// Fixes nil dereference that panics the HTTP handler worker pool.
`, {
      exitCode: 2,
      observedOutputSnippet: "panic: runtime error: invalid memory address or nil pointer dereference",
    });
    expect(genuinePanicCheck.isClean).toBe(true);
  });

  it("fails technical gate when patch contains tautological assertions or exaggerated comments", () => {
    const failingPatch = `
diff --git a/foo_test.go b/foo_test.go
--- a/foo_test.go
+++ b/foo_test.go
@@ -10,3 +10,5 @@
+// Unclosed regex crashes the tool execution
+if !strings.Contains(result, "Error:") {
+    t.Fail()
+}
`;
    const audit = auditGovernance({
      patchContent: failingPatch,
      prBody: "Fixes regex handling cleanly.",
      confidenceBreakdown: {
        rootCause: 95,
        implementation: 95,
        regression: 95,
        defensiveCoverage: 95,
        testCoverage: 95,
        styleMatch: 95,
        securityAudit: 95,
      },
      evidence: {
        allTestsPassing: true,
        passedUnitTestsCount: 1,
        redEvidence: {
          exitCode: 1,
          observedOutputSnippet: "git grep failed with error",
          capturedAt: new Date().toISOString(),
          command: "go test",
          sourceTreeSha256: "abc",
          assertionMatched: true,
        },
      },
      lineCount: 4,
    });

    expect(audit.technicalGate?.status).toBe("FAIL");
    expect(audit.assertionQualityPassed).toBe(false);
    expect(audit.commentHyperbolePassed).toBe(false);
    expect(audit.remediationSuggestions.join(" ")).toContain("Assertion Quality Gate");
    expect(audit.remediationSuggestions.join(" ")).toContain("Comment Severity Gate");
  });

  it("preserves cross-platform, defensive, and sibling-file impact findings in governance output", () => {
    const audit = auditGovernance({
      patchContent:
        "+normalized := filepath.ToSlash(input)\n+frame = frame.reset_index()",
      modifiedFiles: ["internal/parser.go"],
      repoContextFiles: ["internal/hunk.go", "internal/types.go"],
      prTitle: "fix(parser): normalize paths and index columns",
      prBody: "Fix parser path and index handling.",
      confidenceBreakdown: {
        rootCause: 95,
        implementation: 95,
        regression: 95,
        defensiveCoverage: 95,
        testCoverage: 95,
        styleMatch: 95,
        securityAudit: 95,
      },
      lineCount: 2,
    });

    const findings = audit.impactAnalysisIssues ?? [];
    expect(audit.impactAnalysisPassed).toBe(false);
    expect(findings).toHaveLength(4);
    expect(findings.some((finding) => finding.includes("filepath.ToSlash"))).toBe(
      true,
    );
    expect(
      findings.some((finding) => finding.includes("DEFENSIVE COLLISION HAZARD")),
    ).toBe(true);
    expect(findings.some((finding) => finding.includes("internal/hunk.go"))).toBe(
      true,
    );
    expect(findings.some((finding) => finding.includes("internal/types.go"))).toBe(
      true,
    );
  });

  it("fails technical gate when patch contains critical cross-platform, collision, or lifecycle impact hazard", () => {
    const hazardousPatch = `
diff --git a/model.py b/model.py
--- a/model.py
+++ b/model.py
@@ -10,3 +10,3 @@
+df = df.reset_index()
`;
    const audit = auditGovernance({
      patchContent: hazardousPatch,
      prBody: "Fixes indexing behavior cleanly.",
      confidenceBreakdown: {
        rootCause: 95,
        implementation: 95,
        regression: 95,
        defensiveCoverage: 95,
        testCoverage: 95,
        styleMatch: 95,
        securityAudit: 95,
      },
      lineCount: 2,
    });

    expect(audit.technicalGate?.status).toBe("FAIL");
    expect(audit.isGatedPassed).toBe(false);
    expect(audit.impactAnalysisPassed).toBe(false);
    expect(audit.impactAnalysisIssues && audit.impactAnalysisIssues.length > 0).toBe(true);
    expect(audit.remediationSuggestions.join(" ")).toContain("Impact Gate");
  });
});
