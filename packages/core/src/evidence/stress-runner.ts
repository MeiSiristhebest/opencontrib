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
): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
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
}): Promise<ConcurrentRoundsResult<T>> {
  const roundsRequested = normalizePositiveInteger(input.rounds, 1);
  const workersPerRound = normalizePositiveInteger(input.workersPerRound, 1);
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
      return executeTracked();
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
