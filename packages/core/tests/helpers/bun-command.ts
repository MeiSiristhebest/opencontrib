import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Build a direct command for a Bun fixture used by sandbox/evidence tests.
 *
 * Using process.execPath avoids starting an OS shell just to print a marker.
 * Normalize Windows separators because parseCommandSpec treats backslashes
 * as escapes, then JSON-quote both the executable and inline source.
 */
function quoteCommandArgument(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function bunCommand(source: string): string {
  const executable = process.execPath.replace(/\\/g, "/");
  return `${quoteCommandArgument(executable)} -e ${quoteCommandArgument(source)}`;
}

export function bunTestCommand(
  source: string,
  workspaceRoot = tmpdir(),
): { command: string; cleanup: () => void } {
  const fixtureDir = mkdtempSync(join(workspaceRoot, ".tmp-opencontrib-bun-test-"));
  const fixturePath = join(fixtureDir, "fixture.ts");
  writeFileSync(fixturePath, source.endsWith("\n") ? source : `${source}\n`);
  const executable = process.execPath.replace(/\\/g, "/");
  return {
    command: `${quoteCommandArgument(executable)} test ${quoteCommandArgument(fixturePath.replace(/\\/g, "/"))}`,
    cleanup: () => rmSync(fixtureDir, { recursive: true, force: true }),
  };
}

export function stateAssertionCommand(
  stateFile: string,
  assertion: string,
): string {
  const statePath = JSON.stringify(stateFile.replace(/\\/g, "/"));
  const source = [
    'import { expect, test } from "bun:test";',
    'import { readFileSync } from "node:fs";',
    `test("immutable regression", () => expect(readFileSync(${statePath}, "utf8"), ${JSON.stringify(assertion)}).not.toContain("FAIL"));`,
  ].join("\n");
  const suffix = createHash("sha256").update(`${stateFile}\0${assertion}`).digest("hex").slice(0, 12);
  const fixture = join(dirname(stateFile), `regression-${suffix}.test.ts`);
  writeFileSync(fixture, `${source}\n`);
  return `${quoteCommandArgument(process.execPath.replace(/\\/g, "/"))} test ${quoteCommandArgument(fixture.replace(/\\/g, "/"))}`;
}
