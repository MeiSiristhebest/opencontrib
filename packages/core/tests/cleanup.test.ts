import { describe, expect, it } from 'bun:test';
import { WorktreeManager } from '../src/workspace/worktree-manager.js';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Workspace Cleanup & Purge Engine', () => {
  it('purges scratch test scripts and ephemeral workspaces cleanly', () => {
    const testScratchDir = join(tmpdir(), 'test-opencontrib-scratch-' + Date.now());
    mkdirSync(testScratchDir, { recursive: true });
    writeFileSync(join(testScratchDir, 'temp_test.ts'), '// scratch test code');
    writeFileSync(join(testScratchDir, 'temp_evidence.log'), 'test evidence log');

    expect(existsSync(join(testScratchDir, 'temp_test.ts'))).toBe(true);

    const manager = new WorktreeManager();
    const result = manager.purgeAllWorkspaces({
      cleanScratchDir: testScratchDir,
      cleanRepos: false,
    });

    expect(result.purgedScratchFiles).toContain('temp_test.ts');
    expect(result.purgedScratchFiles).toContain('temp_evidence.log');
    expect(existsSync(join(testScratchDir, 'temp_test.ts'))).toBe(false);
  }, { timeout: 30000 });
});
