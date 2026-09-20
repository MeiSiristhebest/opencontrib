import { describe, expect, test } from "bun:test";
import { runStressLoopAsync } from "../src/evidence/evidence-collector.js";
import { runConcurrentRounds } from "../src/evidence/stress-runner.js";

function pickCmd(win: string, posix: string): string {
  return process.platform === "win32" ? win : posix;
}

const PASS_CMD = pickCmd(
  'powershell -NoProfile -Command "Write-Output ok; exit 0"',
  "echo ok",
);

describe("runConcurrentRounds — rounds × workers contract", () => {
  test("one round with five workers executes five workers", async () => {
    const result = await runConcurrentRounds({
      rounds: 1,
      workersPerRound: 5,
      execute: async () => true,
      isSuccess: (value) => value,
    });

    expect(result.roundsRequested).toBe(1);
    expect(result.workersPerRound).toBe(5);
    expect(result.executionsExpected).toBe(5);
    expect(result.executionCount).toBe(5);
    expect(result.roundsCompleted).toBe(1);
    expect(result.maxConcurrentObserved).toBe(5);
  });

  test("three rounds with five workers executes fifteen workers", async () => {
    const result = await runConcurrentRounds({
      rounds: 3,
      workersPerRound: 5,
      execute: async () => true,
      isSuccess: (value) => value,
    });

    expect(result.executionsExpected).toBe(15);
    expect(result.executionCount).toBe(15);
    expect(result.roundsCompleted).toBe(3);
    expect(result.maxConcurrentObserved).toBe(5);
  });

  test("a failed round completes its workers and stops later rounds", async () => {
    const result = await runConcurrentRounds({
      rounds: 3,
      workersPerRound: 5,
      execute: async () => false,
      isSuccess: (value) => value,
    });

    expect(result.executionCount).toBe(5);
    expect(result.roundsCompleted).toBe(1);
    expect(result.executionsExpected).toBe(15);
  });
});

describe("runStressLoopAsync — local backend parity", () => {
  test("workers=5 loops=1 executes five runs concurrently", async () => {
    const result = await runStressLoopAsync(
      process.cwd(),
      PASS_CMD,
      1,
      undefined,
      5,
    );

    expect(result.executionCount).toBe(5);
    expect(result.executionsExpected).toBe(5);
    expect(result.roundsRequested).toBe(1);
    expect(result.workersPerRound).toBe(5);
    expect(result.maxConcurrentObserved).toBe(5);
    expect(result.concurrencyStampedePassed).toBe(true);
  });

  test("workers=5 loops=3 executes fifteen runs across three rounds", async () => {
    const result = await runStressLoopAsync(
      process.cwd(),
      PASS_CMD,
      3,
      undefined,
      5,
    );

    expect(result.executionCount).toBe(15);
    expect(result.executionsExpected).toBe(15);
    expect(result.roundsCompleted).toBe(3);
    expect(result.completedRuns).toBe(15);
    expect(result.maxConcurrentObserved).toBe(5);
    expect(result.concurrencyStampedePassed).toBe(true);
  });

  test("workers=1 loops=3 remains sequential", async () => {
    const result = await runStressLoopAsync(
      process.cwd(),
      PASS_CMD,
      3,
      undefined,
      1,
    );

    expect(result.executionCount).toBe(3);
    expect(result.maxConcurrentObserved).toBe(1);
    expect(result.concurrencyStampedePassed).toBe(true);
  });
});
