import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PROTOCOL_DOC_END,
  PROTOCOL_DOC_START,
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
  const semanticErrors: string[] = [];
  for (const target of PROTOCOL_DOCUMENTATION_TARGETS) {
    try {
      checkProtocolDocumentationSemantics(readFileSync(resolve(rootDir, target.path), "utf8"), target.path);
    } catch (error) {
      semanticErrors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (semanticErrors.length) {
    throw new Error(semanticErrors.join("\n"));
  }
}

/** Detect contradictory handwritten instructions outside generated sections. */
export function checkProtocolDocumentationSemantics(content: string, path: string): void {
  const handwritten = content.replace(
    new RegExp(`${escapeRegExp(PROTOCOL_DOC_START)}[\\s\\S]*?${escapeRegExp(PROTOCOL_DOC_END)}`, "g"),
    "",
  );
  const problems: string[] = [];
  if (/(?:Auto-configure MCP|自动[^\n]*MCP)[^\n]*\r?\n(?:[^\n]*\r?\n){0,2}npx -y @opencontrib\/cli setup/i.test(handwritten) || /\|\s*`setup`\s*\|[^\n]*MCP/i.test(handwritten)) problems.push("MCP configuration must use @opencontrib/mcp setup --all");

  const normalized = handwritten.replace(/\s+/g, " ");
  for (const sentence of normalized.split(/[.!?。！？]+/)) {
    const legacyCoverage = /85\s*%?[^.!?。！？]{0,120}statement[^.!?。！？]{0,80}(?:branch|line)[^.!?。！？]{0,40}coverage/i.test(sentence);
    const requirement = /\b(?:must|shall|required|requires|require|should|achieve|target|minimum)\b/i.test(sentence);
    const negated = /\b(?:do not|does not|did not|must not|should not|never|cannot|can't|isn't|not to)\b/i.test(sentence);
    if (legacyCoverage && requirement && !negated) problems.push("coverage must follow the trusted changed-line policy");
  }

  if (/physically (?:prevent|block)[^\n]*PR|物理阻断[^\n]*PR/i.test(handwritten)) problems.push("protocol exit codes do not provide physical credential isolation");

  for (const diagram of handwritten.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)) {
    const source = diagram[1];
    const labels = new Map<string, string>();
    const normalizedDiagram = source.replace(/\b([A-Za-z_][\w-]*)\s*\[\s*["']?([^\]]+?)["']?\s*\]/g, (_match, id: string, label: string) => {
      labels.set(id, label);
      return id;
    });
    const start = [...labels].find(([, label]) => /Prepare Workspace/i.test(label))?.[0];
    const destination = [...labels].find(([, label]) => /Assemble Context/i.test(label))?.[0];
    if (!start || !destination) continue;
    const edges = new Map<string, Set<string>>();
    for (const line of normalizedDiagram.split(/\r?\n/)) {
      const nodes = line.split(/(?:-->|==>|-\.->|---|~~~>|==>>)/).map(value => value.trim().match(/^[A-Za-z_][\w-]*/)?.[0]).filter((node): node is string => Boolean(node));
      for (let index = 0; index < nodes.length - 1; index++) {
        const next = edges.get(nodes[index]) ?? new Set<string>();
        next.add(nodes[index + 1]);
        edges.set(nodes[index], next);
      }
    }
    const pending = [start];
    const visited = new Set<string>();
    let reachesContext = false;
    while (pending.length) {
      const node = pending.pop()!;
      if (node === destination) {
        reachesContext = true;
        break;
      }
      if (visited.has(node)) continue;
      visited.add(node);
      pending.push(...(edges.get(node) ?? []));
    }
    if (!reachesContext) problems.push("workspace must precede context assembly in the Mermaid lifecycle graph");
  }

  if (/skills\/opencontrib-cli\/references\/workflow\.md$/i.test(path)) {
    const phaseOne = /### Phase 1\b([\s\S]*?)(?=### Phase 2\b)/i.exec(handwritten)?.[1] ?? "";
    const commands = [...phaseOne.matchAll(/^\s*opencontrib\s+(run\s+create|doctor|scout|probe|workspace|discovery|evidence|pointer|governance|submission|flywheel)\b/gim)].map(match => match[1].replace(/\s+/g, " ").toLowerCase());
    if (commands.length && commands[0] !== "run create") problems.push("create the canonical run before running doctor or other lifecycle commands");
  }

  if (/^(?:.*[/\\])?CLAUDE\.md$/i.test(path)) {
    const protocol = /##\s+🚀 Quick Execution Protocol([\s\S]*?)(?=##\s|$)/i.exec(handwritten)?.[1] ?? "";
    const commands = [...protocol.matchAll(/^\s*opencontrib\s+(run\s+create|doctor|scout|probe|workspace|discovery|evidence|pointer|governance|submission|flywheel)\b/gim)].map(match => match[1].replace(/\s+/g, " ").toLowerCase());
    if (commands.length && commands[0] !== "run create") problems.push("create the canonical run before running doctor or other lifecycle commands");
    const templateAt = protocol.indexOf("opencontrib governance pr-template");
    const auditAt = protocol.indexOf("opencontrib governance audit");
    if (templateAt >= 0 && auditAt >= 0 && auditAt < templateAt) problems.push("create the PR draft before the governance audit");
  }
  if (problems.length) throw new Error(`Protocol documentation semantics drift in ${path}: ${problems.join("; ")}.`);
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const rootDir = resolve(import.meta.dir, "..");
  if (check) checkProtocolDocs(rootDir);
  else generateProtocolDocs(rootDir);
}
