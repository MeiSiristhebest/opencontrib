import { describe, expect, it } from 'bun:test';
import {
  renderJson,
  renderContributionSummary,
  renderReport,
} from '../src/reporting/report-renderer.js';
import type { OrchestratorRunResult } from '../src/orchestration/agent-orchestrator.js';

describe('reporting/ReportRenderer (pure view → string)', () => {
  it('renderJson mirrors JSON.stringify with indentation control', () => {
    expect(renderJson({ a: 1 })).toBe('{"a":1}');
    expect(renderJson({ a: 1 }, true)).toBe('{\n  "a": 1\n}');
  });

  it('renderContributionSummary derives a stable human-readable string', () => {
    const result: OrchestratorRunResult = {
      status: 'DRY_RUN_COMPLETED',
      stage: 'SUBMIT',
      confidenceScore: 0.91,
      reportSummary: 'Patch drafted and validated.',
    };
    const out = renderContributionSummary(result);
    expect(out).toContain('Status: DRY_RUN_COMPLETED');
    expect(out).toContain('Stage: SUBMIT');
    expect(out).toContain('Confidence: 0.91');
    expect(out).toContain('Patch drafted and validated.');
  });

  it('renderReport dispatches by format and stays side-effect free', () => {
    const result: OrchestratorRunResult = { status: 'BLOCKED', stage: 'DISCOVERY', reportSummary: 'No qualified issues found.' };
    expect(renderReport(result, 'summary')).toBe(renderContributionSummary(result));
    expect(renderReport(result, 'json')).toBe(renderJson(result, true));
  });
});
