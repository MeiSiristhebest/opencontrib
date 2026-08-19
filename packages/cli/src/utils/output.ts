/** Shared output helpers for the CLI. */

/** Pretty-print JSON with indented output. */
export function printJSON(value: unknown, pretty = false): void {
  console.log(JSON.stringify(value, null, pretty ? 2 : undefined));
}

/** Print a single-line compact JSON (best for pipeline consumption). */
export function printCompact(value: unknown): void {
  console.log(JSON.stringify(value));
}

/** Read the full stdin stream into a string. */
export async function readStdin(): Promise<string> {
  let data = '';
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data.trim();
}

/** Parse a JSON string; return null and print a usage error on failure. */
export function parseJSON(input: string, label = 'input'): unknown | null {
  try {
    return JSON.parse(input);
  } catch {
    console.error(`❌ Invalid JSON ${label}`);
    return null;
  }
}