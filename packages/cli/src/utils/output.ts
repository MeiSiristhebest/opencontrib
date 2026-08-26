/** Shared output helpers for the CLI. */

/** Pretty-print JSON with indented output. */
export function printJSON(value: unknown, pretty = false): void {
  console.log(JSON.stringify(value, null, pretty ? 2 : undefined));
}

/** Print a single-line compact JSON (best for pipeline consumption). */
export function printCompact(value: unknown): void {
  console.log(JSON.stringify(value));
}

/** Read the full stdin stream into a string with TTY check and timeout protection. */
export async function readStdin(timeoutMs = 500): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error('No input provided in interactive terminal. Pass --input <json> or pipe JSON via stdin.');
  }
  return new Promise((resolve, reject) => {
    let data = '';
    let hasData = false;

    const timer = setTimeout(() => {
      if (!hasData) {
        process.stdin.pause();
        reject(new Error('No input received on stdin. Pass --input <json> or pipe JSON via stdin.'));
      }
    }, timeoutMs);

    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      hasData = true;
      data += chunk;
    });

    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data.trim());
    });

    process.stdin.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    process.stdin.resume();
  });
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

export interface PhaseGuidanceOptions {
  currentPhase?: string;
  runId?: string;
  status?: 'SUCCESS' | 'GATED_BLOCKED' | 'WARNING' | 'FAILED';
  nextCommand?: string;
  humanCheckpoint?: string;
  forbiddenActions?: string[];
  invariants?: string[];
}

export function printPhaseGuidance(options: PhaseGuidanceOptions): void {
  const statusEmoji =
    options.status === 'GATED_BLOCKED'
      ? '🛑 GATED_BLOCKED'
      : options.status === 'WARNING'
      ? '⚠️ WARNING'
      : options.status === 'FAILED'
      ? '❌ FAILED'
      : '✅ SUCCESS';

  console.log('\n' + '─'.repeat(78));
  if (options.currentPhase || options.runId) {
    console.log(
      `📍 PHASE: ${options.currentPhase || 'IN_PROGRESS'} | RUN: ${options.runId || '(active session)'} | STATUS: ${statusEmoji}`,
    );
  }
  if (options.humanCheckpoint) {
    console.log(`🎯 HUMAN CHECKPOINT: ${options.humanCheckpoint}`);
  }
  if (options.nextCommand) {
    console.log(`▶ NEXT RECOMMENDED COMMAND:`);
    console.log(`  ${options.nextCommand}`);
  }
  if (options.forbiddenActions && options.forbiddenActions.length > 0) {
    console.log(`🛑 FORBIDDEN IN THIS PHASE:`);
    for (const f of options.forbiddenActions) {
      console.log(`  • ${f}`);
    }
  }
  if (options.invariants && options.invariants.length > 0) {
    console.log(`📋 PHASE INVARIANTS:`);
    for (const inv of options.invariants) {
      console.log(`  • ${inv}`);
    }
  }
  console.log('─'.repeat(78) + '\n');
}

