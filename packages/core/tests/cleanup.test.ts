import { describe, expect, it } from 'bun:test';
import { WorktreeManager } from '../src/workspace/worktree-manager.js';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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

  it('keeps long run workspace names within filesystem component limits', () => {
    const storageDir = mkdtempSync(join(tmpdir(), 'oc-worktree-path-limit-'));
    const previousHome = process.env.OPENCONTRIB_HOME;
    const sourceRepo = join(storageDir, 'source');
    try {
      process.env.OPENCONTRIB_HOME = storageDir;
      mkdirSync(sourceRepo, { recursive: true });
      const manager = new WorktreeManager();
      const baseCommit = 'a'.repeat(40);
      (manager as any).resolveUpstreamBase = () => baseCommit;
      (manager as any).detectDefaultBranch = () => 'main';
      (manager as any).runGit = () => ({ success: true, stdout: '', stderr: '' });
      const repoFullName = `owner/${'r'.repeat(100)}`;
      const runId = `run_${'x'.repeat(220)}`;
      const workspace = manager.createIsolatedWorkspace({
        repoFullName,
        issueOrTaskId: runId,
        runId,
        localRepoPath: sourceRepo,
      });
      const secondWorkspace = manager.createIsolatedWorkspace({
        repoFullName,
        issueOrTaskId: runId,
        runId: `${runId}2`,
        localRepoPath: sourceRepo,
      });

      expect(workspace.workspacePath.split(/[\\/]/).at(-1)?.length).toBeLessThanOrEqual(255);
      expect(secondWorkspace.workspacePath).not.toBe(workspace.workspacePath);
      expect(secondWorkspace.workspacePath.split(/[\\/]/).at(-1)?.length).toBeLessThanOrEqual(255);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCONTRIB_HOME;
      else process.env.OPENCONTRIB_HOME = previousHome;
      rmSync(storageDir, { recursive: true, force: true });
    }
  }, { timeout: 30000 });
});
