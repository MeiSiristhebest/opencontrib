import { describe, expect, test } from "bun:test";
import { runStressLoopAsync } from "../src/evidence/evidence-collector.js";
import { runConcurrentRounds } from "../src/evidence/stress-runner.js";
import { EvidenceReportSchema } from "../src/contracts/schemas.js";

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

  test("worker rejection is converted into a failed execution when requested", async () => {
    const result = await runConcurrentRounds({
      rounds: 2,
      workersPerRound: 3,
      execute: async () => {
        throw new Error("sandbox unavailable");
      },
      isSuccess: (value) => value,
      onError: () => false,
    });

    expect(result.executionCount).toBe(3);
    expect(result.roundsCompleted).toBe(1);
    expect(result.executionsExpected).toBe(6);
    expect(result.results).toEqual([false, false, false]);
  });

  test("fractional dimensions are normalized to at least one execution", async () => {
    const result = await runConcurrentRounds({
      rounds: 0.5,
      workersPerRound: 0.5,
      execute: async () => true,
      isSuccess: (value) => value,
    });

    expect(result.roundsRequested).toBe(1);
    expect(result.workersPerRound).toBe(1);
    expect(result.executionCount).toBe(1);
    expect(result.executionsExpected).toBe(1);
  });

  test("excessive dimensions fail before worker allocation", async () => {
    let executed = false;
    await expect(
      runConcurrentRounds({
        rounds: 1,
        workersPerRound: 1000,
        execute: async () => {
          executed = true;
          return true;
        },
        isSuccess: (value) => value,
      }),
    ).rejects.toThrow(/INVALID_STRESS_DIMENSION/);
    expect(executed).toBe(false);
  });

  test("evidence schema rejects contradictory round metadata", () => {
    const result = EvidenceReportSchema.safeParse({
      baselineTestedAt: new Date().toISOString(),
      baselineFlakyTests: [],
      roundsRequested: 2,
      roundsCompleted: 3,
      workersPerRound: 3,
      executionsExpected: 5,
      stressLoopPassed: true,
      executionCount: 5,
      maxConcurrentObserved: 3,
      handleLeakCheckPassed: "UNAVAILABLE",
      passedUnitTestsCount: 1,
      testCoverageStatus: "UNAVAILABLE",
      changedCodeCoverageStatus: "UNAVAILABLE",
    });

    expect(result.success).toBe(false);
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
  });
});
