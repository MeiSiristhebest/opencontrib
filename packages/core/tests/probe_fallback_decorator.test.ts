import { describe, expect, it } from 'bun:test';
import { withFallback, execProbeCommand, type CommandOutcome } from '../src/probe/strategies.js';

const ok = (stdout: string): CommandOutcome => ({ stdout });
const fail = (e: unknown): CommandOutcome => ({ error: e });

describe('withFallback (OCP fallback-chain composition)', () => {
  it('returns the first attempt that yields output, never calling later ones', async () => {
    let secondCalled = false;
    const outcome = await withFallback([
      async () => ok('primary-output'),
      async () => {
        secondCalled = true;
        return ok('should-not-run');
      },
    ]);
    expect(outcome.stdout).toBe('primary-output');
    expect(outcome.error).toBeUndefined();
    expect(secondCalled).toBe(false);
  });

  it('falls through to a later attempt when the primary errors', async () => {
    const outcome = await withFallback([
      async () => fail(new Error('primary boom')),
      async () => ok('recovered-output'),
    ]);
    expect(outcome.stdout).toBe('recovered-output');
    expect(outcome.error).toBeUndefined();
  });

  it('propagates the first underlying error when every attempt fails', async () => {
    const firstErr = new Error('primary boom');
    const outcome = await withFallback([
      async () => fail(firstErr),
      async () => fail(new Error('ephemeral boom')),
      async () => fail(new Error('docker boom')),
    ]);
    expect(outcome.stdout).toBeUndefined();
    expect(outcome.error).toBe(firstErr);
  });

  it('preserves the primary error when a middle attempt is unavailable (error: undefined, no stdout)', async () => {
    const primaryErr = new Error('primary boom');
    const outcome = await withFallback([
      async () => fail(primaryErr),
      async () => ({ error: undefined }), // fallback stage not configured in this env
      async () => fail(new Error('docker boom')),
    ]);
    // The unavailable middle stage must NOT clobber the real primary error.
    expect(outcome.error).toBe(primaryErr);
  });
});

describe('execProbeCommand (single attempt primitive)', () => {
  it('returns stdout on a successful command', async () => {
    const outcome = await execProbeCommand('echo hello-world', process.cwd(), 10000);
    expect(outcome.error).toBeUndefined();
    expect(outcome.stdout ?? '').toContain('hello-world');
  });

  it('recovers stdout emitted by a command that exits non-zero', async () => {
    // Prints to stdout, then exits 1 — mirrors a scanner that emits findings on failure.
    const outcome = await execProbeCommand('echo partial-findings; exit 1', process.cwd(), 10000);
    expect(outcome.stdout ?? '').toContain('partial-findings');
    expect(outcome.error).toBeUndefined();
  });

  it('records the error when a command fails with no stdout', async () => {
    const outcome = await execProbeCommand('exit 2', process.cwd(), 10000);
    expect(outcome.stdout).toBeUndefined();
    expect(outcome.error).toBeDefined();
  });
});
