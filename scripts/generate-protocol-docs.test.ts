import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  checkProtocolDocs,
  checkProtocolDocumentationSemantics,
  PROTOCOL_DOCUMENTATION_TARGETS,
} from "./generate-protocol-docs.ts";
import {
  PROTOCOL_DOC_END,
  PROTOCOL_DOC_START,
  renderMarkedProtocolDocumentationBlock,
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
      "# 自动配置 MCP\nnpx -y @opencontrib/cli setup",
      "| `setup` | configure MCP for clients |",
      "Tests must achieve 85% statement, branch and line coverage.",
      "Exit 2 physically prevents agents from opening PRs.",
      "Exit 2 会物理阻断 PR 创建。",
      '```mermaid\ngraph LR\nP3["Assemble Context"] --> P4["Prepare Workspace"]\n```',
    ]) expect(() => checkProtocolDocumentationSemantics(content, "fixture.md")).toThrow(/Protocol documentation semantics drift/);
    expect(() => checkProtocolDocumentationSemantics("Toolchain: @opencontrib/cli setup. MCP: @opencontrib/mcp setup --all. Coverage is repository policy.", "fixture.md")).not.toThrow();
    expect(() => checkProtocolDocumentationSemantics("Do not require 85% statement, branch or line coverage.", "fixture.md")).not.toThrow();
  });

  it("checks Mermaid execution edges instead of declaration order", () => {
    const valid = [
      "```mermaid",
      "graph LR",
      'C["Assemble Context"]',
      'W["Prepare Workspace"]',
      "W --> C",
      "```",
    ].join("\n");
    const reversed = valid.replace("W --> C", "C --> W");
    expect(() => checkProtocolDocumentationSemantics(valid, "diagram.md")).not.toThrow();
    expect(() => checkProtocolDocumentationSemantics(reversed, "diagram.md")).toThrow(/workspace must precede context assembly/);
  });

  it("checks run-first and PR-draft-before-governance order in workflow guides", () => {
    expect(() => checkProtocolDocumentationSemantics([
      "### Phase 1: Initialize",
      "```sh",
      "opencontrib doctor",
      "opencontrib run create --repo owner/repo",
      "```",
      "### Phase 2: Probe",
    ].join("\n"), "skills/opencontrib-cli/references/workflow.md")).toThrow(/create the canonical run before running doctor/);
    expect(() => checkProtocolDocumentationSemantics([
      "## 🚀 Quick Execution Protocol",
      "1. Start:",
      "```sh",
      "opencontrib run create --repo owner/repo",
      "opencontrib doctor",
      "```",
      "6. Audit:",
      "```sh",
      "opencontrib governance audit",
      "opencontrib governance pr-template",
      "```",
    ].join("\n"), "CLAUDE.md")).toThrow(/create the PR draft before the governance audit/);
  });

  it("ignores generated protocol text and reports semantic drift in every target", () => {
    const generatedOnly = [
      "Handwritten instructions are clear.",
      PROTOCOL_DOC_START,
      "Tests must achieve 85% statement, branch and line coverage.",
      PROTOCOL_DOC_END,
    ].join("\n");
    expect(() => checkProtocolDocumentationSemantics(generatedOnly, "fixture.md")).not.toThrow();

    const root = mkdtempSync(join(tmpdir(), "oc-docs-check-"));
    try {
      for (const target of PROTOCOL_DOCUMENTATION_TARGETS) {
        const file = resolve(root, target.path);
        mkdirSync(dirname(file), { recursive: true });
        const drift = target.path === "README.md"
          ? "Tests must achieve 85% statement, branch and line coverage."
          : target.path === "README_zh.md"
            ? "Exit 2 物理阻断 PR 创建。"
            : "No semantic drift.";
        writeFileSync(file, `${drift}\n\n${renderMarkedProtocolDocumentationBlock(target.locale)}\n`);
      }
      expect(() => checkProtocolDocs(root)).toThrow(/README\.md[\s\S]*README_zh\.md/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
