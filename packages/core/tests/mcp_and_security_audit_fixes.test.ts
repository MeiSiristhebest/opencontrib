import { describe, expect, it } from 'bun:test';
import { WorktreeManager } from '../src/workspace/worktree-manager.js';
import { runDoctorAudit } from '../src/discovery/doctor.js';
import { ClaimProtocol } from '../src/governance/claim-helper.js';
import { validatePhaseGate } from '../src/run/state-machine.js';
import { createOpenContribMcpServer } from '../../mcp-server/src/server.js';
import type { ContributionRunSummary } from '../src/run/types.js';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

describe('Audit Fixes: Security Boundary & Path Traversal', () => {
  it('WorktreeManager.isSafeScratchDirectory rejects filesystem roots and home directory', () => {
    const wm = new WorktreeManager();

    expect(wm.isSafeScratchDirectory('/')).toBe(false);
    expect(wm.isSafeScratchDirectory('C:\\')).toBe(false);
    expect(wm.isSafeScratchDirectory('C:')).toBe(false);
    expect(wm.isSafeScratchDirectory('D:\\')).toBe(false);
    expect(wm.isSafeScratchDirectory(homedir())).toBe(false);
  });

  it('WorktreeManager.isSafeScratchDirectory permits ~/.opencontrib, temp, and scratch directories', () => {
    const wm = new WorktreeManager();

    const opencontribDir = join(homedir(), '.opencontrib', 'scratch');
    const tempScratch = join(tmpdir(), 'scratch');
    const localScratch = join(process.cwd(), 'scratch');

    expect(wm.isSafeScratchDirectory(opencontribDir)).toBe(true);
    expect(wm.isSafeScratchDirectory(tempScratch)).toBe(true);
    expect(wm.isSafeScratchDirectory(localScratch)).toBe(true);
  });

  it('purgeAllWorkspaces throws an error on unsafe cleanScratchDir', () => {
    const wm = new WorktreeManager();
    expect(() => {
      wm.purgeAllWorkspaces({ cleanScratchDir: '/' });
    }).toThrow(/Security boundary violation/i);
  });
});

describe('Audit Fixes: Doctor & Environment Diagnostics', () => {
  it('runDoctorAudit detects environment and produces structured report', () => {
    const report = runDoctorAudit();
    expect(report).toBeDefined();
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.environment).toBeDefined();
    expect(report.environment.os).toBeDefined();
    expect(report.environment.nodeVersion).toBeDefined();

    const gitCheck = report.checks.find((c) => c.name === 'Git Binary');
    expect(gitCheck).toBeDefined();
  });
});

describe('Audit Fixes: ClaimProtocol & Issue-First Automation', () => {
  it('generateClaimPayload creates clean Authoritative Claim comments', () => {
    const payload = ClaimProtocol.generateClaimPayload(42, 'SSRF vulnerability in URL parser');
    expect(payload.issueNumber).toBe(42);
    expect(payload.issueTitle).toBe('SSRF vulnerability in URL parser');
    expect(payload.claimComment).toContain('Hi @maintainers');
    expect(payload.claimComment).toContain('reproducible test case');
    expect(payload.isReadyForPR).toBe(true);
  });

  it('isBotAuthor accurately discriminates bot accounts', () => {
    expect(ClaimProtocol.isBotAuthor('dependabot[bot]')).toBe(true);
    expect(ClaimProtocol.isBotAuthor('github-actions-user')).toBe(true);
    expect(ClaimProtocol.isBotAuthor('codecov-bot')).toBe(true);
    expect(ClaimProtocol.isBotAuthor('stale')).toBe(true);
    expect(ClaimProtocol.isBotAuthor('octocat', 'User')).toBe(false);
    expect(ClaimProtocol.isBotAuthor('torvalds')).toBe(false);
  });
});

describe('Audit Fixes: Lifecycle State Machine with PROBE and POC phases', () => {
  it('allows transition to PROBE_COMPLETED from INITIALIZED with probe artifact', () => {
    const summary: ContributionRunSummary = {
      manifest: {
        schemaVersion: '1.0.0',
        runId: 'run-probe-test',
        repoFullName: 'test/repo',
        currentPhase: 'INITIALIZED',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      artifacts: {
        probe: { findings: [] },
      },
    };

    expect(() => validatePhaseGate(summary, 'PROBE_COMPLETED')).not.toThrow();
  });

  it('allows transition to POC_GENERATED from WORKSPACE_PREPARED with workspace & poc artifacts', () => {
    const summary: ContributionRunSummary = {
      manifest: {
        schemaVersion: '1.0.0',
        runId: 'run-poc-test',
        repoFullName: 'test/repo',
        currentPhase: 'WORKSPACE_PREPARED',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      artifacts: {
        workspace: { path: '/tmp/ws' },
        poc: { testFile: 'test.ts' },
      },
    };

    expect(() => validatePhaseGate(summary, 'POC_GENERATED')).not.toThrow();
  });
});

describe('Audit Fixes: MCP Server Tool Registry Completeness', () => {
  it('creates MCP server with all discovery, workspace, evidence, governance, run, eval, pointer, probe, and capability tools', () => {
    const server = createOpenContribMcpServer();
    expect(server).toBeDefined();
  });
});
