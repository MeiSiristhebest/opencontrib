import { describe, expect, it } from 'bun:test';
import {
  normalizePatchLineEndings,
  hasCrlf,
  parseSchemaV2Report,
  isInstanceResolved,
  type SchemaV2Report,
  type SwebenchFixture,
} from '../src/eval/harness-utils.js';
import { buildTurnPrompt } from '../src/orchestration/agent-orchestrator.js';

// ─── CRLF Normalization ────────────────────────────────────────────────────────

describe('normalizePatchLineEndings', () => {
  it('strips BOM', () => {
    const patch = '\uFEFF--- a/file.ts\r\n+++ b/file.ts\r\n';
    const result = normalizePatchLineEndings(patch);
    expect(result).not.toStartWith('\uFEFF');
  });

  it('converts CRLF to LF', () => {
    const patch = '--- a/file.ts\r\n+++ b/file.ts\r\n@@ -1 +1 @@\r\n- old\r\n+ new\r\n';
    const result = normalizePatchLineEndings(patch);
    expect(result).not.toContain('\r\n');
    expect(result).toContain('\n');
  });

  it('converts bare CR to LF', () => {
    const patch = 'line1\rline2\rline3';
    const result = normalizePatchLineEndings(patch);
    expect(result).not.toContain('\r');
    expect(result).toEqual('line1\nline2\nline3');
  });

  it('leaves LF-only patches unchanged', () => {
    const patch = '--- a/file.ts\n+++ b/file.ts\n';
    const result = normalizePatchLineEndings(patch);
    expect(result).toEqual(patch);
  });

  it('handles empty string', () => {
    expect(normalizePatchLineEndings('')).toEqual('');
  });

  it('does not double-convert already-LF patches', () => {
    const patch = 'first\nsecond\nthird';
    const result = normalizePatchLineEndings(patch);
    expect(result.split('\n').length).toEqual(3);
  });
});

describe('hasCrlf', () => {
  it('detects CRLF', () => {
    expect(hasCrlf('line1\r\nline2')).toBe(true);
  });

  it('returns false for LF-only', () => {
    expect(hasCrlf('line1\nline2')).toBe(false);
  });

  it('returns false for empty', () => {
    expect(hasCrlf('')).toBe(false);
  });
});

// ─── Schema-v2 Report Parsing ──────────────────────────────────────────────────

describe('parseSchemaV2Report', () => {
  it('returns PASS aggregate when all instances succeeded', () => {
    const results = [
      { scenarioId: 'django__django-10914', success: true, errors: [] },
      { scenarioId: 'flask__flask-4376', success: true, errors: [] },
    ];
    const report = parseSchemaV2Report({}, results);

    expect(report.aggregate).toEqual('PASS');
    expect(report.passed).toEqual(2);
    expect(report.failed).toEqual(0);
    expect(report.total).toEqual(2);
    expect(report.resolved_ids).toEqual(['django__django-10914', 'flask__flask-4376']);
    expect(report.fail_to_pass).toEqual(2);
    expect(report.pass_to_fail).toEqual(0);
  });

  it('returns FAIL aggregate when no instances succeeded', () => {
    const results = [
      { scenarioId: 'django__django-10914', success: false, errors: ['Missing required pipeline phase: GREEN_FIXED'] },
      { scenarioId: 'flask__flask-4376', success: false, errors: ['Missing required pipeline phase: EVIDENCE_COLLECTED'] },
    ];
    const report = parseSchemaV2Report({}, results);

    expect(report.aggregate).toEqual('FAIL');
    expect(report.passed).toEqual(0);
    expect(report.failed).toEqual(2);
    expect(report.resolved_ids).toEqual([]);
  });

  it('returns PARTIAL aggregate when mixed results', () => {
    const results = [
      { scenarioId: 'django__django-10914', success: true, errors: [] },
      { scenarioId: 'flask__flask-4376', success: false, errors: ['Missing required pipeline phase: GREEN_FIXED'] },
    ];
    const report = parseSchemaV2Report({}, results);

    expect(report.aggregate).toEqual('PARTIAL');
    expect(report.passed).toEqual(1);
    expect(report.failed).toEqual(1);
    expect(report.resolved_ids).toEqual(['django__django-10914']);
  });

  it('includes per-test verdicts with correct status', () => {
    const results = [
      { scenarioId: 'instance-1', success: true, errors: [] },
      { scenarioId: 'instance-2', success: false, errors: ['Missing required: X'] },
    ];
    const report = parseSchemaV2Report({}, results);

    expect(report.per_test).toHaveLength(2);
    expect(report.per_test[0].status).toEqual('FAIL_TO_PASS');
    expect(report.per_test[0].resolved).toBe(true);
    expect(report.per_test[1].status).toEqual('FAIL');
    expect(report.per_test[1].resolved).toBe(false);
  });

  it('includes error output in per-test verdicts', () => {
    const results = [
      { scenarioId: 'instance-1', success: false, errors: ['Missing required pipeline phase: GREEN_FIXED', 'Missing required pipeline phase: EVIDENCE_COLLECTED'] },
    ];
    const report = parseSchemaV2Report({}, results);

    expect(report.per_test[0].output).toContain('GREEN_FIXED');
    expect(report.per_test[0].output).toContain('EVIDENCE_COLLECTED');
  });
});

describe('isInstanceResolved', () => {
  const makeReport = (verdicts: Array<{ testId: string; status: string; resolved: boolean; file: string }>): SchemaV2Report => ({
    resolved_ids: ['instance-1'],
    aggregate: 'PASS',
    total: verdicts.length,
    passed: verdicts.filter((v) => v.resolved).length,
    failed: verdicts.filter((v) => !v.resolved).length,
    fail_to_pass: verdicts.filter((v) => v.status === 'FAIL_TO_PASS').length,
    pass_to_fail: verdicts.filter((v) => v.status === 'PASS_TO_FAIL').length,
    per_test: verdicts,
  });

  it('returns true when instance has resolved FAIL_TO_PASS and no PASS_TO_FAIL', () => {
    const report = makeReport([
      { testId: 'instance-1', status: 'FAIL_TO_PASS', resolved: true, file: 'test.py' },
    ]);
    expect(isInstanceResolved(report, 'instance-1')).toBe(true);
  });

  it('returns false when instance has PASS_TO_FAIL regression', () => {
    const report = makeReport([
      { testId: 'instance-1', status: 'FAIL_TO_PASS', resolved: true, file: 'test.py' },
      { testId: 'instance-1', status: 'PASS_TO_FAIL', resolved: false, file: 'other.py' },
    ]);
    expect(isInstanceResolved(report, 'instance-1')).toBe(false);
  });

  it('returns false when no verdicts for instance', () => {
    const report = makeReport([]);
    expect(isInstanceResolved(report, 'nonexistent')).toBe(false);
  });

  it('returns false when FAIL_TO_PASS not resolved', () => {
    const report = makeReport([
      { testId: 'instance-1', status: 'FAIL_TO_PASS', resolved: false, file: 'test.py' },
    ]);
    expect(isInstanceResolved(report, 'instance-1')).toBe(false);
  });
});

// ─── Per-Turn Prompt Rebuild ────────────────────────────────────────────────────

describe('buildTurnPrompt (per-turn prompt rebuild with tool feedback)', () => {
  const basePrompt = 'You are a surgical patch generator. Fix the issue below.';

  it('returns base prompt with instruction for first attempt (no feedback)', () => {
    const result = buildTurnPrompt({
      basePrompt,
      feedback: [],
      appliedFiles: [],
      attemptNumber: 1,
      maxAttempts: 3,
    });

    expect(result).toContain('You are a surgical patch generator');
    expect(result).toContain('PatchDraftSchema');
    expect(result).not.toContain('Previous Attempt Feedback');
    expect(result).not.toContain('Attempt 1/3');
  });

  it('includes previous attempt feedback on second attempt', () => {
    const result = buildTurnPrompt({
      basePrompt,
      testCommand: 'pytest test_bug.py -x',
      feedback: [
        {
          turn: 1,
          toolName: 'collectEvidence',
          command: 'pytest test_bug.py -x',
          exitCode: 1,
          output: 'FAILED test_bug.py::test_repro - AssertionError: expected 1 got 2',
          success: false,
        },
      ],
      appliedFiles: [{ path: 'src/parser.ts', operation: 'edit' }],
      attemptNumber: 2,
      maxAttempts: 3,
    });

    expect(result).toContain('Previous Attempt Feedback (Attempts 1-1)');
    expect(result).toContain('❌ FAIL (exit 1)');
    expect(result).toContain('collectEvidence');
    expect(result).toContain('pytest test_bug.py -x');
    expect(result).toContain('AssertionError');
    expect(result).toContain('src/parser.ts');
    expect(result).toContain('Attempt 2/3');
    expect(result).toContain('1 attempt');
    expect(result).toContain('pytest test_bug.py -x');
  });

  it('includes multiple feedback entries from multiple tools', () => {
    const result = buildTurnPrompt({
      basePrompt,
      testCommand: 'cargo test',
      feedback: [
        {
          turn: 1,
          toolName: 'applySurgicalFilesSafely',
          output: 'Path /../etc/passwd is outside workspace boundary',
          success: false,
        },
        {
          turn: 1,
          toolName: 'collectEvidence',
          command: 'cargo test',
          exitCode: 101,
          output: 'test result: FAILED. 0 passed; 3 failed',
          success: false,
        },
      ],
      appliedFiles: [{ path: 'src/lib.rs', operation: 'edit' }],
      attemptNumber: 2,
      maxAttempts: 3,
    });

    expect(result).toContain('applySurgicalFilesSafely');
    expect(result).toContain('collectEvidence');
    expect(result).toContain('outside workspace boundary');
    expect(result).toContain('FAILED. 0 passed');
  });

  it('truncates long feedback output to 1500 chars', () => {
    const longOutput = 'A'.repeat(3000);
    const result = buildTurnPrompt({
      basePrompt,
      testCommand: 'make test',
      feedback: [
        { turn: 1, toolName: 'collectEvidence', command: 'make test', output: longOutput, success: false },
      ],
      appliedFiles: [],
      attemptNumber: 2,
      maxAttempts: 3,
    });

    expect(result).toContain('Previous Attempt Feedback');
    const feedbackSection = result.split('Previous Attempt Feedback')[1];
    expect(feedbackSection.length).toBeLessThan(3000);
  });

  it('shows success marker for passing tools', () => {
    const result = buildTurnPrompt({
      basePrompt,
      testCommand: 'npm test',
      feedback: [
        { turn: 1, toolName: 'collectEvidence', command: 'npm test', exitCode: 0, output: 'All 42 tests passed', success: true },
      ],
      appliedFiles: [{ path: 'src/index.js', operation: 'edit' }],
      attemptNumber: 2,
      maxAttempts: 3,
    });

    expect(result).toContain('✅ PASS');
  });
});
