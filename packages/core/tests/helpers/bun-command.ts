/**
 * Build a direct command for a Bun fixture used by sandbox/evidence tests.
 *
 * Using process.execPath avoids starting an OS shell just to print a marker.
 * Normalize Windows separators because parseCommandSpec treats backslashes
 * as escapes, then JSON-quote both the executable and inline source.
 */
export function bunCommand(source: string): string {
  const executable = process.execPath.replace(/\\/g, "/");
  return `${JSON.stringify(executable)} -e ${JSON.stringify(source)}`;
}
