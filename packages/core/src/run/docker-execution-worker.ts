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
  PreflightLintExecutionJob,
  RawPreflightLintExecutionResult,
} from "./trusted-execution.port.js";
import {
  computeSourceTreeHash,
  computeTestIdentity,
  parseExecutedTestCounts,
  prepareTestExecutionSpec,
  summarizeFlakyBaseline,
} from "../evidence/evidence-collector.js";
import { matchExpectedFailure } from "../evidence/expected-failure-matcher.js";
import { runConcurrentRounds } from "../evidence/stress-runner.js";
import { parseCommandSpec } from "../sandbox/command-spec.js";

function executionCommand(command: string): string {
  const spec = prepareTestExecutionSpec(command);
  if (JSON.stringify(spec.args) === JSON.stringify(parseCommandSpec(command).args)) return command;
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  return [spec.executable, ...spec.args].map(quote).join(" ");
}

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
    const before = computeSourceTreeHash(job.workspace.workspacePath);
    const baselineTestedAt = new Date().toISOString();
    const first = await this.executeRedOnce(job);
    if (first.sourceTreeSha256 !== before) throw new Error("RedBaselineMutationError: isolated RED execution changed the source tree.");
    const samples = [{ passed: first.exitCode === 0, output: `${first.stdout}\n${first.stderr}` }];
    for (let index = 0; index < 3; index++) {
      const sample = await this.executeRedOnce(job);
      if (sample.sourceTreeSha256 !== first.sourceTreeSha256) throw new Error("RedBaselineMutationError: isolated baseline sampling changed the RED source tree.");
      samples.push({ passed: sample.exitCode === 0, output: `${sample.stdout}\n${sample.stderr}` });
    }
    const baseline = summarizeFlakyBaseline(samples, { testCommand: job.testCommand, cwd: job.workspace.workspacePath, expectedAssertion: job.expectedAssertion });
    return { ...first, baselineTestedAt, baselineFlakyTests: baseline.records, baselineCheckStatus: baseline.status };
  }

  private async executeRedOnce(job: RedExecutionJob): Promise<RawRedExecutionResult> {
    const cwd = job.workspace.workspacePath;
    const testIdentity = computeTestIdentity(
      cwd,
      job.testCommand,
      job.expectedAssertion,
      job.testFiles,
    );
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
      executionCommand(job.testCommand),
    ];

    try {
      const res = await runDockerProcessAsync(dockerArgs, this.timeoutMs);
      if (res.exitCode === 124) {
        killContainerByCidFile(cidFile);
      }
      const assertionMatched = job.expectedAssertion
        ? matchExpectedFailure({
            output: res.output,
            pattern: job.expectedAssertion,
          }).matched
        : res.exitCode !== 0;

      return {
        command: job.testCommand,
        exitCode: res.exitCode,
        stdout: res.stdout,
        stderr: res.stderr,
        outputSnippet: res.output.slice(0, 500),
        assertionMatched,
        capturedAt: new Date().toISOString(),
        sourceTreeSha256: computeSourceTreeHash(cwd),
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

  async runPreflightLint(
    job: PreflightLintExecutionJob,
  ): Promise<RawPreflightLintExecutionResult> {
    const cwd = job.workspace.workspacePath;
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
      // Keep the canonical workspace immutable; build tools write only into
      // this disposable copy in the container's writable layer.
      "-v",
      `${cwd}:/source:ro`,
      "-w",
      "/workspace",
      this.image,
      "sh",
      "-c",
      'mkdir -p /workspace && cp -R -P /source/. /workspace/ && exec sh -c "$1"',
      "opencontrib-preflight-lint",
      job.command,
    ];

    try {
      const timeoutMs = Math.max(1, Math.min(job.timeoutMs, this.timeoutMs));
      const res = await runDockerProcessAsync(dockerArgs, timeoutMs);
      if (res.exitCode === 124) {
        killContainerByCidFile(cidFile);
      }
      return {
        command: job.command,
        exitCode: res.exitCode,
        output: res.output,
        passed: res.exitCode === 0,
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
    const executeOne = async () => {
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
        executionCommand(job.testCommand),
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
        try {
          rmSync(cidDir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    };

    const scheduled = await runConcurrentRounds({
      rounds: job.stressLoopCount ?? 1,
      workersPerRound: job.concurrencyWorkers ?? 1,
      execute: executeOne,
      isSuccess: (result) => result.passed,
      onError: (error) => ({
        passed: false,
        exitCode: 1,
        output: error instanceof Error ? error.message : String(error),
        elapsed: 0,
      }),
    });

    let allPassed = true;
    let lastOutput = "";
    let raceCollisions = 0;
    const latencies: number[] = [];
    for (const result of scheduled.results) {
      latencies.push(result.elapsed);
      if (!result.passed) {
        lastOutput = result.output || "[execution failed without output]";
      } else if (lastOutput.length === 0) {
        lastOutput = result.output;
      }
      if (!result.passed) {
        allPassed = false;
        if (
          /data race|race detected|concurrent map|deadlock|collision/i.test(
            result.output,
          )
        ) {
          raceCollisions++;
        }
      }
    }

    const minLat = latencies.length > 0 ? Math.min(...latencies) : 0;
    const maxLat = latencies.length > 0 ? Math.max(...latencies) : 0;
    const observedCounts = parseExecutedTestCounts(lastOutput, job.testCommand, cwd);
    const testsPassed = allPassed && scheduled.results.every(result => {
      const counts = parseExecutedTestCounts(result.output, job.testCommand, cwd);
      return counts.passed > 0 && counts.failed === 0;
    });
    const concurrencyStampedePassed =
      testsPassed &&
      raceCollisions === 0 &&
      (scheduled.workersPerRound === 1 ||
        scheduled.maxConcurrentObserved >= scheduled.workersPerRound);

    return {
      command: job.testCommand,
      exitCode: allPassed ? 0 : 1,
      outputSnippet: lastOutput.slice(0, 500),
      passed: testsPassed,
      sourceTreeSha256: greenTree,
      capturedAt: new Date().toISOString(),
      roundsRequested: scheduled.roundsRequested,
      roundsCompleted: scheduled.roundsCompleted,
      workersPerRound: scheduled.workersPerRound,
      executionsExpected: scheduled.executionsExpected,
      executionCount: scheduled.executionCount,
      maxConcurrentObserved: scheduled.maxConcurrentObserved,
      concurrencyWorkers: scheduled.workersPerRound,
      concurrencyStampedePassed,
      raceCollisionsDetected: raceCollisions,
      latencyJitterMs: maxLat - minLat,
      testIdentity: job.redEvidence.testIdentity,
      passedUnitTestsCount: observedCounts.passed,
      failedUnitTestsCount: observedCounts.failed,
      handleLeakCheckPassed: "UNAVAILABLE",
    };
  }
}
