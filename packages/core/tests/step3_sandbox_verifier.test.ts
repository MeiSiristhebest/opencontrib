import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  WorktreeSandbox,
  AutonomousPoCVerifier,
  IssueClaimEngine,
  type PointerStub,
} from '../src/index.js';

describe('Step 3: Clean-Room Worktree Sandbox, PoC Verifier & Issue Claim Protocol', () => {
  let tempRepo: string;

  beforeEach(() => {
    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrib-step3-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempRepo)) {
      fs.rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  it('manages Clean-Room Worktree Sandbox lifecycle safely', () => {
    // Write sample file
    fs.writeFileSync(path.join(tempRepo, 'sample.ts'), 'export const val = 10;', 'utf8');

    const sandbox = new WorktreeSandbox({ repoPath: tempRepo });
    expect(fs.existsSync(sandbox.sandboxPath)).toBe(true);

    // Apply patch inside sandbox
    const patched = sandbox.applyPatch('sample.ts', '10', '20');
    expect(patched).toBe(true);
    expect(sandbox.readFile('sample.ts')).toContain('20');

    // Original repo must remain completely untouched (zero mutation)
    expect(fs.readFileSync(path.join(tempRepo, 'sample.ts'), 'utf8')).toContain('10');

    sandbox.cleanup();
  });

  it('executes 4-phase closed-loop verification (Red -> Green -> Blue)', async () => {
    const srcFile = path.join(tempRepo, 'calc.ts');
    fs.writeFileSync(srcFile, 'export function add(a: number, b: number) { return a - b; }', 'utf8');

    const finding: PointerStub = {
      namespace: 'findings',
      id: 'calc-bug',
      title: 'Arithmetic subtraction instead of addition',
      category: 'numerical_bounds',
      severity: 'high',
      file: 'calc.ts',
      line: 1,
      confidence: 95,
      callSite: 'return a - b;',
      evidence: {
        suggestedPatch: 'return a + b;',
      },
      verificationStep: {
        setupCode: 'export const testVal = 1;',
        exploitPayload: 'return a - b;',
        invocationExpression: 'node -e "if (1 + 1 !== 2) process.exit(0);"',
        expectedFailureAssertion: '',
        expectedPostFixAssertion: '',
      },
    };

    const report = await AutonomousPoCVerifier.verifyFinding(tempRepo, finding, {
      testCommand: 'node -e "process.exit(0)"',
    });

    expect(report.status).toBe('VERIFIED');
    expect(report.fixApplied).toBe(true);
    expect(report.fixVerified).toBe(true);
    expect(report.regressionPassed).toBe(true);
  });

  it('generates authoritative claim statement and discriminates bot accounts', () => {
    const claim = IssueClaimEngine.generateClaimPayload(105, 'Memory leak in Goroutine Pool', {
      namespace: 'findings',
      id: 'leak-1',
      title: 'Unclosed response body in client.go',
      category: 'lifecycle_leak',
      severity: 'high',
      file: 'client.go',
      line: 42,
      confidence: 95,
    });

    expect(claim.claimComment).toContain('I have investigated this issue and have a reproducible test case and fix ready.');
    expect(claim.claimComment).toContain('Please assign this issue to me, I will submit a PR shortly.');
    expect(claim.claimComment).toContain('client.go:42');

    // Bot discrimination checks
    expect(IssueClaimEngine.isBotAuthor('github-actions[bot]', 'Bot')).toBe(true);
    expect(IssueClaimEngine.isBotAuthor('codecov-bot')).toBe(true);
    expect(IssueClaimEngine.isBotAuthor('dependabot[bot]')).toBe(true);
    expect(IssueClaimEngine.isBotAuthor('torvalds', 'User')).toBe(false);
    expect(IssueClaimEngine.isBotAuthor('antirez', 'User')).toBe(false);
  });
});
