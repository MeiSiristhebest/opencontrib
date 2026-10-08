import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCommandSpec, type CommandSpec } from "../../sandbox/command-spec.js";
import { defaultTestOutputParserRegistry } from "./registry.js";
import type { ParsedTestCounts } from "./types.js";

const emptyCounts = (): ParsedTestCounts => ({ passed: 0, failed: 0, total: 0 });
const executableName = (spec: CommandSpec) => spec.executable.replace(/\\/g, "/").split("/").pop()?.replace(/\.(?:exe|cmd)$/i, "").toLowerCase();

/** Resolve known test runners, including simple package scripts, without executing them. */
export function resolveTestRunnerCommand(command: string, cwd: string, depth = 0): CommandSpec | undefined {
  if (depth > 3) return undefined;
  const spec = parseCommandSpec(command);
  if (spec.args.some(arg => /^(?:&&|\|\||\||;|>|>>|<)$/.test(arg))) return undefined;
  const name = executableName(spec);
  const args = spec.args;
  if ((name === "bun" && args[0] === "test") || (name === "node" && args.some(arg => arg === "--test")) ||
      (name === "go" && args[0] === "test") || (name === "cargo" && args[0] === "test") ||
      (name === "dotnet" && args[0] === "test") || (name === "ctest") ||
      ["pytest", "vitest", "jest", "mocha", "rspec", "phpunit"].includes(name ?? "") ||
      (["python", "python3"].includes(name ?? "") && args[0] === "-m" && args[1] === "pytest") ||
      (["mvn", "mvnw", "gradle", "gradlew"].includes(name ?? "") && args.includes("test"))) return spec;
  if (name === "bunx" || name === "npx") {
    const index = args.findIndex(arg => !arg.startsWith("-"));
    if (index < 0) return undefined;
    return resolveTestRunnerCommand([args[index], ...args.slice(index + 1)].join(" "), cwd, depth + 1);
  }
  if (!["npm", "pnpm", "yarn", "bun"].includes(name ?? "")) return undefined;
  const script = args[0] === "run" || args[0] === "run-script" ? args[1] : args[0];
  if (!script || script.startsWith("-")) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    const source = pkg.scripts?.[script];
    if (typeof source !== "string") return undefined;
    return resolveTestRunnerCommand(source, cwd, depth + 1);
  } catch {
    return undefined;
  }
}

/** Go evidence must execute fresh, individual tests rather than cached package summaries. */
export function prepareTestExecutionSpec(command: string): CommandSpec {
  const spec = parseCommandSpec(command);
  if (executableName(spec) === "go" && spec.args[0] === "test") {
    const args = spec.args.slice(1);
    for (let index = args.length - 1; index >= 0; index--) {
      if (/^-count=/.test(args[index])) args.splice(index, 1);
      else if (args[index] === "-count") args.splice(index, 2);
    }
    spec.args = ["test", "-count=1", "-v", ...args];
  }
  if (executableName(spec) === "bun" && spec.args[0] === "test" && spec.args.includes("--coverage") &&
      spec.args.some(arg => arg === "--coverage-reporter=lcov" || (arg === "--coverage-reporter" && spec.args[spec.args.indexOf(arg) + 1] === "lcov")) &&
      !spec.args.some(arg => arg === "--coverage-dir" || arg.startsWith("--coverage-dir="))) {
    // Explicitly override bunfig.toml so the instrumenter and reader use the same directory.
    spec.args.push("--coverage-dir=coverage");
  }
  return spec;
}

/** Only counts from the invoked runner's own output format are authoritative. */
export function parseExecutedTestCounts(output: string, command: string, cwd: string): ParsedTestCounts {
  const spec = resolveTestRunnerCommand(command, cwd);
  if (!spec) return emptyCounts();
  const name = executableName(spec);
  if (name === "go" && output.includes("(cached)")) return emptyCounts();
  const parserId = ["bun", "node", "vitest", "jest", "mocha"].includes(name ?? "") ? "node-jest-vitest-bun" :
    name === "go" ? "go-test" : name === "cargo" ? "cargo-test" :
    ["pytest", "python", "python3"].includes(name ?? "") ? "pytest" :
    name === "dotnet" ? "dotnet-test" : name === "ctest" ? "cpp-gtest" :
    name === "rspec" ? "ruby-rspec" : name === "phpunit" ? "php-phpunit" : "java-junit";
  const parser = defaultTestOutputParserRegistry.getParsers().find(item => item.id === parserId);
  const counts = parser?.parse(output.replace(/\x1b\[[0-9;]*m/g, ""), name) ?? emptyCounts();
  return [counts.passed, counts.failed, counts.total].every(value => Number.isSafeInteger(value) && value >= 0) ? counts : emptyCounts();
}

/** Supported LCOV instrumenter invocation; callers supply the actual execution spec. */
export function bunLcovReportPath(spec: CommandSpec): string | undefined {
  if (executableName(spec) !== "bun" || spec.args[0] !== "test" || !spec.args.includes("--coverage")) return undefined;
  const option = (name: string) => {
    const inline = spec.args.filter(arg => arg.startsWith(`${name}=`)).at(-1);
    if (inline) return inline.slice(name.length + 1);
    const index = spec.args.lastIndexOf(name);
    return index < 0 ? undefined : spec.args[index + 1];
  };
  if (option("--coverage-reporter") !== "lcov") return undefined;
  const directory = option("--coverage-dir");
  return directory ? join(directory, "lcov.info") : undefined;
}
