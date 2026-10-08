import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseCommandSpec, type CommandSpec } from "../../sandbox/command-spec.js";
import { defaultTestOutputParserRegistry } from "./registry.js";
import type { ParsedTestCounts } from "./types.js";

const emptyCounts = (): ParsedTestCounts => ({ passed: 0, failed: 0, total: 0 });
const executableName = (spec: CommandSpec) => spec.executable.replace(/\\/g, "/").split("/").pop()?.replace(/\.(?:exe|cmd)$/i, "").toLowerCase();
const hasShellOperators = (spec: CommandSpec) => [spec.executable, ...spec.args].some(arg => /&&|\|\||[;|<>]/.test(arg));

function parseFreshGradleReports(cwd: string, startedAt: number): ParsedTestCounts {
  const counts = emptyCounts();
  const threshold = startedAt - 1_000;
  let found = false;
  let malformed = false;
  const walk = (directory: string, relativePath = "", depth = 0): void => {
    if (depth > 12 || malformed) return;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const rel = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if ([".git", "node_modules", ".gradle"].includes(entry.name)) continue;
        walk(join(directory, entry.name), rel, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/(?:^|\/)build\/test-results\/test\/[^/]+\.xml$/i.test(rel)) continue;
      let xml: string;
      let modifiedAt: number;
      try {
        modifiedAt = statSync(join(directory, entry.name)).mtimeMs;
        if (modifiedAt < threshold) continue;
        xml = readFileSync(join(directory, entry.name), "utf8");
      } catch { continue; }
      const suites = [...xml.matchAll(/<testsuite\b([^>]*)>/g)];
      if (!suites.length) { malformed = true; return; }
      for (const suite of suites) {
        const attribute = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(suite[1])?.[1];
        const values = ["tests", "failures", "errors", "skipped"].map(name => attribute(name));
        const suiteTimestamp = attribute("timestamp");
        const timestamp = suiteTimestamp ? Date.parse(suiteTimestamp) : modifiedAt;
        const numbers = values.map(value => value === undefined ? NaN : Number(value));
        if (!Number.isFinite(timestamp) || timestamp < threshold || numbers.some(value => !Number.isSafeInteger(value) || value < 0)) {
          malformed = true;
          return;
        }
        const [total, failures, errors, skipped] = numbers as [number, number, number, number];
        const failed = failures + errors;
        if (failed + skipped > total) { malformed = true; return; }
        counts.total += total;
        counts.failed += failed;
        counts.passed += total - failed - skipped;
        found = true;
      }
    }
  };
  walk(cwd);
  return found && !malformed ? counts : emptyCounts();
}

/** Resolve known test runners, including simple package scripts, without executing them. */
export function resolveTestRunnerCommand(command: string, cwd: string, depth = 0): CommandSpec | undefined {
  return resolveRunnerSpec(parseCommandSpec(command), cwd, depth);
}

function resolveRunnerSpec(input: CommandSpec, cwd: string, depth: number): CommandSpec | undefined {
  if (depth > 3) return undefined;
  if (hasShellOperators(input)) return undefined;
  const tokens = [input.executable, ...input.args];
  const env = { ...input.env };
  if (["env", "cross-env"].includes(tokens[0])) tokens.shift();
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] ?? "")) {
    const assignment = tokens.shift()!;
    const index = assignment.indexOf("=");
    env[assignment.slice(0, index)] = assignment.slice(index + 1);
  }
  const spec: CommandSpec = { ...input, executable: tokens[0] ?? "", args: tokens.slice(1), env };
  const name = executableName(spec);
  const args = spec.args;
  if ((name === "bun" && args[0] === "test") || (name === "node" && args.some(arg => arg === "--test")) ||
      (name === "go" && args[0] === "test") || (name === "cargo" && args[0] === "test") ||
      (name === "swift" && args[0] === "test") ||
      (name === "dotnet" && args[0] === "test") || (name === "ctest") ||
      ["pytest", "vitest", "jest", "mocha", "rspec", "phpunit"].includes(name ?? "") ||
      (["python", "python3"].includes(name ?? "") && args[0] === "-m" && args[1] === "pytest") ||
      (["mvn", "mvnw", "gradle", "gradlew"].includes(name ?? "") && args.includes("test"))) return spec;
  if (name === "bunx" || name === "npx" || (["npm", "pnpm", "yarn"].includes(name ?? "") && args[0] === "exec")) {
    const start = args[0] === "exec" ? 1 : 0;
    const index = args.findIndex((arg, index) => index >= start && !arg.startsWith("-"));
    if (index < 0) return undefined;
    return resolveRunnerSpec({ ...spec, executable: args[index], args: args.slice(index + 1) }, cwd, depth + 1);
  }
  if (["uv", "poetry", "pipenv", "conda"].includes(name ?? "") && args[0] === "run" && args[1]) {
    return resolveRunnerSpec({ ...spec, executable: args[1], args: args.slice(2) }, cwd, depth + 1);
  }
  if (!["npm", "pnpm", "yarn", "bun"].includes(name ?? "")) return undefined;
  const script = args[0] === "run" || args[0] === "run-script" ? args[1] : args[0];
  if (!script || script.startsWith("-")) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    const source = pkg.scripts?.[script];
    if (typeof source !== "string") return undefined;
    const command = parseCommandSpec(source);
    const extra = args.slice(args[0] === "run" || args[0] === "run-script" ? 2 : 1);
    if (extra[0] === "--") extra.shift();
    return resolveRunnerSpec({ ...command, args: [...command.args, ...extra], env }, cwd, depth + 1);
  } catch {
    return undefined;
  }
}

/** Go evidence must execute fresh, individual tests rather than cached package summaries. */
export function prepareTestExecutionSpec(command: string, cwd?: string): CommandSpec {
  const original = parseCommandSpec(command);
  if (hasShellOperators(original)) return original;
  const resolved = cwd ? resolveTestRunnerCommand(command, cwd) : undefined;
  // Unwrap Go scripts so freshness flags apply to the actual runner. Other
  // package scripts keep their pre/post hooks and execution semantics.
  const spec = resolved && executableName(resolved) === "go" ? resolved : original;
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
export function parseExecutedTestCounts(output: string, command: string, cwd: string, startedAt?: number): ParsedTestCounts {
  const spec = resolveTestRunnerCommand(command, cwd);
  if (!spec) return emptyCounts();
  const name = executableName(spec);
  if (["gradle", "gradlew"].includes(name ?? "")) {
    return startedAt === undefined ? emptyCounts() : parseFreshGradleReports(cwd, startedAt);
  }
  if (name === "go" && output.includes("(cached)")) return emptyCounts();
  const parserId = ["bun", "node", "vitest", "jest", "mocha"].includes(name ?? "") ? "node-jest-vitest-bun" :
    name === "go" ? "go-test" : name === "cargo" ? "cargo-test" :
    ["pytest", "python", "python3"].includes(name ?? "") ? "pytest" :
    name === "dotnet" ? "dotnet-test" : name === "ctest" ? "cpp-gtest" :
    name === "rspec" ? "ruby-rspec" : name === "phpunit" ? "php-phpunit" : name === "swift" ? "swift-test" : "java-junit";
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
