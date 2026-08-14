import { describe, expect, it } from 'bun:test';
import {
  auditGovernance,
  calculateConfidenceScore,
  lintAntiAiText,
  renderMasterPrTemplate,
} from '../src/governance/index.js';

describe('Governance & Anti-AI Audit Engine', () => {
  it('detects forbidden AI phrases in text', () => {
    const textWithAi = 'I have carefully analyzed the issue. Here is a breakdown of the changes: // helper function';
    const result = lintAntiAiText(textWithAi);

    expect(result.isClean).toBe(false);
    expect(result.flaggedPhrases).toContain('i have carefully analyzed');
    expect(result.flaggedPhrases).toContain('here is a breakdown of the changes');
    expect(result.flaggedPhrases).toContain('// helper function');
  });

  it('passes clean, direct humanized engineering text', () => {
    const cleanText = 'Fixes #402 by adding null checks in parseStream and releasing socket descriptors in finally block.';
    const result = lintAntiAiText(cleanText);

    expect(result.isClean).toBe(true);
    expect(result.flaggedPhrases.length).toBe(0);
  });

  it('calculates 7-dimension confidence score correctly and enforces weakest dimension gate', () => {
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

  it('enforces RFC 100-line diff gate', () => {
    const auditPass = auditGovernance({
      diffText: 'const x = 1;',
      prBodyText: 'Fixes bug cleanly without fluff.',
      confidenceBreakdown: {
        rootCause: 95,
        implementation: 95,
        regression: 95,
        defensiveCoverage: 95,
        testCoverage: 95,
        styleMatch: 95,
        securityAudit: 95,
      },
      lineCount: 45, // <= 100 lines
    });

    expect(auditPass.isGatedPassed).toBe(true);
    expect(auditPass.rfcGatePassed).toBe(true);

    const auditFailRfc = auditGovernance({
      diffText: 'const x = 1;',
      prBodyText: 'Fixes bug cleanly without fluff.',
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
    expect(auditFailRfc.remediationSuggestions[0]).toContain('exceeds 100 lines');
  });

  it('renders multi-org Master PR template with DCO and zero AI smell', () => {
    const template = renderMasterPrTemplate({
      issueNumber: 402,
      problemSummary: 'Null dereference on empty input',
      rootCause: 'Calling parse() with empty string accessed null property',
      keyChanges: ['Add null guard in parse()', 'Add unit tests'],
      reproductionCommand: 'npm test -- -t "empty input"',
      verificationCommand: 'npm test',
      testCount: 42,
      dcoAuthorName: 'Developer Name',
      dcoAuthorEmail: 'dev@domain.com',
    });

    expect(template).toContain('Null dereference on empty input');
    expect(template).toContain('Google / ByteDance Standard');
    expect(template).toContain('Microsoft VSCode / Meta PyTorch Standard');
    expect(template).toContain('Developer Name <dev@domain.com>');
    expect(template).not.toContain('I have carefully analyzed');

    // Test without DCO
    const cleanTemplate = renderMasterPrTemplate({
      issueNumber: 100,
      problemSummary: 'Clean fix',
      rootCause: 'Fix logic',
      keyChanges: ['Fix'],
      reproductionCommand: 'test',
      verificationCommand: 'test',
      testCount: 10,
    });
    expect(cleanTemplate).not.toContain('Signed-off-by');
  });
});
