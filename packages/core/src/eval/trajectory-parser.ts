/**
 * Trajectory Parser for Agent Execution Transcripts (JSONL)
 */

import fs from 'node:fs';
import type { ProtocolAction, TrajectoryEvent, TrajectoryMetrics, TrajectoryToolCall } from './types.js';

export function parseTrajectoryFromJSONL(jsonlContentOrPath: string): {
  events: TrajectoryEvent[];
  metrics: TrajectoryMetrics;
  actions: ProtocolAction[];
} {
  let content = jsonlContentOrPath;
  if (fs.existsSync(jsonlContentOrPath)) {
    content = fs.readFileSync(jsonlContentOrPath, 'utf-8');
  }

  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const events: TrajectoryEvent[] = [];
  const actions: ProtocolAction[] = [];

  let totalCommands = 0;
  let failedCommands = 0;
  let viewFileCalls = 0;
  let currentConsecutiveViews = 0;
  let maxConsecutiveViews = 0;
  let wholeFileRgDumps = 0;
  let shellScriptWriteHacks = 0;
  let totalContribActions = 0;
  let toolCallDurationMs = 0;
  const eventTimestamps: number[] = [];

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

        if (typeof duration === 'number' && duration > 0) {
          toolCallDurationMs += duration;
        }

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

        // 3. Metric: canonical OpenContrib actions (MCP/CLI protocol verbs)
        const canonicalToolName = extractProtocolToolName(name, parsedArgs);
        if (canonicalToolName) {
          totalContribActions++;
          actions.push({
            kind: 'contrib',
            canonicalPhase: PROTOCOL_ACTION_PHASES[canonicalToolName] ?? 'OTHER',
            toolName: canonicalToolName,
            stepIndex: raw.step_index ?? idx,
          });
        }
      }

      const eventTimestamp = raw.timestamp || raw.created_at;
      const parsedEventTimestamp = typeof eventTimestamp === 'number'
        ? Number.isFinite(eventTimestamp)
          ? eventTimestamp
          : Number.NaN
        : typeof eventTimestamp === 'string'
          ? Date.parse(eventTimestamp)
          : Number.NaN;
      if (Number.isFinite(parsedEventTimestamp)) {
        eventTimestamps.push(parsedEventTimestamp);
      }

      events.push({
        stepIndex: raw.step_index ?? idx,
        type: eventType,
        content: raw.content || '',
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        timestamp: eventTimestamp,
      });
    } catch {
      // Ignore unparseable lines
    }
  }

  const durationMs = (() => {
    if (toolCallDurationMs > 0) return toolCallDurationMs;
    const first = eventTimestamps[0];
    const last = eventTimestamps[eventTimestamps.length - 1];
    if (first === undefined || last === undefined || last < first) return 0;
    return last - first;
  })();

  const metrics: TrajectoryMetrics = {
    totalSteps: events.length,
    totalCommandsRun: totalCommands,
    failedCommandsCount: failedCommands,
    viewFileCalls,
    maxConsecutiveFileViews: maxConsecutiveViews,
    wholeFileRgDumpsDetected: wholeFileRgDumps,
    shellScriptWriteHacksDetected: shellScriptWriteHacks,
    totalContribActions,
    totalDurationMs: durationMs,
  };

  return { events, metrics, actions };
}

const OPENCONTRIB_COMMAND_ACTIONS: Record<string, string> = {
  'run create': 'contrib_create_run',
  scout: 'contrib_scout',
  'probe run': 'contrib_probe_run',
  'discovery context': 'contrib_assemble_context',
  'workspace prepare': 'contrib_prepare_workspace',
  'evidence capture-red': 'contrib_capture_red',
  'evidence verify-green': 'contrib_verify_green',
  'verify': 'contrib_verify_poc',
  'run save': 'contrib_save_artifact',
  'governance audit': 'contrib_audit_governance',
  'governance pr-template': 'contrib_render_pr_template',
  'governance request-approval': 'contrib_request_approval',
  submission: 'contrib_submit_pr',
  'flywheel sync': 'contrib_sync_flywheel',
  'run resume': 'contrib_resume_run',
};

function extractProtocolToolName(rawName: string, args: unknown): string | undefined {
  const name = normalizeProtocolToolName(rawName);
  if (name) return name;

  if (rawName === 'run_command') {
    const record = args as Record<string, unknown> | undefined;
    const cmd = unwrapCommandString(record?.CommandLine ?? record?.command ?? '');
    return commandToProtocolToolName(cmd);
  }

  return undefined;
}

function normalizeProtocolToolName(rawName: string): string | undefined {
  const candidate = rawName.split('__').pop()?.split('.').pop() ?? rawName;
  return candidate.startsWith('contrib_') ? candidate : undefined;
}

function commandToProtocolToolName(cmd: string): string | undefined {
  const trimmed = cmd.trim();
  const opencontribMatch = trimmed.match(/\bopencontrib\s+(.+)/);
  const tokens = (opencontribMatch?.[1] ?? '').split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return undefined;

  if (tokens.length >= 2) {
    const twoToken = OPENCONTRIB_COMMAND_ACTIONS[`${tokens[0]} ${tokens[1]}`];
    if (twoToken) return twoToken;
  }

  return OPENCONTRIB_COMMAND_ACTIONS[tokens[0]] ?? undefined;
}

const PROTOCOL_ACTION_PHASES: Record<string, string> = {
  contrib_create_run: 'INITIALIZED',
  contrib_scout: 'OPPORTUNITY_SCOUTED',
  contrib_probe_run: 'PROBE_COMPLETED',
  contrib_assemble_context: 'CONTEXT_ASSEMBLED',
  contrib_prepare_workspace: 'WORKSPACE_PREPARED',
  contrib_capture_red: 'RED_CAPTURED',
  contrib_verify_poc: 'POC_GENERATED',
  contrib_save_artifact: 'PATCH_DRAFTED',
  contrib_verify_green: 'EVIDENCE_COLLECTED',
  contrib_audit_governance: 'GOVERNANCE_AUDITED',
  contrib_request_approval: 'GOVERNANCE_AUDITED',
  contrib_submit_pr: 'PR_SUBMITTED',
  contrib_sync_flywheel: 'COMPLETED',
  contrib_resume_run: 'FAILED',
  contrib_run_pipeline: 'PR_SUBMITTED',
};

function safeParseJson(str: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(str);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { raw: parsed };
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
