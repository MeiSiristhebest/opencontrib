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
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const rootDir = resolve(import.meta.dir, "..");
  if (check) checkProtocolDocs(rootDir);
  else generateProtocolDocs(rootDir);
}
