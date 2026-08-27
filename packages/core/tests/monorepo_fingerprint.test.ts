import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { extractRepoFingerprint } from '../src/probe/fingerprint.js';

describe('Monorepo Recursive Fingerprint Extraction', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monorepo-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('correctly discovers sub-manifests and TypeScript files in nested packages/*', async () => {
    // Structure:
    // packages/ai/package.json
    // packages/ai/src/index.ts
    // packages/ai/test/index.test.ts
    // packages/agent/package.json
    // packages/agent/src/agent.ts
    const aiDir = path.join(tmpDir, 'packages', 'ai', 'src');
    const aiTestDir = path.join(tmpDir, 'packages', 'ai', 'test');
    const agentDir = path.join(tmpDir, 'packages', 'agent', 'src');

    fs.mkdirSync(aiDir, { recursive: true });
    fs.mkdirSync(aiTestDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'packages', 'ai', 'package.json'), JSON.stringify({ name: '@test/ai', dependencies: { react: '18.0.0' } }));
    fs.writeFileSync(path.join(aiDir, 'index.ts'), 'export const a = 1;');
    fs.writeFileSync(path.join(aiTestDir, 'index.test.ts'), 'test("a", () => {});');
    fs.writeFileSync(path.join(tmpDir, 'packages', 'agent', 'package.json'), JSON.stringify({ name: '@test/agent' }));
    fs.writeFileSync(path.join(agentDir, 'agent.ts'), 'export const b = 2;');

    const fingerprint = await extractRepoFingerprint(tmpDir);

    expect(fingerprint.primaryLanguage).toBe('TypeScript');
    expect(fingerprint.totalFiles).toBeGreaterThanOrEqual(3);
    expect(fingerprint.hasTests).toBe(true);
    expect(fingerprint.manifests).toContain('package.json');
    expect(fingerprint.manifests).toContain('packages/ai/package.json');
    expect(fingerprint.frameworks).toContain('React');
  });
});
