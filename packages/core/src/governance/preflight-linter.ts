import { existsSync } from 'node:fs';
import { defaultSandboxRuntime } from '../sandbox/sandbox-runtime.js';
import { parseCommandSpec } from '../sandbox/command-spec.js';
import { detectRunnableCommandsFromDir } from '../discovery/context-assembler.js';

export interface PreflightLintResult {
  executed: boolean;
  command?: string;
  passed: boolean;
  exitCode?: number;
  rawOutput: string;
  violationCount: number;
  violations: string[];
  summary: string;
}

export interface PreflightLintOptions {
  workspaceRoot: string;
  lintCommand?: string;
  timeoutMs?: number;
}

export type PreflightLintCommandExecutor = (
  command: string,
  timeoutMs: number,
) => Promise<{ exitCode: number; output: string; passed: boolean }>;

const LINT_VIOLATION_PATTERNS = [
  // Flake8 / Ruff / Pylint: file.py:12:34: E501 line too long
  /^\s*[a-zA-Z0-9_\-./\\]+\.py:\d+:(?:\d+:)?\s*(?:[FEWCN]\d+|error\b|warning\b)\s*.+/i,
  // General: file.ext:12:34: error: message
  /^\s*(?:[a-zA-Z0-9_\-./\\]+\.(?:py|ts|tsx|js|jsx|go|rs|cs|java|c|cpp|h)):(\d+):(?:\d+:)?\s*(?:[A-Z]\d+|error\b|warning\b|convention\b|refactor\b)[:\s]\s*(.+)/im,
  // ESLint / Biome: /path/to/file.ts:12:34: error: message [rule-name]
  /^\s*(?:[a-zA-Z0-9_\-./\\]+\.(?:ts|tsx|js|jsx|vue|svelte)):(\d+):(\d+)\s+(?:error|warning)\s+(.+)/im,
  // ESLint's stylish formatter puts the filename on a separate line.
  /^\s*\d+:\d+\s+(?:error|warning)\s+.+/i,
  // Black / Prettier: would reformat / Code style issues found in
  /(?:would reformat\s+([^\r\n]+)|Code style issues found in\s+([^\r\n]+))/i,
  // Go / golangci-lint: file.go:12:34: message (linter-name)
  /^\s*(?:[a-zA-Z0-9_\-./\\]+\.go):(\d+):(?:\d+:)?\s*(.+)/im,
  // Rust / Clippy: error: message --> file.rs:12:34
  /^\s*error:\s*(?:.+)\s+-->\s+([a-zA-Z0-9_\-./\\]+\.rs):(\d+):(\d+)/im,
  // Pre-commit hook failures: Hook failed: ...
  /(?:Failed - Hook failed|Failed - [^\r\n]+)/i,
];

/**
 * Extracts distinct lint/format violation messages from raw linter output.
 */
export function extractLintViolations(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const violations: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check against violation patterns
    for (const pattern of LINT_VIOLATION_PATTERNS) {
      if (pattern.test(trimmed)) {
        if (!violations.includes(trimmed)) {
          violations.push(trimmed);
        }
        break;
      }
    }
  }

  return violations;
}

/**
 * Executes target repository static check / linter as a pre-flight governance gate.
 * Ensures local changes comply with upstream formatting, lint, and type contracts
 * before claiming GREEN evidence or drafting submission intents.
 */
export async function runPreflightLintCheck(
  options: PreflightLintOptions,
  executor?: PreflightLintCommandExecutor,
): Promise<PreflightLintResult> {
  const { workspaceRoot, timeoutMs = 60000 } = options;

  if (!existsSync(workspaceRoot)) {
    return {
      executed: false,
      passed: false,
      rawOutput: '',
      violationCount: 1,
      violations: [`Workspace root does not exist: ${workspaceRoot}`],
      summary: `Pre-flight lint gate is unavailable because workspace root '${workspaceRoot}' does not exist.`,
    };
  }

  let commandToRun = options.lintCommand?.trim();

  // If no explicit lint command was provided, detect automatically from repository manifest
  if (!commandToRun && existsSync(workspaceRoot)) {
    const runnable = detectRunnableCommandsFromDir(workspaceRoot);
    if (runnable.lintCommand) {
      commandToRun = runnable.lintCommand;
    }
  }

  if (!commandToRun) {
    return {
      executed: false,
      passed: true,
      rawOutput: '',
      violationCount: 0,
      violations: [],
      summary: 'No linter or static check command detected or specified.',
    };
  }

  try {
    const execResult = executor
      ? await executor(commandToRun, timeoutMs)
      : await defaultSandboxRuntime.executeAsync({
          cwd: workspaceRoot,
          workspaceRoot,
          commandSpec: parseCommandSpec(commandToRun),
          timeoutMs,
        });

    const rawOutput = execResult.output || '';
    const violations = extractLintViolations(rawOutput);
    const passed = execResult.passed && violations.length === 0;

    let summary = `Pre-flight lint gate passed cleanly with '${commandToRun}'.`;
    if (!passed) {
      const count = violations.length > 0 ? violations.length : 1;
      summary = `Pre-flight lint gate FAILED with ${count} style/lint violation(s) under '${commandToRun}'.`;
    }

    return {
      executed: true,
      command: commandToRun,
      passed,
      exitCode: execResult.exitCode ?? (passed ? 0 : 1),
      rawOutput,
      violationCount: violations.length,
      violations,
      summary,
    };
  } catch (err: any) {
    return {
      executed: true,
      command: commandToRun,
      passed: false,
      exitCode: 1,
      rawOutput: err.message || String(err),
      violationCount: 1,
      violations: [err.message || 'Execution error during pre-flight lint check'],
      summary: `Pre-flight lint command '${commandToRun}' failed to execute: ${err.message}`,
    };
  }
}
