import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  TrustedExecutionPort,
  RedExecutionJob,
  RawRedExecutionResult,
  GreenExecutionJob,
  RawGreenExecutionResult,
} from "./trusted-execution.port.js";
import {
  computeSourceTreeHash,
  computeTestIdentity,
} from "../evidence/evidence-collector.js";

export interface DockerExecutionWorkerOptions {
  image?: string;
  timeoutMs?: number;
}

function runDockerProcessAsync(
  args: string[],
  timeoutMs: number,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  output: string;
}> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch (e: any) {
        process.stderr.write(
          `[DockerWorker] Failed to kill child process: ${e.message}\n`,
        );
      }
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const exitCode = timedOut ? 124 : typeof code === "number" ? code : 1;
      const output = `${stdout}\n${stderr}`.trim();
      resolve({ exitCode, stdout, stderr, output });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      const output = `${stdout}\n${stderr}\n${err.message}`.trim();
      resolve({ exitCode: 1, stdout, stderr, output });
    });
  });
}

function killContainerByCidFile(cidFile: string): void {
  try {
    if (existsSync(cidFile)) {
      const cid = readFileSync(cidFile, "utf8").trim();
      if (cid) {
        spawnSync("docker", ["kill", cid], { timeout: 5000 });
        spawnSync("docker", ["rm", "-f", cid], { timeout: 5000 });
      }
    }
  } catch {
    // best-effort cleanup
  }
}

/**
 * Production out-of-process containerized execution worker.
 *
 * Runs strictly isolated in a container without Broker secret environment
 * variables, host home directory, or credentials.
 */
export class DockerExecutionWorker implements TrustedExecutionPort {
  private readonly image: string;
  private readonly timeoutMs: number;

  constructor(options: DockerExecutionWorkerOptions = {}) {
    this.image = options.image || "node:22-alpine";
    this.timeoutMs = options.timeoutMs || 60_000;
  }

  async captureRed(job: RedExecutionJob): Promise<RawRedExecutionResult> {
    const cwd = job.workspace.workspacePath;
    const testIdentity = computeTestIdentity(
      cwd,
      job.testCommand,
      job.expectedAssertion,
      job.testFiles,
    );
    const startTree = computeSourceTreeHash(cwd);

    const cidDir = mkdtempSync(join(tmpdir(), "docker-cid-"));
    const cidFile = join(cidDir, "cid");

    const dockerArgs = [
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--cidfile",
      cidFile,
      "--memory",
      "512m",
      "--cpus",
      "1",
      "--pids-limit",
      "256",
      "-v",
      `${cwd}:/workspace`,
      "-w",
      "/workspace",
      this.image,
      "sh",
      "-c",
      job.testCommand,
    ];

    try {
      const res = await runDockerProcessAsync(dockerArgs, this.timeoutMs);
      if (res.exitCode === 124) {
        killContainerByCidFile(cidFile);
      }
      const assertionMatched = job.expectedAssertion
        ? res.output.includes(job.expectedAssertion)
        : res.exitCode !== 0;

      return {
        command: job.testCommand,
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        outputSnippet: res.output.slice(0, 500),
        assertionMatched,
        capturedAt: new Date().toISOString(),
        sourceTreeSha256: startTree,
        testIdentity,
      };
    } finally {
      try {
        rmSync(cidDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }

  async verifyGreen(job: GreenExecutionJob): Promise<RawGreenExecutionResult> {
    const cwd = job.workspace.workspacePath;
    const greenTree = computeSourceTreeHash(cwd);
    const workerCount = Math.max(1, job.concurrencyWorkers ?? 1);
    const runCount = Math.max(1, job.stressLoopCount ?? 1);

    let executionCount = 0;
    let inFlight = 0;
    let maxConcurrentObserved = 0;
    let raceCollisions = 0;
    const latencies: number[] = [];

    const executeOne = async () => {
      executionCount++;
      inFlight++;
      maxConcurrentObserved = Math.max(maxConcurrentObserved, inFlight);
      const start = Date.now();

      const cidDir = mkdtempSync(join(tmpdir(), "docker-cid-"));
      const cidFile = join(cidDir, "cid");

      const dockerArgs = [
        "run",
        "--rm",
        "--network",
        "none",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--cidfile",
        cidFile,
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--pids-limit",
        "256",
        "-v",
        `${cwd}:/workspace`,
        "-w",
        "/workspace",
        this.image,
        "sh",
        "-c",
        job.testCommand,
      ];

      try {
        const res = await runDockerProcessAsync(dockerArgs, this.timeoutMs);
        if (res.exitCode === 124) {
          killContainerByCidFile(cidFile);
        }
        return {
          passed: res.exitCode === 0,
          exitCode: res.exitCode,
          output: res.output,
          elapsed: Date.now() - start,
        };
      } finally {
        inFlight--;
        try {
          rmSync(cidDir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    };

    const allResults: Array<{
      passed: boolean;
      exitCode: number;
      output: string;
      elapsed: number;
    }> = [];

    // Batch execution: honor both stressLoopCount and concurrencyWorkers
    let remaining = runCount;
    while (remaining > 0) {
      const batchSize = Math.min(workerCount, remaining);
      remaining -= batchSize;

      let batchResults: Array<{
        passed: boolean;
        exitCode: number;
        output: string;
        elapsed: number;
      }>;

      if (batchSize > 1) {
        let releaseBarrier!: () => void;
        const startBarrier = new Promise<void>((r) => {
          releaseBarrier = r;
        });
        const batchWorkers = Array.from({ length: batchSize }, async () => {
          await startBarrier;
          return executeOne();
        });
        releaseBarrier();
        batchResults = await Promise.all(batchWorkers);
      } else {
        batchResults = [await executeOne()];
      }

      allResults.push(...batchResults);

      // Stop early if any run failed
      const anyFailed = batchResults.some((r) => !r.passed);
      if (anyFailed) break;
    }

    let allPassed = true;
    let lastOutput = "";
    for (const r of allResults) {
      latencies.push(r.elapsed);
      lastOutput = r.output;
      if (!r.passed) {
        allPassed = false;
        // Detect race conditions from output (same as local runner)
        if (
          /data race|race detected|concurrent map|deadlock|collision/i.test(
            r.output,
          )
        ) {
          raceCollisions++;
        }
      }
    }

    const minLat = latencies.length > 0 ? Math.min(...latencies) : 0;
    const maxLat = latencies.length > 0 ? Math.max(...latencies) : 0;
    const concurrencyStampedePassed =
      allPassed &&
      raceCollisions === 0 &&
      (workerCount === 1 || maxConcurrentObserved >= workerCount);

    return {
      command: job.testCommand,
      exitCode: allPassed ? 0 : 1,
      outputSnippet: lastOutput.slice(0, 500),
      passed: allPassed,
      sourceTreeSha256: greenTree,
      capturedAt: new Date().toISOString(),
      executionCount,
      maxConcurrentObserved,
      concurrencyWorkers: workerCount,
      concurrencyStampedePassed,
      raceCollisionsDetected: raceCollisions,
      latencyJitterMs: maxLat - minLat,
      testIdentity: job.redEvidence.testIdentity,
      passedUnitTestsCount: allPassed ? 1 : 0,
      failedUnitTestsCount: allPassed ? 0 : 1,
      handleLeakCheckPassed: "UNAVAILABLE",
    };
  }
}
