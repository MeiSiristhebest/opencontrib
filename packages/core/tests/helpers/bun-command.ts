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

export function stateAssertionCommand(
  stateFile: string,
  assertion: string,
): string {
  const statePath = JSON.stringify(stateFile.replace(/\\/g, "/"));
  const source = [
    `const state = require("node:fs").readFileSync(${statePath}, "utf8");`,
    `if (state.includes("FAIL")) {`,
    `console.log(${JSON.stringify(assertion)});`,
    'console.log("0 pass, 1 fail");',
    "process.exitCode = 1;",
    `} else { console.log("1 pass, 0 fail"); }`,
  ].join(" ");
  return bunCommand(source);
}
