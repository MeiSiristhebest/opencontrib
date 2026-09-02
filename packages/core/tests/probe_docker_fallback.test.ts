import { describe, it, expect } from 'bun:test';
import { negotiateProbes } from '../src/probe/negotiator.js';
import type { RepoFingerprint } from '../src/probe/types.js';

describe('Probe Docker Fallback & Progressive Negotiation', () => {
  const sampleFingerprint: RepoFingerprint = {
    repoPath: process.cwd(),
    primaryLanguage: 'typescript',
    languages: [{ language: 'typescript', filesCount: 10, percentage: 100 }],
    manifests: ['package.json'],
    frameworks: ['vitest'],
    hasTests: true,
  };

  it('negotiates semgrep, ast-grep, knip via Docker or ephemeral fallbacks', () => {
    const plan = negotiateProbes(sampleFingerprint);
    const selectedNames = plan.selectedProbes.map((p) => p.name);
    expect(selectedNames).toContain('semgrep');
    expect(selectedNames).toContain('ast-grep');
    expect(selectedNames).toContain('knip');
    expect(selectedNames).toContain('piolium');
  });

  it('filters out language-mismatched probes', () => {
    const pyFingerprint: RepoFingerprint = {
      repoPath: process.cwd(),
      primaryLanguage: 'python',
      languages: [{ language: 'python', filesCount: 5, percentage: 100 }],
      manifests: ['pyproject.toml'],
      frameworks: ['pytest'],
      hasTests: true,
    };

    const plan = negotiateProbes(pyFingerprint);
    const selectedNames = plan.selectedProbes.map((p) => p.name);
    expect(selectedNames).not.toContain('nilaway');
  });
});
