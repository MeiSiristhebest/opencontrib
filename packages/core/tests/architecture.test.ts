/**
 * Architecture guardrails (review §9.2 / §15.4 / Stage 5).
 *
 * These tests encode the layering rules as executable checks so regressions
 * (e.g. a `process.env` creeping into the ports layer) fail CI instead of
 * silently rotting the hexagon.
 *
 * The test files themselves may use `node:fs` — the forbidden patterns are only
 * asserted against the *source* under ports/ / testkit/ (and domain/ once it
 * exists).
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', 'src');

// Patterns that must never appear in the dependency-inverted layers.
// Infrastructure I/O (fs / child_process / process.env) is forbidden everywhere
// in the dependency-inverted layers.
const FORBIDDEN_INFRA = [
  /from\s+['"]node:fs['"]/,
  /from\s+['"]node:child_process['"]/,
  /from\s+['"]fs['"]/,
  /from\s+['"]child_process['"]/,
  /process\.env/,
  /process\.cwd\(\)/,
];

// Non-injectable global non-determinism (Date.now / Math.random) is forbidden
// in the *pure* layers (domain / application / reporting) — they must receive
// time and id sources through ports (Clock / IdGenerator). It IS allowed in
// `ports/` and `testkit/`, which host the legitimate default implementations
// (SystemClock, RandomIdGenerator) that encapsulate those globals.
const FORBIDDEN_NON_DETERMINISM = [
  /\bDate\.now\(\)/,
  /\bMath\.random\(\)/,
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function assertClean(dir: string, label: string, patterns: RegExp[] = FORBIDDEN_INFRA): void {
  if (!existsSync(dir)) return; // layer not extracted yet — skip gracefully
  for (const file of walk(dir)) {
    const src = readFileSync(file, 'utf8');
    for (const re of patterns) {
      if (re.test(src)) {
        throw new Error(`Architecture violation in ${label}: ${file} contains forbidden pattern ${re}`);
      }
    }
  }
}

describe('Architecture guardrails', () => {
  test('ports/ layer is infrastructure-free (no fs / child_process / process.env)', () => {
    // ports/ hosts default impls (SystemClock, RandomIdGenerator) that may
    // wrap Date.now/Math.random — only infra I/O is forbidden here.
    assertClean(join(SRC, 'ports'), 'ports', FORBIDDEN_INFRA);
  });

  test('testkit/ layer is infrastructure-free', () => {
    assertClean(join(SRC, 'testkit'), 'testkit', FORBIDDEN_INFRA);
  });

  test('domain/ layer stays pure (no infra I/O, no Date.now/Math.random)', () => {
    assertClean(join(SRC, 'domain'), 'domain', [
      ...FORBIDDEN_INFRA,
      ...FORBIDDEN_NON_DETERMINISM,
    ]);
  });

  test('application/ use-case layer stays pure (no infra I/O, no Date.now/Math.random)', () => {
    assertClean(join(SRC, 'application'), 'application', [
      ...FORBIDDEN_INFRA,
      ...FORBIDDEN_NON_DETERMINISM,
    ]);
  });

  test('reporting/ layer stays side-effect-free (no infra I/O, no Date.now/Math.random)', () => {
    assertClean(join(SRC, 'reporting'), 'reporting', [
      ...FORBIDDEN_INFRA,
      ...FORBIDDEN_NON_DETERMINISM,
    ]);
  });

  test('ports/ and testkit/ actually exist and are non-empty', () => {
    expect(walk(join(SRC, 'ports')).length).toBeGreaterThan(0);
    expect(walk(join(SRC, 'testkit')).length).toBeGreaterThan(0);
  });
});
