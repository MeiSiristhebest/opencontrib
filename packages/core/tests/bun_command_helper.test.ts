import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stateAssertionCommand } from "./helpers/bun-command.js";

test("state assertion fixtures do not overwrite each other in one directory", () => {
  const root = mkdtempSync(join(tmpdir(), "oc-bun-command-fixture-"));
  try {
    const firstState = join(root, "first.txt");
    const secondState = join(root, "second.txt");
    writeFileSync(firstState, "FAIL\n");
    writeFileSync(secondState, "FAIL\n");

    const firstCommand = stateAssertionCommand(firstState, "FIRST_ASSERTION");
    const secondCommand = stateAssertionCommand(secondState, "SECOND_ASSERTION");

    expect(firstCommand).not.toBe(secondCommand);
    const fixtures = readdirSync(root).filter(name => /^regression-[a-f0-9]{12}\.test\.ts$/.test(name));
    expect(fixtures).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
