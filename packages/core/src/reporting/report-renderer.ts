/**
 * ReportRenderer — pure view-model → string rendering (architecture review
 * §16 stage 3: "抽 ReportRenderer 替代 output.ts 硬编码渲染").
 *
 * This module contains NO side effects: no console, no filesystem access, no
 * environment reads. It turns a domain/use-case result into a string. The CLI
 * and MCP layers decide how to emit that string (stdout, JSON-RPC, file, ...).
 * Keeping rendering pure makes it trivially testable and lets both entry points
 * share identical output.
 */

import type { OrchestratorRunResult } from '../orchestration/agent-orchestrator.js';

export type ReportFormat = 'json' | 'summary';

/** Pure: any value → JSON string. Equivalent to `JSON.stringify` with indentation. */
export function renderJson(value: unknown, pretty = false): string {
  return JSON.stringify(value, null, pretty ? 2 : undefined);
}

/**
 * Pure: a contribution run result → a short human-readable summary.
 * Derives its fields from the result; does not hit any infrastructure.
 */
export function renderContributionSummary(result: OrchestratorRunResult): string {
  const lines: string[] = [];
  lines.push(`Status: ${result.status}`);
  if (result.stage) lines.push(`Stage: ${result.stage}`);
  if (typeof result.confidenceScore === 'number') {
    lines.push(`Confidence: ${result.confidenceScore}`);
  }
  if (result.reportSummary) lines.push(result.reportSummary);
  return lines.join('\n');
}

/**
 * Unified pure renderer for the contribution use case. CLI and MCP call this
 * (never `console.log(JSON.stringify(...))` inline) so output is consistent.
 */
export function renderReport(result: OrchestratorRunResult, format: ReportFormat = 'summary'): string {
  return format === 'json' ? renderJson(result, true) : renderContributionSummary(result);
}
