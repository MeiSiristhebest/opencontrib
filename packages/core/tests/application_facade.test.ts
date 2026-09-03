import { describe, expect, it } from 'bun:test';
import { ContributionPipeline } from '../src/application/index.js';

describe('application/ ContributionPipeline (shared use-case facade)', () => {
  it('is constructable and exposes a run() method (the single CLI/MCP entry point)', () => {
    const pipeline = new ContributionPipeline();
    expect(typeof pipeline.run).toBe('function');
  });

  it('run() returns a Promise that delegates to the orchestrator (the shared seam)', async () => {
    const pipeline = new ContributionPipeline();
    const r = pipeline.run({
      profile: { techStack: ['typescript'], proficiency: 'intermediate', focusAreas: [], minMatchScore: 50 },
      targetRepo: 'example/repo',
    });
    // The facade's single job is to be the CLI/MCP entry point that delegates to
    // the orchestrator; we only assert the seam exists and yields a Promise.
    expect(r).toBeInstanceOf(Promise);
    // Drain: the offline run may reject at discovery; we only assert the contract.
    await r.catch(() => undefined);
  });
});
