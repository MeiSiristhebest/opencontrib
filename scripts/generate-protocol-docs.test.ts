import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  checkProtocolDocs,
  checkProtocolDocumentationSemantics,
  PROTOCOL_DOCUMENTATION_TARGETS,
} from "./generate-protocol-docs.ts";
import {
  PROTOCOL_DOC_END,
  PROTOCOL_DOC_START,
  renderProtocolDocumentationBlock,
} from "../packages/core/src/workflow/protocol-renderer.ts";

describe("generated protocol documentation", () => {
  const rootDir = resolve(import.meta.dir, "..");

  const normalizeLineEndings = (value: string): string =>
    value.replace(/\r\n/g, "\n");

  it("keeps every marked protocol block in sync with the canonical renderer", () => {
    expect(() => checkProtocolDocs(rootDir)).not.toThrow();
    for (const target of PROTOCOL_DOCUMENTATION_TARGETS) {
      const content = normalizeLineEndings(
        readFileSync(resolve(rootDir, target.path), "utf8"),
      );
      expect(content).toContain(PROTOCOL_DOC_START);
      expect(content).toContain(PROTOCOL_DOC_END);
      expect(content).toContain(
        normalizeLineEndings(renderProtocolDocumentationBlock(target.locale)),
      );
    }
  });

  it("does not prescribe legacy diagnostic evidence or direct PR writes", () => {
    for (const target of PROTOCOL_DOCUMENTATION_TARGETS) {
      const content = readFileSync(resolve(rootDir, target.path), "utf8");
      expect(content).not.toContain("contrib_collect_evidence");
      expect(content).not.toMatch(/(?:^|\s)gh\s+pr\s+create(?:\s|$)/i);
    }
  });
  it("rejects conflicting handwritten setup, coverage, isolation, and lifecycle instructions", () => {
    for (const content of [
      "# Auto-configure MCP clients\nnpx -y @opencontrib/cli setup",
      "Tests must achieve 85% statement, branch and line coverage.",
      "Exit 2 physically prevents agents from opening PRs.",
      '```mermaid\ngraph LR\nP3["Assemble Context"] --> P4["Prepare Workspace"]\n```',
    ]) expect(() => checkProtocolDocumentationSemantics(content, "fixture.md")).toThrow(/Protocol documentation semantics drift/);
    expect(() => checkProtocolDocumentationSemantics("Toolchain: @opencontrib/cli setup. MCP: @opencontrib/mcp setup --all. Coverage is repository policy.", "fixture.md")).not.toThrow();
  });
});
