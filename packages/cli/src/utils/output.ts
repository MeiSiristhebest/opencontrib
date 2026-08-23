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

// ─── ASCII table formatter ───────────────────────────────────────────────

interface TableRow {
  [key: string]: string;
}

/**
 * Render a list of objects as an ASCII table with box-drawing characters.
 * Columns are auto-sized to their widest cell.
 */
export function printTable(rows: TableRow[], columns: string[]): void {
  if (rows.length === 0) {
    console.log('  (no rows)');
    return;
  }

  const widths = columns.map((col) => {
    const maxHeader = col.length;
    const maxCell = Math.max(...rows.map((r) => String(r[col] || '').length), 0);
    return Math.max(maxHeader, maxCell);
  });

  const sep = widths.map((w) => '─'.repeat(w)).join('┼─');

  const header = columns.map((col, i) => col.padEnd(widths[i])).join('│');
  const headerLine = '┌─' + sep + '─┐';
  const divider = '├─' + sep + '─┤';
  const footer = '└─' + sep + '─┘';

  console.log(headerLine);
  console.log('│' + header + '│');
  console.log(divider);

  for (const row of rows) {
    const cells = columns.map((col, i) => String(row[col] || '').padEnd(widths[i]));
    console.log('│' + cells.join('│') + '│');
  }

  console.log(footer);
}
