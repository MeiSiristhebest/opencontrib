import { z } from "zod";

export const MAX_STRESS_ROUNDS = 100;
export const MAX_WORKERS_PER_ROUND = 32;
export const MAX_STRESS_EXECUTIONS = MAX_STRESS_ROUNDS * MAX_WORKERS_PER_ROUND;
export const MAX_REPORTED_TEST_COUNT = 1_000_000;

export const StressRoundsInputSchema = z
  .number()
  .finite()
  .int()
  .min(1)
  .max(MAX_STRESS_ROUNDS);
export const StressWorkersInputSchema = z
  .number()
  .finite()
  .int()
  .min(1)
  .max(MAX_WORKERS_PER_ROUND);

/** Parse explicit CLI numeric input without coercing invalid values. */
export function parseBoundedStressInteger(
  value: string,
  label: string,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `Invalid ${label}: expected a finite integer greater than zero.`,
    );
  }
  if (parsed > maximum) {
    throw new Error(
      `Invalid ${label}: value ${parsed} exceeds maximum ${maximum}.`,
    );
  }
  return parsed;
}

export function validateStressDimensions(
  rounds: number | undefined,
  workersPerRound: number | undefined,
): { rounds: number; workersPerRound: number; executions: number } {
  let parsedRounds: number;
  let parsedWorkers: number;
  try {
    parsedRounds =
      rounds === undefined ? 1 : StressRoundsInputSchema.parse(rounds);
    parsedWorkers =
      workersPerRound === undefined
        ? 1
        : StressWorkersInputSchema.parse(workersPerRound);
  } catch (error) {
    throw new Error(
      `INVALID_STRESS_DIMENSION: rounds and workersPerRound must be finite integers within their bounded ranges (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  const executions = parsedRounds * parsedWorkers;
  if (executions > MAX_STRESS_EXECUTIONS) {
    throw new Error(
      `INVALID_STRESS_DIMENSION: requested executions ${executions} exceeds maximum ${MAX_STRESS_EXECUTIONS}.`,
    );
  }
  return {
    rounds: parsedRounds,
    workersPerRound: parsedWorkers,
    executions,
  };
}
