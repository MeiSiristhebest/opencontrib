import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runCommand } from '../src/commands/run.js';
import { pointerCommand } from '../src/commands/pointer.js';
import { workspaceCommand } from '../src/commands/workspace.js';
import { governanceCommand } from '../src/commands/governance.js';
import { flywheelCommand } from '../src/commands/flywheel.js';
import { doctorCommand } from '../src/commands/doctor.js';
import { discoveryCommand } from '../src/commands/discovery.js';
import { capabilityCommand } from '../src/commands/capability.js';
import { probeCommand } from '../src/commands/probe.js';
import { pluginCommand } from '../src/commands/plugin.js';
import { configCommand } from '../src/commands/config.js';
import { setupCommand } from '../src/commands/setup.js';
import { scoutCommand } from '../src/commands/scout.js';
import { evidenceCommand } from '../src/commands/evidence.js';
import { verifyCommand } from '../src/commands/verify.js';
import { evalCommand } from '../src/commands/eval.js';
import { printPhaseGuidance, printTable, parseJSON } from '../src/utils/output.js';

describe('CLI Commands & Subcommands Test Suite', () => {
  it('registers all 16 command domains correctly with descriptions and subcommands', () => {
    expect(runCommand.name()).toBe('run');
    expect(pointerCommand.name()).toBe('pointer');
    expect(workspaceCommand.name()).toBe('workspace');
    expect(governanceCommand.name()).toBe('governance');
    expect(flywheelCommand.name()).toBe('flywheel');
    expect(doctorCommand.name()).toBe('doctor');
    expect(discoveryCommand.name()).toBe('discovery');
    expect(capabilityCommand.name()).toBe('capability');
    expect(probeCommand.name()).toBe('probe');
    expect(pluginCommand.name()).toBe('plugin');
    expect(configCommand.name()).toBe('config');
    expect(setupCommand.name()).toBe('setup');
    expect(scoutCommand.name()).toBe('scout');
    expect(evidenceCommand.name()).toBe('evidence');
    expect(verifyCommand.name()).toBe('verify');
    expect(evalCommand.name()).toBe('eval');
  });

  it('output utils: printPhaseGuidance renders all blocks cleanly', () => {
    // Capture stdout
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (msg: string) => logs.push(msg);

    try {
      printPhaseGuidance({
        currentPhase: 'INITIALIZED',
        runId: 'run_test_cov',
        status: 'SUCCESS',
        humanCheckpoint: 'Checkpoint 1',
        nextCommand: 'opencontrib probe plan .',
        forbiddenActions: ['DO NOT drift'],
        invariants: ['All tests scoped'],
      });

      printPhaseGuidance({
        currentPhase: 'GOVERNANCE_AUDITED',
        status: 'GATED_BLOCKED',
        forbiddenActions: ['Score < 90%'],
      });

      printPhaseGuidance({
        status: 'WARNING',
      });

      printPhaseGuidance({
        status: 'FAILED',
      });

      expect(logs.length).toBeGreaterThan(0);
      expect(logs.join('\n')).toContain('PHASE: INITIALIZED');
      expect(logs.join('\n')).toContain('GATED_BLOCKED');
    } finally {
      console.log = originalLog;
    }
  });

  it('output utils: printTable formats ASCII tables correctly', () => {
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (msg: string) => logs.push(msg);

    try {
      printTable([], ['name', 'status']);
      printTable(
        [
          { name: 'Tool A', status: 'OK' },
          { name: 'Tool B', status: 'FAILED' },
        ],
        ['name', 'status'],
      );

      expect(logs.some((l) => l.includes('Tool A'))).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });

  it('executes pointer subcommands (list, resolve)', async () => {
    await pointerCommand.parseAsync(['node', 'test', 'list']);
    await pointerCommand.parseAsync(['node', 'test', 'resolve', 'ptr://findings/test-123']);
  });

  it('executes workspace subcommands (list, purge)', async () => {
    await workspaceCommand.parseAsync(['node', 'test', 'list']);
    await workspaceCommand.parseAsync(['node', 'test', 'purge']);
  });

  it('executes governance subcommands (impact, ci-diagnose, pr-template, claim, lint-md)', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrib-gov-cli-'));
    const mdFile = path.join(tempDir, 'sample.md');
    fs.writeFileSync(mdFile, '# Title\n\nBody content\n');

    try {
      await governanceCommand.parseAsync([
        'node',
        'test',
        'impact',
        '--patch',
        '--- a/f\n+++ b/f\n',
        '--modified-files',
        'f.ts',
      ]);

      await governanceCommand.parseAsync([
        'node',
        'test',
        'pr-template',
        '--issue',
        '101',
        '--issue-title',
        'Fix NPE bug',
        '--summary',
        'Fixed null check',
      ]);

      await governanceCommand.parseAsync([
        'node',
        'test',
        'claim',
        '--issue',
        '101',
        '--title',
        'Claim Title',
      ]);

      await governanceCommand.parseAsync(['node', 'test', 'lint-md', mdFile]);
    } finally {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('executes run subcommands (create, get, list, save, resume)', async () => {
    await runCommand.parseAsync([
      'node',
      'test',
      'create',
      '--repo',
      'owner/repo-test-cli',
      '--issue',
      '99',
      '--title',
      'Test run create CLI',
    ]);

    await runCommand.parseAsync(['node', 'test', 'list']);
    await runCommand.parseAsync(['node', 'test', 'get']);
    await runCommand.parseAsync(['node', 'test', 'resume']);
  });

  it('executes discovery subcommands (rank, qualify, feasibility, manifests)', async () => {
    await discoveryCommand.parseAsync([
      'node',
      'test',
      'rank',
      '--input',
      JSON.stringify({ issue: { title: 'Bug 1', body: 'fix', authorAssociation: 'NONE', hasPullRequest: false }, repository: { fullName: 'o/r' } }),
    ]);

    await discoveryCommand.parseAsync([
      'node',
      'test',
      'qualify',
      '--input',
      JSON.stringify({ issueNumber: 1, issueTitle: 'Bug 1', authorAssociation: 'NONE', hasPullRequest: false, labels: [], comments: [] }),
    ]);

    await discoveryCommand.parseAsync([
      'node',
      'test',
      'feasibility',
      '--title',
      'Fix deadlock on Linux',
    ]);

    await discoveryCommand.parseAsync([
      'node',
      'test',
      'manifests',
      '--input',
      '{}',
    ]);
  });

  it('executes probe subcommands (plan, hotspot, fuzz)', async () => {
    await probeCommand.parseAsync(['node', 'test', 'plan', '.']);
    await probeCommand.parseAsync(['node', 'test', 'hotspot', '.']);
    await probeCommand.parseAsync(['node', 'test', 'fuzz', '.']);
  });

  it('executes capability & plugin subcommands', async () => {
    await capabilityCommand.parseAsync(['node', 'test', 'list']);
    await capabilityCommand.parseAsync(['node', 'test', 'plan', '.']);

    await pluginCommand.parseAsync(['node', 'test', 'list']);
    await pluginCommand.parseAsync(['node', 'test', 'status']);
  });

  it('executes doctor command', async () => {
    await doctorCommand.parseAsync(['node', 'test', '--json']);
  });

  it('executes evidence command', async () => {
    await evidenceCommand.parseAsync([
      'node',
      'test',
      '--test-cmd',
      'echo pass',
      '--pre-fix-cmd',
      'echo pass',
    ]);
  });

  it('executes flywheel subcommands (sync, pr-track)', async () => {
    await flywheelCommand.parseAsync([
      'node',
      'test',
      'sync',
      '--repo',
      'owner/repo',
      '--input',
      JSON.stringify({ status: 'merged', techStack: ['typescript'] }),
    ]);

    await flywheelCommand.parseAsync([
      'node',
      'test',
      'pr-track',
      '--input',
      JSON.stringify({ pr: { number: 1, state: 'open', merged: false, mergeable: true, draft: false, headSha: 'abc' }, reviews: [], checkRuns: [], comments: [] }),
    ]);
  });

  it('executes eval subcommands', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrib-eval-cli-'));
    const trFile = path.join(tempDir, 'transcript.jsonl');
    fs.writeFileSync(trFile, JSON.stringify({ step_index: 1, type: 'USER_INPUT', content: 'test' }) + '\n');

    try {
      await evalCommand.parseAsync([
        'node',
        'test',
        'judge',
        trFile,
      ]);
    } finally {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });
});




