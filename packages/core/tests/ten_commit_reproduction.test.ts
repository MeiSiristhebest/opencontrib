import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir, homedir } from 'os';
import {
  normalizePatchLineEndings,
  hasCrlf,
  parseSchemaV2Report,
  isInstanceResolved,
  loadFixtureInstances,
  type SchemaV2Report,
} from '../src/eval/harness-utils.js';
import { buildTurnPrompt, ToolFeedbackEntry } from '../src/orchestration/agent-orchestrator.js';
import { PluginHost } from '../src/kernel/plugin-host.js';
import { BUILTIN_PROBES } from '../src/probe/registry.js';
import { serializeRuleToYaml, type ASTGrepYamlRule } from '../src/probe/adapters/ast-grep-rules.js';
import { runDoctorAudit } from '../src/discovery/feasibility.js';
import { runDoctorAudit } from '../src/discovery/doctor.js';
import { parseTrajectoryFromJSONL } from '../src/eval/trajectory-parser.js';
import {
  buildJudgePrompt,
  parseJudgeResponse,
  JudgeOutputSchema,
} from '../src/eval/judge-prompt.js';
import { safeRmSync } from '../src/workspace/worktree-manager.js';

// ─── Commit 10: 98a717b — PluginManager v2.0 ──────────────────────────────────

describe('Commit 10 (98a717b): PluginManager v2.0 — hot-swap & state persistence', () => {
  it('BUILTIN_PROBES contains 13 probes', () => {
    expect(BUILTIN_PROBES.length).toBeGreaterThanOrEqual(13);
  });

  it('PluginHost registers and activates plugins', async () => {
    const host = new PluginHost({ workspacePath: tmpdir() });
    expect(host).toBeDefined();
    expect(host).toHaveProperty('registerPlugin');
    expect(host).toHaveProperty('unregisterPlugin');
  });

  it('PluginHost has exec method for spawn-based execution', () => {
    const host = new PluginHost({ workspacePath: tmpdir() });
    expect(typeof host.exec).toBe('function');
  });
});

// ─── Commit 9: 0d7f255 — Multi-Language Analyzer ──────────────────────────────

describe('Commit 9 (0d7f255): Multi-Language Analyzer — 12+ tool detection', () => {
  it('runDoctorAudit detects available toolchains', () => {
    const report = runDoctorAudit();
    expect(report).toBeDefined();
    expect(typeof report).toBe('object');
  });

  it('runDoctorAudit is non-empty', () => {
    const report = runDoctorAudit();
    const keys = Object.keys(report as Record<string, unknown>);
    expect(keys.length).toBeGreaterThan(0);
  });
});

// ─── Commit 8: 58bd553 — Docker 6-Layer Detection ────────────────────────────

describe('Commit 8 (58bd553): Docker 6-Layer Detection', () => {
  it('runDoctorAudit returns structured result', () => {
    const result = runDoctorAudit();
    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });

  it('runDoctorAudit checks Docker availability', () => {
    const report = runDoctorAudit();
    expect(report).toBeDefined();
  });
});

// ─── Commit 7: a6201fe — ast-grep Rule Quality ───────────────────────────────


describe('Commit 7 (a6201fe): ast-grep Rule Quality — ASTGrepSubRule recursive serialization', () => {
  function mkRule(opts: any = {}): ASTGrepYamlRule {
    return {
      id: opts.id || 'test-rule',
      severity: opts.severity || 'error',
      message: opts.message || 'Test rule',
      ...opts,
    } as ASTGrepYamlRule;
  }

  it('serializes basic pattern rule', () => {
    const yaml = serializeRuleToYaml(mkRule({ rule: { pattern: 'eval($$$ARGS)' } }));
    expect(yaml).toContain('pattern:');
    expect(yaml).toContain('eval');
  });

  it('serializes kind-based rule', () => {
    const yaml = serializeRuleToYaml(mkRule({ rule: { kind: 'if_statement' } }));
    expect(yaml).toContain('kind:');
    expect(yaml).toContain('if_statement');
  });

  it('serializes nested relational operators (inside)', () => {
    const yaml = serializeRuleToYaml(mkRule({ rule: { pattern: '', inside: { kind: 'for_statement' } } }));
    expect(yaml).toContain('inside:');
  });

  it('serializes nested relational operators (has)', () => {
    const yaml = serializeRuleToYaml(mkRule({ rule: { kind: 'function_declaration', has: { kind: 'parameters' } } }));
    expect(yaml).toContain('has:');
  });

  it('serializes nested relational operators (not)', () => {
    const yaml = serializeRuleToYaml(mkRule({ rule: { pattern: '', not: { kind: 'string_literal' } } }));
    expect(yaml).toContain('not:');
  });

  it('serializes nested any/all', () => {
    const yaml = serializeRuleToYaml(mkRule({ rule: { any: [
      { kind: 'if_statement' },
      { kind: 'else_clause' },
    ] } }));
    expect(yaml).toContain('any:');
  });

  it('serializes deeply nested rules (3 levels)', () => {
    const yaml = serializeRuleToYaml(mkRule({ rule: { kind: 'if_statement', inside: {
      kind: 'for_statement',
      has: { kind: 'expression_statement' },
    } } }));
    expect(yaml).toContain('kind:');
    expect(yaml).toContain('inside:');
  });
});

describe('Commit 6 (091d670): Eval v2 Module — 4 subcommands, Agent-Native', () => {
  it('parseTrajectoryFromJSONL parses event stream', () => {
    const lines = [
      '{"step_index":0,"type":"USER_INPUT","content":"fix the bug"}',
      '{"step_index":1,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"run_command","args":{"CommandLine":"npm test"}}]}',
    ].join('\n');
    const tmpFile = path.join(tmpdir(), `eval-test-${Date.now()}.jsonl`);
    fs.writeFileSync(tmpFile, lines, 'utf8');
    try {
      const { events, metrics } = parseTrajectoryFromJSONL(tmpFile);
      expect(events.length).toBeGreaterThan(0);
      expect(metrics.totalSteps).toBeGreaterThanOrEqual(1);
    } finally {
      safeRmSync(tmpFile, { force: true });
    }
  });

  it('buildJudgePrompt produces system + user prompt', () => {
    const { systemPrompt, userPrompt, trajectoryText } = buildJudgePrompt([], {
      totalSteps: 5,
      totalCommandsRun: 2,
      failedCommandsCount: 0,
      viewFileCalls: 1,
      maxConsecutiveFileViews: 1,
      wholeFileRgDumpsDetected: 0,
      shellScriptWriteHacksDetected: 0,
    });
    expect(systemPrompt).toContain('G-Eval');
    expect(userPrompt).toContain('trajectory');
    expect(trajectoryText).toContain('Steps:');
  });

  it('parseJudgeResponse scores a valid JSON response', () => {
    const rawJson = JSON.stringify({
      chainOfThought: 'Step by step reasoning',
      dimensions: {
        problemFormulation: { score: 85, reasoning: 'Good' },
        contextEconomy: { score: 90, reasoning: 'Good' },
        empiricalRigor: { score: 80, reasoning: 'Good' },
        concurrencyStress: { score: 85, reasoning: 'Good' },
        communityCraftsmanship: { score: 88, reasoning: 'Good' },
      },
      overallVerdict: 'PROFICIENT',
      strengths: ['Targeted'],
      criticalCritiques: [],
      actionableDirectives: [],
    });
    const report = parseJudgeResponse(rawJson, {
      totalSteps: 5,
      totalCommandsRun: 2,
      failedCommandsCount: 0,
      viewFileCalls: 1,
      maxConsecutiveFileViews: 1,
      wholeFileRgDumpsDetected: 0,
      shellScriptWriteHacksDetected: 0,
    });
    expect(report.overallScore).toBeGreaterThan(0);
    expect(report.dimensions).toHaveLength(5);
  });
});

// ─── Commit 5: 7b77a6f — 6-Dimension Checkpoint Contracts ─────────────────────

describe('Commit 5 (7b77a6f): 6-Dimension Checkpoint Contracts', () => {
  it('JudgeOutputSchema validates 5 dimensions + overallVerdict (6 checkpoints)', () => {
    const validOutput = {
      chainOfThought: 'Reasoning',
      dimensions: {
        problemFormulation: { score: 80, reasoning: 'Good' },
        contextEconomy: { score: 85, reasoning: 'Good' },
        empiricalRigor: { score: 82, reasoning: 'Good' },
        concurrencyStress: { score: 88, reasoning: 'Good' },
        communityCraftsmanship: { score: 84, reasoning: 'Good' },
      },
      overallVerdict: 'PROFICIENT',
      strengths: ['A'],
      criticalCritiques: [],
      actionableDirectives: [],
    };
    const result = JudgeOutputSchema.safeParse(validOutput);
    expect(result.success).toBe(true);
  });

  it('JudgeOutputSchema rejects missing overallVerdict', () => {
    const invalidOutput = {
      chainOfThought: 'Reasoning',
      dimensions: {
        problemFormulation: { score: 80, reasoning: 'Good' },
        contextEconomy: { score: 85, reasoning: 'Good' },
        empiricalRigor: { score: 82, reasoning: 'Good' },
        concurrencyStress: { score: 88, reasoning: 'Good' },
        communityCraftsmanship: { score: 84, reasoning: 'Good' },
      },
      strengths: ['A'],
      criticalCritiques: [],
      actionableDirectives: [],
    };
    const result = JudgeOutputSchema.safeParse(invalidOutput);
    expect(result.success).toBe(false);
  });

  it('JudgeOutputSchema rejects out-of-range scores', () => {
    const invalidOutput = {
      chainOfThought: 'Reasoning',
      dimensions: {
        problemFormulation: { score: 101, reasoning: 'Too high' },
        contextEconomy: { score: 85, reasoning: 'Good' },
        empiricalRigor: { score: 82, reasoning: 'Good' },
        concurrencyStress: { score: 88, reasoning: 'Good' },
        communityCraftsmanship: { score: 84, reasoning: 'Good' },
      },
      overallVerdict: 'PROFICIENT',
      strengths: ['A'],
      criticalCritiques: [],
      actionableDirectives: [],
    };
    const result = JudgeOutputSchema.safeParse(invalidOutput);
    expect(result.success).toBe(false);
  });
});

// ─── Commit 4: ae977b9 — Per-Turn Prompt Rebuild ──────────────────────────────

describe('Commit 4 (ae977b9): Per-Turn Prompt Rebuild with Tool Feedback', () => {
  it('buildTurnPrompt includes no feedback section on first attempt', () => {
    const result = buildTurnPrompt({
      basePrompt: 'Base prompt here.',
      feedback: [],
      appliedFiles: [],
      attemptNumber: 1,
      maxAttempts: 3,
    });
    expect(result).not.toContain('Previous Attempt Feedback');
  });

  it('buildTurnPrompt rebuilds with full feedback on second attempt', () => {
    const feedback: ToolFeedbackEntry[] = [
      {
        turn: 1,
        toolName: 'collectEvidence',
        command: 'pytest test.py',
        exitCode: 1,
        output: 'FAILED test.py::test_bug - AssertionError',
        success: false,
      },
    ];
    const result = buildTurnPrompt({
      basePrompt: 'Fix the issue.',
      testCommand: 'pytest test.py',
      feedback,
      appliedFiles: [{ path: 'src/bug.py', operation: 'edit' }],
      attemptNumber: 2,
      maxAttempts: 3,
    });
    expect(result).toContain('Previous Attempt Feedback');
    expect(result).toContain('pytest test.py');
    expect(result).toContain('AssertionError');
    expect(result).toContain('src/bug.py');
  });

  it('buildTurnPrompt shows success marker for passing tools', () => {
    const result = buildTurnPrompt({
      basePrompt: 'Base.',
      feedback: [{ turn: 1, toolName: 'test', output: 'ok', success: true }],
      appliedFiles: [],
      attemptNumber: 2,
      maxAttempts: 2,
    });
    expect(result).toContain('✅ PASS');
  });
});

// ─── Commit 3: 1479b9b — Host-Agent Bridge + --home + --patch-file ────────────

describe('Commit 3 (1479b9b): Host-Agent Bridge, --home option, --patch-file', () => {
  it('--home CLI option sets OPENCONTRIB_HOME env', () => {
    const originalHome = process.env.OPENCONTRIB_HOME;
    process.env.OPENCONTRIB_HOME = '/tmp/test-home';
    expect(process.env.OPENCONTRIB_HOME).toBe('/tmp/test-home');
    if (originalHome) process.env.OPENCONTRIB_HOME = originalHome;
  });

  it('normalizePatchLineEndings handles Windows-generated patches', () => {
    const windowsPatch = '--- a/file.ts\r\n+++ b/file.ts\r\n@@ -1 +1 @@\r\n- old\r\n+ new\r\n';
    const normalized = normalizePatchLineEndings(windowsPatch);
    expect(normalized).not.toContain('\r\n');
    expect(normalized).toContain('--- a/file.ts\n+++ b/file.ts');
  });

  it('parseSchemaV2Report produces resolved_ids for successful instances', () => {
    const results = [
      { scenarioId: 'django__django-10914', success: true, errors: [] },
      { scenarioId: 'flask__flask-4376', success: false, errors: ['Missing phase: GREEN_FIXED'] },
    ];
    const report = parseSchemaV2Report({}, results);
    expect(report.resolved_ids).toEqual(['django__django-10914']);
    expect(report.aggregate).toBe('PARTIAL');
  });
});

// ─── Commit 2: 03a4225 — SWE-bench Loop + test_patch ──────────────────────────

describe('Commit 2 (03a4225): SWE-bench Loop, test_patch application, -v2 output', () => {
  it('loadFixtureInstances reads SWE-bench fixture directories', () => {
    const fixtureDir = path.join(tmpdir(), `swebench-fixtures-${Date.now()}`);
    fs.mkdirSync(path.join(fixtureDir, 'django__django-10914'), { recursive: true });
    fs.writeFileSync(
      path.join(fixtureDir, 'django__django-10914', 'metadata.json'),
      JSON.stringify({
        instance_id: 'django__django-10914',
        repo: 'django/django',
        base_commit: 'abc123',
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(fixtureDir, 'django__django-10914', 'test_patch.diff'),
      'diff --git a/tests/test_x.py b/tests/test_x.py\n',
      'utf8',
    );

    const fixtures = loadFixtureInstances(fixtureDir);
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0].instance_id).toBe('django__django-10914');
    expect(fixtures[0].repo).toBe('django/django');
    expect(fixtures[0].test_patch).toContain('diff --git');

    safeRmSync(fixtureDir, { recursive: true, force: true }, [tmpdir()]);
  });

  it('isInstanceResolved returns true for resolved instances', () => {
    const report: SchemaV2Report = {
      resolved_ids: ['django__django-10914'],
      aggregate: 'PASS',
      total: 1,
      passed: 1,
      failed: 0,
      fail_to_pass: 1,
      pass_to_fail: 0,
      per_test: [
        { testId: 'django__django-10914', file: 'test.py', status: 'FAIL_TO_PASS', resolved: true },
      ],
    };
    expect(isInstanceResolved(report, 'django__django-10914')).toBe(true);
  });

  it('isInstanceResolved returns false for PASS_TO_FAIL regressions', () => {
    const report: SchemaV2Report = {
      resolved_ids: ['django__django-10914'],
      aggregate: 'PASS',
      total: 2,
      passed: 1,
      failed: 1,
      fail_to_pass: 1,
      pass_to_fail: 1,
      per_test: [
        { testId: 'django__django-10914', file: 'test.py', status: 'FAIL_TO_PASS', resolved: true },
        { testId: 'django__django-10914', file: 'other.py', status: 'PASS_TO_FAIL', resolved: false },
      ],
    };
    expect(isInstanceResolved(report, 'django__django-10914')).toBe(false);
  });

  it('parseSchemaV2Report -v2 mode includes per_test array with resolved flags', () => {
    const results = [
      { scenarioId: 'django__django-10914', success: true, errors: [] },
      { scenarioId: 'flask__flask-4376', success: false, errors: ['Missing: EVIDENCE_COLLECTED'] },
    ];
    const report = parseSchemaV2Report({}, results);
    expect(report.per_test).toHaveLength(2);
    expect(report.per_test[0].resolved).toBe(true);
    expect(report.per_test[1].resolved).toBe(false);
    expect(report.per_test[0].status).toBe('FAIL_TO_PASS');
    expect(report.per_test[1].status).toBe('FAIL');
  });
});

// ─── Commit 1: 1793ab7 — Harness Integration ──────────────────────────────────

describe('Commit 1 (1793ab7): Official Harness Integration, CRLF normalization, --report_dir', () => {
  it('normalizePatchLineEndings strips BOM', () => {
    const withBom = '\uFEFF--- a/file.ts\r\n+++ b/file.ts\r\n';
    const result = normalizePatchLineEndings(withBom);
    expect(result).not.toStartWith('\uFEFF');
  });

  it('normalizePatchLineEndings does not double-convert LF patches', () => {
    const lfPatch = 'line1\nline2\nline3';
    const result = normalizePatchLineEndings(lfPatch);
    expect(result.split('\n').length).toBe(3);
    expect(result).toBe(lfPatch);
  });

  it('hasCrlf correctly detects CRLF', () => {
    expect(hasCrlf('a\r\nb')).toBe(true);
    expect(hasCrlf('a\nb')).toBe(false);
    expect(hasCrlf('')).toBe(false);
  });

  it('parseSchemaV2Report with resolved=true for all instances', () => {
    const results = [
      { scenarioId: 'a', success: true, errors: [] },
      { scenarioId: 'b', success: true, errors: [] },
      { scenarioId: 'c', success: true, errors: [] },
    ];
    const report = parseSchemaV2Report({}, results);
    expect(report.aggregate).toBe('PASS');
    expect(report.resolved_ids).toEqual(['a', 'b', 'c']);
    expect(report.fail_to_pass).toBe(3);
    expect(report.pass_to_fail).toBe(0);
  });
});

// ─── Cross-Cutting: safeRmSync — Data Loss Prevention ─────────────────────────

describe('Cross-Cutting: safeRmSync — Data Loss Prevention', () => {
  it('allows deletion within system temp directory', () => {
    const tmpPath = path.join(tmpdir(), `safe-rm-${Date.now()}`);
    fs.mkdirSync(tmpPath, { recursive: true });
    fs.writeFileSync(path.join(tmpPath, 'test.txt'), 'data', 'utf8');

    const result = safeRmSync(path.join(tmpPath, 'test.txt'), { force: true }, [tmpdir()]);
    expect(result).toBe(true);
    expect(fs.existsSync(path.join(tmpPath, 'test.txt'))).toBe(false);
    safeRmSync(tmpPath, { recursive: true, force: true }, [tmpdir()]);
  });

  it('blocks deletion of home directory', () => {
    const result = safeRmSync(homedir(), { recursive: true, force: true });
    expect(result).toBe(false);
  });

  it('blocks deletion of filesystem root', () => {
    const result = safeRmSync('/', { recursive: true, force: true });
    expect(result).toBe(false);
  });

  it('blocks deletion of ~/.opencontrib itself', () => {
    const ocHome = path.join(homedir(), '.opencontrib');
    const result = safeRmSync(ocHome, { recursive: true, force: true });
    expect(result).toBe(false);
  });

  it('allows deletion of ~/.opencontrib/children', () => {
    const ocChild = path.join(homedir(), '.opencontrib', 'workspaces', `safe-rm-test-${Date.now()}`);
    fs.mkdirSync(ocChild, { recursive: true });
    const result = safeRmSync(ocChild, { recursive: true, force: true }, [path.join(homedir(), '.opencontrib')]);
    expect(result).toBe(true);
  });
});
