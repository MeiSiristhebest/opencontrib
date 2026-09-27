import { describe, expect, it } from "bun:test";
import { isTestEntrypoint } from "../src/utils/entrypoint.js";

describe("CLI test entry detection", () => {
  it("does not classify an install by an ancestor directory name", () => {
    expect(
      isTestEntrypoint(
        "C:\\work\\test\\app\\node_modules\\@opencontrib\\cli\\dist\\index.js",
      ),
    ).toBe(false);
    expect(
      isTestEntrypoint("/opt/tests/install/packages/cli/dist/index.js"),
    ).toBe(false);
  });

  it("recognizes entries directly in test directories and test filenames", () => {
    expect(
      isTestEntrypoint("C:\\repo\\packages\\cli\\tests\\cli_commands.test.ts"),
    ).toBe(true);
    expect(isTestEntrypoint("/repo/packages/cli/__tests__/index.js")).toBe(
      true,
    );
    expect(isTestEntrypoint("/repo/src/parser.spec.mts")).toBe(true);
  });
});
