export const MAX_STRESS_ROUNDS = 100;
export const MAX_WORKERS_PER_ROUND = 32;

export interface ConcurrentRoundsResult<T> {
  results: T[];
  roundsRequested: number;
  roundsCompleted: number;
  workersPerRound: number;
  executionsExpected: number;
  executionCount: number;
  maxConcurrentObserved: number;
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

/**
 * Execute a fixed number of synchronized rounds. Every round starts exactly
 * `workersPerRound` workers together, so total requested executions are
 * rounds × workers. A failed round stops later rounds after all workers in the
 * failed round have completed.
 */
export async function runConcurrentRounds<T>(input: {
  rounds: number | undefined;
  workersPerRound: number | undefined;
  execute: () => Promise<T>;
  isSuccess: (result: T) => boolean;
  onError?: (error: unknown) => T;
}): Promise<ConcurrentRoundsResult<T>> {
  const roundsRequested = normalizePositiveInteger(
    input.rounds,
    1,
    MAX_STRESS_ROUNDS,
  );
  const workersPerRound = normalizePositiveInteger(
    input.workersPerRound,
    1,
    MAX_WORKERS_PER_ROUND,
  );
  const results: T[] = [];
  const executionsExpected = roundsRequested * workersPerRound;
  let roundsCompleted = 0;
  let executionCount = 0;
  let inFlight = 0;
  let maxConcurrentObserved = 0;

  const executeTracked = async (): Promise<T> => {
    executionCount++;
    inFlight++;
    maxConcurrentObserved = Math.max(maxConcurrentObserved, inFlight);
    try {
      return await input.execute();
    } finally {
      inFlight--;
    }
  };

  for (let round = 0; round < roundsRequested; round++) {
    let releaseBarrier!: () => void;
    const startBarrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const workers = Array.from({ length: workersPerRound }, async () => {
      await startBarrier;
      try {
        return await executeTracked();
      } catch (error) {
        if (!input.onError) throw error;
        return input.onError(error);
      }
    });
    releaseBarrier();

    const roundResults = await Promise.all(workers);
    results.push(...roundResults);
    roundsCompleted++;

    if (roundResults.some((result) => !input.isSuccess(result))) {
      break;
    }
  }

  return {
    results,
    roundsRequested,
    roundsCompleted,
    workersPerRound,
    executionsExpected,
    executionCount,
    maxConcurrentObserved,
  };
}
