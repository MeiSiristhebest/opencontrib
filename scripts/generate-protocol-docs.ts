import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  renderMarkedProtocolDocumentationBlock,
  type ProtocolDocumentationLocale,
} from "../packages/core/src/workflow/protocol-renderer.ts";

export interface ProtocolDocumentationTarget {
  path: string;
  locale: ProtocolDocumentationLocale;
}

export const PROTOCOL_DOCUMENTATION_TARGETS: readonly ProtocolDocumentationTarget[] =
  [
    { path: "AGENTS.md", locale: "en" },
    { path: "CLAUDE.md", locale: "en" },
    { path: ".cursorrules", locale: "en" },
    { path: ".cursor/rules/opencontrib.mdc", locale: "en" },
    { path: "README.md", locale: "en" },
    { path: "README_zh.md", locale: "zh" },
    { path: "skills/opencontrib-cli/SKILL.md", locale: "en" },
    { path: "skills/opencontrib-cli/references/workflow.md", locale: "en" },
    { path: "skills/opencontrib-cli/references/evidence.md", locale: "en" },
    { path: "skills/opencontrib-cli/references/governance.md", locale: "en" },
    { path: "DEVELOPMENT_SOP.md", locale: "zh" },
  ] as const;

function replaceGeneratedBlock(
  source: string,
  target: ProtocolDocumentationTarget,
): string {
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const replacement = renderMarkedProtocolDocumentationBlock(
    target.locale,
  ).replace(/\n/g, newline);
  const start = replacement.slice(0, replacement.indexOf(newline));
  const end = replacement.slice(replacement.lastIndexOf(newline) + newline.length);
  const markerPattern = new RegExp(
    `${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`,
  );
  if (!markerPattern.test(source)) {
    throw new Error(
      `Protocol documentation marker pair is missing from ${target.path}.`,
    );
  }
  return source.replace(markerPattern, replacement);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function generateProtocolDocs(
  rootDir = process.cwd(),
  options: { check?: boolean } = {},
): { changed: string[] } {
  const changed: string[] = [];
  for (const target of PROTOCOL_DOCUMENTATION_TARGETS) {
    const filePath = resolve(rootDir, target.path);
    const source = readFileSync(filePath, "utf8");
    const generated = replaceGeneratedBlock(source, target);
    if (generated === source) continue;
    changed.push(target.path);
    if (!options.check) writeFileSync(filePath, generated, "utf8");
  }
  return { changed };
}

export function checkProtocolDocs(rootDir = process.cwd()): void {
  const result = generateProtocolDocs(rootDir, { check: true });
  if (result.changed.length > 0) {
    throw new Error(
      `Generated protocol documentation is stale: ${result.changed.join(", ")}. Run bun run docs:generate.`,
    );
  }
  for (const target of PROTOCOL_DOCUMENTATION_TARGETS) {
    checkProtocolDocumentationSemantics(readFileSync(resolve(rootDir, target.path), "utf8"), target.path);
  }
}

/** Detect contradictory handwritten instructions outside generated sections. */
export function checkProtocolDocumentationSemantics(content: string, path: string): void {
  const problems: string[] = [];
  if (/(?:Auto-configure MCP|自动[^\n]*MCP)[^\n]*\r?\n(?:[^\n]*\r?\n){0,2}npx -y @opencontrib\/cli setup/i.test(content) || /\|\s*`setup`\s*\|[^\n]*MCP/i.test(content)) problems.push("MCP configuration must use @opencontrib/mcp setup --all");
  if (/85[^\n]{0,160}statement[^\n]*branch/i.test(content)) problems.push("coverage must follow the trusted changed-line policy");
  if (/physically (?:prevent|block)[^\n]*PR|物理阻断[^\n]*PR/i.test(content)) problems.push("protocol exit codes do not provide physical credential isolation");
  for (const diagram of content.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)) {
    const context = diagram[1].indexOf("Assemble Context");
    const workspace = diagram[1].indexOf("Prepare Workspace");
    if (context >= 0 && workspace >= 0 && context < workspace) problems.push("workspace must precede context assembly");
  }
  if (problems.length) throw new Error(`Protocol documentation semantics drift in ${path}: ${problems.join("; ")}.`);
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const rootDir = resolve(import.meta.dir, "..");
  if (check) checkProtocolDocs(rootDir);
  else generateProtocolDocs(rootDir);
}
