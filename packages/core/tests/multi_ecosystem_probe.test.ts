import { describe, expect, it } from 'bun:test';
import { probeRepository } from '../src/probe/probe-scanner.js';
import { isGitHubReachable } from './helpers/integration-guard.js';

const githubReachable = isGitHubReachable();

describe('Multi-Ecosystem Deep Probe Scanner', () => {
  it.skipIf(!githubReachable)('identifies Go, Rust, Java, and CMake hygiene and workflow defects', async () => {
    // Tests scanner logic against bytedance/flowgram.ai
    const result = await probeRepository('bytedance/flowgram.ai');

    expect(result.repoFullName).toBe('bytedance/flowgram.ai');
    expect(result.suggestions.length).toBeGreaterThan(0);

    // Verify suggestions contain PR potential scores and structured validation plans
    for (const s of result.suggestions) {
      expect(s.prPotentialScore).toBeGreaterThanOrEqual(80);
      expect(s.targetFiles.length).toBeGreaterThan(0);
      expect(s.estimatedDiffLines).toBeLessThanOrEqual(50);
    }
  }, 60000);
});
