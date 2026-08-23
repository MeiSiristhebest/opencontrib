/**
 * Official SWE-bench harness integration utilities.
 *
 * These functions bridge opencontrib's internal eval format with the
 * SWE-bench official grading harness schema.
 *
 * Key responsibilities:
 *  - CRLF → LF normalization for model patches (Windows agents produce CRLF)
 *  - Schema-v2 aggregate report parsing (resolved_ids, per-test verdicts)
 *  - Fixture instance loading from SWE-bench fixture directories
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── CRLF Normalization ───────────────────────────────────────────────────────

/**
 * Normalize a model-generated patch to LF line endings.
 * Windows agents (cmd.exe, PowerShell) often produce CRLF in patches.
 * The SWE-bench grading harness expects LF. Without normalization,
 * `git apply` or `patch` fails on Windows-generated patches.
 */
export function normalizePatchLineEndings(patch: string): string {
  // Strip any BOM that some Windows editors inject
  const withoutBom = patch.replace(/^\uFEFF/, '');
  // Normalize CRLF → LF everywhere (preserve standalone \r characters)
  return withoutBom.replace(/\r\n/g, '\n');
}

/**
 * Check if a patch contains CRLF line endings.
 */
export function hasCrlf(patch: string): boolean {
  return /\r\n/.test(patch);
}

// ─── Schema-v2 Report Parsing ─────────────────────────────────────────────────

export interface PerTestVerdict {
  testId: string;
  file: string;
  status: 'PASS' | 'FAIL' | 'FAIL_TO_PASS' | 'PASS_TO_FAIL' | 'ERROR';
  resolved: boolean;
  durationMs?: number;
  output?: string;
}

export interface SchemaV2Report {
  resolved_ids: string[];
  aggregate: 'PASS' | 'FAIL' | 'PARTIAL';
  total: number;
  passed: number;
  failed: number;
  fail_to_pass: number;
  pass_to_fail: number;
  per_test: PerTestVerdict[];
}

/**
 * Parse benchmark results into the SWE-bench schema-v2 aggregate report format.
 * The official harness expects:
 *  - resolved_ids: array of instance IDs where the fix resolved all FAIL_TO_PASS tests
 *  - per_test: array of individual test verdicts
 *  - aggregate: PASS if all instance resolved, FAIL if none, PARTIAL otherwise
 */
export function parseSchemaV2Report(
  aggregate: Record<string, any>,
  results: { scenarioId: string; success: boolean; errors: string[] }[],
): SchemaV2Report {
  const resolvedIds = results.filter((r) => r.success).map((r) => r.scenarioId);
  const allPassed = results.length > 0 && results.every((r) => r.success);
  const allFailed = results.length > 0 && results.every((r) => !r.success);

  const perTest: PerTestVerdict[] = results.map((r) => {
    const failedPhases = r.errors.filter((e) => e.startsWith('Missing required'));
    return {
      testId: r.scenarioId,
      file: `${r.scenarioId}.patch`,
      status: r.success ? 'FAIL_TO_PASS' : 'FAIL',
      resolved: r.success,
      durationMs: aggregate.results?.find((rr: any) => rr.scenarioId === r.scenarioId)
        ?.durationMs,
      output: failedPhases.length > 0 ? failedPhases.join('; ') : undefined,
    };
  });

  const failToPass = perTest.filter((t) => t.status === 'FAIL_TO_PASS').length;
  const passToFail = perTest.filter((t) => t.status === 'PASS_TO_FAIL').length;

  return {
    resolved_ids: resolvedIds,
    aggregate: allPassed ? 'PASS' : allFailed ? 'FAIL' : 'PARTIAL',
    total: results.length,
    passed: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    fail_to_pass: failToPass,
    pass_to_fail: passToFail,
    per_test: perTest,
  };
}

// ─── Fixture Instance Loading ─────────────────────────────────────────────────

export interface SwebenchFixture {
  instance_id: string;
  repo: string;
  base_commit: string;
  test_patch?: string;
  gold_patch?: string;
  hints_text?: string;
  problem_statement?: string;
}

/**
 * Load SWE-bench fixture instances from a fixtures directory.
 *
 * Directory structure expected:
 *   fixtures/
 *     <instance_id>/
 *       metadata.json     (instance_id, repo, base_commit)
 *       test_patch.diff   (official test patch to apply before grading)
 *       gold_patch.diff   (reference solution, for validation only)
 *
 * Returns instance IDs in stable sort order.
 */
export function loadFixtureInstances(fixtureDir: string): SwebenchFixture[] {
  if (!fs.existsSync(fixtureDir)) {
    return [];
  }

  const entries = fs.readdirSync(fixtureDir).filter((e) =>
    fs.statSync(path.join(fixtureDir, e)).isDirectory(),
  ).sort();

  const fixtures: SwebenchFixture[] = [];
  for (const dir of entries) {
    const metaPath = path.join(fixtureDir, dir, 'metadata.json');
    let instance: SwebenchFixture | undefined;

    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as Partial<SwebenchFixture>;
        instance = {
          instance_id: meta.instance_id || dir,
          repo: meta.repo || '',
          base_commit: meta.base_commit || '',
          test_patch: meta.test_patch,
          gold_patch: meta.gold_patch,
          hints_text: meta.hints_text,
          problem_statement: meta.problem_statement,
        };
      } catch {
        // Malformed metadata — fall through to defaults
      }
    }

    if (!instance) {
      instance = { instance_id: dir, repo: '', base_commit: '' };
    }

    // Resolve test_patch and gold_patch paths if they exist as files
    const testPatchFile = path.join(fixtureDir, dir, 'test_patch.diff');
    if (!instance.test_patch && fs.existsSync(testPatchFile)) {
      instance.test_patch = fs.readFileSync(testPatchFile, 'utf8');
    }
    const goldPatchFile = path.join(fixtureDir, dir, 'gold_patch.diff');
    if (!instance.gold_patch && fs.existsSync(goldPatchFile)) {
      instance.gold_patch = fs.readFileSync(goldPatchFile, 'utf8');
    }

    fixtures.push(instance);
  }

  return fixtures;
}

/**
 * Check if an instance is resolved based on schema-v2 report.
 * A instance is resolved when ALL its FAIL_TO_PASS tests pass after applying the fix.
 * The official harness marks resolved=true only when there are zero remaining
 * FAIL_TO_PASS tests and zero PASS_TO_FAIL regressions.
 */
export function isInstanceResolved(report: SchemaV2Report, instanceId: string): boolean {
  const instanceVerdicts = report.per_test.filter((t) => t.testId === instanceId);
  if (instanceVerdicts.length === 0) return false;

  // Resolved = ALL FAIL_TO_PASS tests pass AND no regressions
  const allFailToPassResolved = instanceVerdicts.every((t) => t.status !== 'FAIL_TO_PASS' || t.resolved);
  const hasPassToFail = instanceVerdicts.some((t) => t.status === 'PASS_TO_FAIL');
  return allFailToPassResolved && !hasPassToFail;
}
