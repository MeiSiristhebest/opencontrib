/**
 * Domain coverage gate.
 *
 * bun's `bun test --coverage` has no built-in threshold flag, so this script
 * enforces the architecture-review requirement that every file under
 * `packages/core/src/domain/` maintains >= 85% line coverage. It runs the
 * domain-touching test suite with instrumentation and parses the text report.
 *
 * Why a curated test list (not the whole suite): bun's coverage instrumentation
 * currently conflicts with `mock.module`-based tests (e.g. pipeline_e2e), which
 * crash under coverage and would poison the measurement. The domain layer is
 * pure and never uses `mock.module`, so the curated set below exercises it
 * faithfully and deterministically.
 *
 * Usage: `bun scripts/check-domain-coverage.ts` (or `bun run coverage:gate`).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = join(HERE, '..'); // packages/core
const THRESHOLD = 85;

// Tests that load and exercise the pure domain layer without mock.module.
const DOMAIN_TESTS = [
  'tests/domain_matcher.test.ts',
  'tests/discovery.test.ts',
  'tests/risk_engine.test.ts',
  'tests/quality_audit.test.ts',
  'tests/governance.test.ts',
  'tests/community_gate.test.ts',
  'tests/markdown_validator.test.ts',
  'tests/defect_category.test.ts',
];

const result = spawnSync(
  'bun',
  ['test', '--coverage', '--coverage-reporter=text', ...DOMAIN_TESTS],
  { cwd: CORE_ROOT, encoding: 'utf-8' },
);

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

// Each coverage row looks like (path is relative to packages/core):
//   src\domain\matcher.ts   |   85.71 |  100.00 | ...
const rowRe = /src[\\/]domain[\\/]([\w.-]+\.ts)\s*\|\s*([\d.]+)/g;
const failures: Array<{ file: string; cov: number }> = [];
let matched = 0;

for (let m = rowRe.exec(output); m !== null; m = rowRe.exec(output)) {
  matched++;
  const file = m[1];
  const lineCov = parseFloat(m[2]);
  if (lineCov < THRESHOLD) {
    failures.push({ file, cov: lineCov });
  }
}

if (matched === 0) {
  console.error('No domain/ coverage rows were parsed — is `bun test --coverage` working?');
  process.exit(2);
}

console.log(`Measured ${matched} domain/ file(s) against the ${THRESHOLD}% line-coverage gate.`);

if (failures.length > 0) {
  console.error(`\n❌ Domain coverage gate FAILED (need >= ${THRESHOLD}% line coverage):`);
  for (const f of failures) {
    console.error(`   - ${f.file}: ${f.cov}%`);
  }
  process.exit(1);
}

console.log(`✅ All domain/ modules meet the >= ${THRESHOLD}% line-coverage gate.`);
process.exit(0);
