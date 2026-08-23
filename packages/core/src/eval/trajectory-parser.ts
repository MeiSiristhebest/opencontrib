/**
 * Trajectory Parser for Agent Execution Transcripts (JSONL)
 */

import fs from 'node:fs';
import type { TrajectoryEvent, TrajectoryMetrics, TrajectoryToolCall } from './types.js';

export function parseTrajectoryFromJSONL(jsonlContentOrPath: string): {
  events: TrajectoryEvent[];
  metrics: TrajectoryMetrics;
} {
  let content = jsonlContentOrPath;
  if (fs.existsSync(jsonlContentOrPath)) {
    content = fs.readFileSync(jsonlContentOrPath, 'utf-8');
  }

  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const events: TrajectoryEvent[] = [];

  let totalCommands = 0;
  let failedCommands = 0;
  let viewFileCalls = 0;
  let currentConsecutiveViews = 0;
  let maxConsecutiveViews = 0;
  let wholeFileRgDumps = 0;
  let shellScriptWriteHacks = 0;

  const rgDumpRegex = /rg\s+.*?(?:-n\s+)?["']?(?:\.\*|\^)["']?\s+[A-Za-z0-9_\-\.\/\\:]+/i;
  const writeHackRegex = /(?:node\s+-e|python\s+-c)\s+.*?(?:fs\.(?:writeFileSync|writeFile)|Buffer\.from|open\(.*['"]w['"]\)|b64|create_clean_md)/i;

  for (let idx = 0; idx < lines.length; idx++) {
    try {
      const raw = JSON.parse(lines[idx]);
      const eventType = raw.type || 'PLANNER_RESPONSE';
      const rawToolCalls = raw.tool_calls || [];
      const toolCalls: TrajectoryToolCall[] = [];

      for (const tc of rawToolCalls) {
        const name = tc.name || tc.function?.name || '';
        const rawArgs = tc.args || tc.parameters || tc.function?.arguments || {};
        const parsedArgs = typeof rawArgs === 'string' ? safeParseJson(rawArgs) : rawArgs;
        const duration = tc.durationMs || tc.duration;
        const exitCode = tc.exitCode;
        const output = tc.output || tc.result;

        toolCalls.push({
          name,
          args: parsedArgs,
          durationMs: typeof duration === 'number' ? duration : undefined,
          exitCode: typeof exitCode === 'number' ? exitCode : undefined,
          outputSnippet: typeof output === 'string' ? output.slice(0, 300) : undefined,
        });

        // 1. Metric: Commands run
        if (name === 'run_command') {
          totalCommands++;
          const cmd = unwrapCommandString(parsedArgs.CommandLine || parsedArgs.command || '');
          if (exitCode !== undefined && exitCode !== 0) {
            failedCommands++;
          }

          // Anti-pattern 1: whole-file rg dumps (rg -n ".*" or rg "^")
          if (rgDumpRegex.test(cmd)) {
            wholeFileRgDumps++;
          }

          // Anti-pattern 2: shell script write hacks (node -e "const fs" or Buffer.from)
          if (writeHackRegex.test(cmd)) {
            shellScriptWriteHacks++;
          }
        }

        // 2. Metric: view_file calls & consecutive sequence
        if (name === 'view_file') {
          viewFileCalls++;
          currentConsecutiveViews++;
          if (currentConsecutiveViews > maxConsecutiveViews) {
            maxConsecutiveViews = currentConsecutiveViews;
          }
        } else if (name !== 'view_file' && name !== 'grep_search' && name !== 'find_by_name') {
          currentConsecutiveViews = 0;
        }
      }

      events.push({
        stepIndex: raw.step_index ?? idx,
        type: eventType,
        content: raw.content || '',
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        timestamp: raw.timestamp || raw.created_at,
      });
    } catch {
      // Ignore unparseable lines
    }
  }

  const metrics: TrajectoryMetrics = {
    totalSteps: events.length,
    totalCommandsRun: totalCommands,
    failedCommandsCount: failedCommands,
    viewFileCalls,
    maxConsecutiveFileViews: maxConsecutiveViews,
    wholeFileRgDumpsDetected: wholeFileRgDumps,
    shellScriptWriteHacksDetected: shellScriptWriteHacks,
  };

  return { events, metrics };
}

function safeParseJson(str: string): Record<string, any> {
  try {
    return JSON.parse(str);
  } catch {
    console.warn(`[TrajectoryParser] Failed to parse tool call args, discarding: ${str.slice(0, 100)}`);
    return { raw: str };
  }
}

function unwrapCommandString(raw: any): string {
  if (typeof raw !== 'string') return '';
  let str = raw.trim();
  if (str.startsWith('"') && str.endsWith('"')) {
    try {
      str = JSON.parse(str);
    } catch {
      str = str.slice(1, -1);
    }
  }
  return str;
}
