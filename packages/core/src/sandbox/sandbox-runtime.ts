import {
  spawn,
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { parseCommandSpec, type CommandSpec } from "./command-spec.js";
import { safeRmSync } from "../workspace/worktree-manager.js";
import { sensitiveDeniedPaths } from "./denied-paths.js";

export interface SandboxExecutionOptions {
  cwd: string;
  workspaceRoot?: string;
  command?: string;
  args?: string[];
  commandSpec?: CommandSpec;
  timeoutMs?: number;
  allowHostFallback?: boolean;
}

export interface SandboxExecutionResult {
  command: string;
  exitCode: number | null;
  passed: boolean;
  stdout: string;
  stderr: string;
  output: string;
  isSandboxed: boolean;
  isolationWarnings: string[];
}

export interface SandboxAvailability {
  available: boolean;
  reason?: string;
  isolationMode:
    | "NATIVE_ISOLATION"
    | "SANITIZED_ENVIRONMENT"
    | "CONTAINER_ISOLATION"
    | "UNAVAILABLE";
  warnings: string[];
}

/**
 * Universal interface for sandbox execution providers
 * (e.g. SanitizedLocalSandboxProvider, DockerSandboxProvider, BubblewrapSandboxProvider).
 */
export interface SandboxProvider {
  name: string;
  execute(options: SandboxExecutionOptions): SandboxExecutionResult;
  getAvailability(): SandboxAvailability;
  getDeniedPaths(): string[];
  isPathWithinBoundary(targetPath: string, rootBoundary: string): boolean;
}

export function buildKernelIsolationCommand(
  executable: string,
  args: string[],
  cwd: string,
  deniedPaths: string[],
): { executable: string; args: string[]; isKernelIsolated: boolean } {
  if (process.platform === "linux") {
    try {
      const check = spawnSync("bwrap", ["--version"], { stdio: "ignore" });
      if (check.status === 0) {
        const bwrapArgs: string[] = [
          "--ro-bind", "/", "/",
          "--dev", "/dev",
          "--proc", "/proc",
          "--bind", cwd, cwd,
        ];
        for (const denied of deniedPaths) {
          if (existsSync(denied)) {
            bwrapArgs.push("--tmpfs", denied);
          }
        }
        bwrapArgs.push("--", executable, ...args);
        return { executable: "bwrap", args: bwrapArgs, isKernelIsolated: true };
      }
    } catch {
      // bwrap unavailable
    }
  } else if (process.platform === "darwin") {
    try {
      if (existsSync("/usr/bin/sandbox-exec")) {
        const denyRules = deniedPaths
          .filter((p) => existsSync(p))
          .map((p) => `(deny file-read* (subpath "${p}"))`)
          .join(" ");
        const profile = `(version 1) (allow default) ${denyRules}`;
        return {
          executable: "/usr/bin/sandbox-exec",
          args: ["-p", profile, executable, ...args],
          isKernelIsolated: true,
        };
      }
    } catch {
      // sandbox-exec unavailable
    }
  }
  return { executable, args, isKernelIsolated: false };
}

export class SanitizedLocalSandboxProvider implements SandboxProvider {
  public readonly name = "sanitized_local";
  private readonly home: string;
  private readonly defaultTimeoutMs = 60_000;

  constructor() {
    this.home = homedir();
  }

  /**
   * Sensitive credential directories and files that must NEVER be readable by the sandbox.
   */
  getDeniedPaths(): string[] {
    return sensitiveDeniedPaths(this.home);
  }

  /**
   * Determine sandbox runtime availability on current host.
   */
  getAvailability(): SandboxAvailability {
    const warnings: string[] = [];
    let isNative = false;
    if (process.platform === "linux") {
      try {
        const check = spawnSync("bwrap", ["--version"], { stdio: "ignore" });
        if (check.status === 0) isNative = true;
      } catch {}
    } else if (process.platform === "darwin") {
      if (existsSync("/usr/bin/sandbox-exec")) isNative = true;
    }

    return {
      available: true,
      isolationMode: isNative ? "NATIVE_ISOLATION" : "SANITIZED_ENVIRONMENT",
      warnings,
    };
  }

  /**
   * Builds a sanitized, credential-free environment for executing untrusted repository code.
   * Strips out tokens, credentials, and re-routes HOME/TMP to an isolated scratch folder.
   */
  buildSanitizedEnvironment(sandboxTempDir: string): NodeJS.ProcessEnv {
    const allowedVars = [
      // OS/runtime essentials
      "PATH",
      "Path",
      "PATHEXT",
      "SystemRoot",
      "WINDIR",
      "COMSPEC",
      "ComSpec",
      "SYSTEMDRIVE",
      "SystemDrive",
      "PROGRAMFILES",
      "ProgramFiles",
      "PROGRAMFILES(X86)",
      "ProgramFiles(x86)",
      "COMMONPROGRAMFILES",
      "PSModulePath",
      "LANG",
      "LC_ALL",
      "TERM",
      // Node.js
      "NODE_PATH",
      "NODE_OPTIONS",
      "BUN_INSTALL",
      // Go toolchain
      "GOROOT",
      "GOPATH",
      "GOBIN",
      "GOCACHE",
      "GOMODCACHE",
      // Rust toolchain
      "CARGO_HOME",
      "RUSTUP_HOME",
      "RUSTC_WRAPPER",
      "RUSTFLAGS",
      // Java / Android toolchain
      "JAVA_HOME",
      "M2_HOME",
      "GRADLE_HOME",
      "ANDROID_HOME",
      "ANDROID_SDK_ROOT",
      // Python
      "PYTHONPATH",
      "VIRTUAL_ENV",
      "VIRTUAL_ENV_WRAPPER",
      "PIP_CONFIG_FILE",
      "CONDA_PREFIX",
      "CONDA_DEFAULT_ENV",
      // .NET
      "DOTNET_ROOT",
      "MSBUILD_EXE_PATH",
      // Nix
      "NIX_PATH",
      "NIX_USER_PROFILE_DIR",
      // Common toolchain cache / config dirs (non-credential)
      "NPM_CONFIG_CACHE",
      "BUNDLE_PATH",
      "GEM_HOME",
    ];

    const sanitizedEnv: NodeJS.ProcessEnv = {};
    for (const key of allowedVars) {
      if (process.env[key] !== undefined) {
        sanitizedEnv[key] = process.env[key];
      }
    }

    sanitizedEnv["HOME"] = sandboxTempDir;
    sanitizedEnv["USERPROFILE"] = sandboxTempDir;
    sanitizedEnv["TMPDIR"] = sandboxTempDir;
    sanitizedEnv["TMP"] = sandboxTempDir;
    sanitizedEnv["TEMP"] = sandboxTempDir;

    sanitizedEnv["CI"] = "true";
    sanitizedEnv["FORCE_COLOR"] = "0";
    sanitizedEnv["DEBIAN_FRONTEND"] = "noninteractive";
    sanitizedEnv["GIT_TERMINAL_PROMPT"] = "0";
    sanitizedEnv["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";
    sanitizedEnv["NEXT_TELEMETRY_DISABLED"] = "1";
    if (!sanitizedEnv["GOCACHE"]) {
      sanitizedEnv["GOCACHE"] = join(sandboxTempDir, "go-build");
    }

    return sanitizedEnv;
  }

  /**
   * Verify whether a target path is safely within the workspace boundaries (preventing traversal).
   */
  isPathWithinBoundary(targetPath: string, rootBoundary: string): boolean {
    const resolvedTarget = resolve(targetPath);
    const resolvedRoot = resolve(rootBoundary);
    return (
      resolvedTarget.startsWith(resolvedRoot + sep) ||
      resolvedTarget === resolvedRoot
    );
  }

  /**
   * Executes a command within the sanitized sandbox environment.
   * Enforces Fail-Closed semantics: if sandbox cannot initialize, halts and does not fall back to host unless explicitly requested.
   */
  execute(options: SandboxExecutionOptions): SandboxExecutionResult {
    return this.executeInSandbox(options);
  }

  /**
   * True async execution using child_process.spawn.
   * Enables genuine parallel process concurrency and contention.
   */
  async executeAsync(
    options: SandboxExecutionOptions,
  ): Promise<SandboxExecutionResult> {
    const {
      cwd,
      workspaceRoot,
      command,
      args = [],
      commandSpec,
      timeoutMs = this.defaultTimeoutMs,
    } = options;

    const resolvedCwd = resolve(cwd);
    const availability = this.getAvailability();

    if (workspaceRoot) {
      const resolvedRoot = resolve(workspaceRoot);
      if (!this.isPathWithinBoundary(resolvedCwd, resolvedRoot)) {
        return {
          command: command || "",
          exitCode: 126,
          passed: false,
          stdout: "",
          stderr: `Path traversal denied: Execution cwd "${resolvedCwd}" escapes workspace root "${resolvedRoot}".`,
          output: `Path traversal denied: Execution cwd "${resolvedCwd}" escapes workspace root "${resolvedRoot}".`,
          isSandboxed: false,
          isolationWarnings: ["Cwd escaped workspace root"],
        };
      }
    }

    let finalCommand = command || "";
    let finalArgs = [...args];
    if (commandSpec) {
      finalCommand = commandSpec.executable;
      finalArgs = [...commandSpec.args];
    } else if (finalCommand && finalArgs.length === 0) {
      const parsed = parseCommandSpec(finalCommand);
      finalCommand = parsed.executable;
      finalArgs = parsed.args;
    }

    const commandDisplay = `${finalCommand} ${finalArgs.join(" ")}`.trim();
    let sandboxTempDir = "";
    try {
      sandboxTempDir = mkdtempSync(join(tmpdir(), "opencontrib-sandbox-"));
    } catch {
      sandboxTempDir = tmpdir();
    }

    const kernelIsolation = buildKernelIsolationCommand(
      finalCommand,
      finalArgs,
      resolvedCwd,
      this.getDeniedPaths(),
    );
    const spawnExec = kernelIsolation.executable;
    const spawnArgs = kernelIsolation.args;
    const sanitizedEnv = this.buildSanitizedEnvironment(sandboxTempDir);

    return new Promise<SandboxExecutionResult>((resolvePromise) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      // On Windows, only launch batch files or package manager scripts via cmd.exe shell.
      // Direct executables (.exe, or PATH binaries) must be launched directly so cmd.exe
      // cannot flatten parsed arguments or expose command injection surface.
      const exeLower = spawnExec.toLowerCase();
      const isBatch =
        process.platform === "win32" &&
        (exeLower.endsWith(".cmd") ||
          exeLower.endsWith(".bat") ||
          exeLower === "npm" ||
          exeLower === "npx" ||
          exeLower === "pnpm" ||
          exeLower === "yarn");
      // SanitizedLocalSandboxProvider boundary: command and args executed with isolated env and boundary checks.
      // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
      const child = spawn(spawnExec, spawnArgs, {
        cwd: resolvedCwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: sanitizedEnv,
        shell: isBatch,
      });

      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // kill timeout fallback
        }
      }, timeoutMs);

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (
          sandboxTempDir &&
          existsSync(sandboxTempDir) &&
          sandboxTempDir.includes("opencontrib-sandbox-")
        ) {
          try {
            safeRmSync(sandboxTempDir, { recursive: true, force: true });
          } catch {
            // temp cleanup fallback
          }
        }
        const exitCode = timedOut ? 124 : (code ?? 0);
        const combined = `${stdout}\n${stderr}`.trim();
        resolvePromise({
          command: commandDisplay,
          exitCode,
          passed: exitCode === 0,
          stdout,
          stderr,
          output: combined,
          isSandboxed: true,
          isolationWarnings: availability.warnings,
        });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolvePromise({
          command: commandDisplay,
          exitCode: 1,
          passed: false,
          stdout,
          stderr: err.message,
          output: `${stdout}\n${err.message}`.trim(),
          isSandboxed: false,
          isolationWarnings: [err.message],
        });
      });
    });
  }

  executeInSandbox(options: SandboxExecutionOptions): SandboxExecutionResult {
    const {
      cwd,
      workspaceRoot,
      command,
      args = [],
      commandSpec,
      timeoutMs = this.defaultTimeoutMs,
      allowHostFallback = false,
    } = options;

    let finalCommand = command || "";
    let finalArgs = args;

    if (commandSpec) {
      finalCommand = commandSpec.executable;
      finalArgs = commandSpec.args;
    } else if (command && (!args || args.length === 0)) {
      const parsed = parseCommandSpec(command);
      finalCommand = parsed.executable;
      finalArgs = parsed.args;
    }

    const commandDisplay = `${finalCommand} ${finalArgs.join(" ")}`.trim();

    // 1. Mandatory CWD & Workspace Boundary Enforcement
    const resolvedCwd = resolve(cwd);
    if (workspaceRoot) {
      const resolvedRoot = resolve(workspaceRoot);
      if (!this.isPathWithinBoundary(resolvedCwd, resolvedRoot)) {
        return {
          command: commandDisplay,
          exitCode: 126,
          passed: false,
          stdout: "",
          stderr: `Sandbox execution blocked: CWD "${resolvedCwd}" violates workspace boundary "${resolvedRoot}" (Path Traversal Protection / Fail-Closed).`,
          output: `Sandbox execution blocked: CWD "${resolvedCwd}" violates workspace boundary "${resolvedRoot}" (Path Traversal Protection / Fail-Closed).`,
          isSandboxed: false,
          isolationWarnings: ["CWD traverses outside workspace boundary"],
        };
      }
    }

    // 2. Availability & Fail-Closed check
    const availability = this.getAvailability();
    if (!availability.available && !allowHostFallback) {
      return {
        command: commandDisplay,
        exitCode: 127,
        passed: false,
        stdout: "",
        stderr: `Sandbox execution blocked: ${availability.reason || "Sandbox unavailable"} (Fail-Closed).`,
        output: `Sandbox execution blocked: ${availability.reason || "Sandbox unavailable"} (Fail-Closed).`,
        isSandboxed: false,
        isolationWarnings: availability.warnings,
      };
    }

    // 3. Isolated Scratch Directory Creation (Fail-Closed on failure)
    let sandboxTempDir = "";
    try {
      sandboxTempDir = mkdtempSync(join(tmpdir(), "opencontrib-sandbox-"));
    } catch (err: any) {
      if (!allowHostFallback) {
        return {
          command: commandDisplay,
          exitCode: 126,
          passed: false,
          stdout: "",
          stderr: `Sandbox initialization failed: Unable to create isolated scratch directory (${err.message}). Execution blocked (Fail-Closed).`,
          output: `Sandbox initialization failed: Unable to create isolated scratch directory (${err.message}). Execution blocked (Fail-Closed).`,
          isSandboxed: false,
          isolationWarnings: ["Failed to create isolated scratch directory"],
        };
      }
      sandboxTempDir = tmpdir();
    }

    const sanitizedEnv = this.buildSanitizedEnvironment(sandboxTempDir);

    const kernelIsolation = buildKernelIsolationCommand(
      finalCommand,
      finalArgs,
      resolvedCwd,
      this.getDeniedPaths(),
    );
    const spawnExec = kernelIsolation.executable;
    const spawnArgs = kernelIsolation.args;

    try {
      const baseCmd = basename(spawnExec).toLowerCase().replace(/\.exe$/, "");
      const isBatch =
        process.platform === "win32" &&
        (baseCmd === "npm" ||
          baseCmd === "npx" ||
          baseCmd === "pnpm" ||
          baseCmd === "yarn" ||
          spawnExec.toLowerCase().endsWith(".cmd") ||
          spawnExec.toLowerCase().endsWith(".bat"));

      const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
        cwd: resolvedCwd,
        encoding: "utf-8",
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
        env: sanitizedEnv,
        shell: isBatch,
      };

      // SanitizedLocalSandboxProvider boundary: command and args executed synchronously with isolated env and boundary checks.
      // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
      const result = spawnSync(spawnExec, spawnArgs, spawnOptions);

      const stdout = String(result.stdout || "");
      const stderr = String(result.stderr || "");
      const errorText = result.error ? `\n${result.error.message}` : "";
      const combinedOutput = `${stdout}\n${stderr}${errorText}`.trim();

      const exitCode =
        typeof result.status === "number"
          ? result.status
          : result.error
            ? 1
            : 0;
      const passed = exitCode === 0;

      return {
        command: commandDisplay,
        exitCode,
        passed,
        stdout,
        stderr,
        output: combinedOutput,
        isSandboxed: true,
        isolationWarnings: availability.warnings,
      };
    } finally {
      if (
        sandboxTempDir &&
        existsSync(sandboxTempDir) &&
        sandboxTempDir.includes("opencontrib-sandbox-")
      ) {
        try {
          safeRmSync(sandboxTempDir, { recursive: true, force: true });
        } catch {
          // Cleanup best effort
        }
      }
    }
  }
}

export class DockerSandboxProvider implements SandboxProvider {
  public readonly name = "docker_container";
  private readonly defaultTimeoutMs = 120_000;
  private readonly defaultImage = "node:22-alpine";

  getDeniedPaths(): string[] {
    return sensitiveDeniedPaths();
  }

  getAvailability(): SandboxAvailability {
    try {
      const res = spawnSync("docker", ["info"], {
        timeout: 3000,
        stdio: "ignore",
      });
      if (res.status === 0 && !res.error) {
        return {
          available: true,
          isolationMode: "CONTAINER_ISOLATION",
          warnings: [],
        };
      }
    } catch {
      // Docker info fallback
    }
    return {
      available: false,
      isolationMode: "UNAVAILABLE",
      reason: "Docker daemon is not reachable or not running.",
      warnings: ["Docker is not available on host"],
    };
  }

  isPathWithinBoundary(targetPath: string, rootBoundary: string): boolean {
    const resolvedTarget = resolve(targetPath);
    const resolvedRoot = resolve(rootBoundary);
    return (
      resolvedTarget.startsWith(resolvedRoot + sep) ||
      resolvedTarget === resolvedRoot
    );
  }

  execute(options: SandboxExecutionOptions): SandboxExecutionResult {
    const {
      cwd,
      command,
      args = [],
      commandSpec,
      timeoutMs = this.defaultTimeoutMs,
    } = options;
    const resolvedCwd = resolve(cwd);

    let finalCommand = command || "";
    let finalArgs = [...args];
    if (commandSpec) {
      finalCommand = commandSpec.executable;
      finalArgs = [...commandSpec.args];
    } else if (finalCommand && finalArgs.length === 0) {
      const parsed = parseCommandSpec(finalCommand);
      finalCommand = parsed.executable;
      finalArgs = parsed.args;
    }

    const commandDisplay = `${finalCommand} ${finalArgs.join(" ")}`.trim();
    const dockerArgs = [
      "run",
      "--rm",
      "-i",
      "-v",
      `${resolvedCwd}:/workspace`,
      "-w",
      "/workspace",
      this.defaultImage,
      finalCommand,
      ...finalArgs,
    ];

    try {
      const result = spawnSync("docker", dockerArgs, {
        encoding: "utf-8",
        timeout: timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdout = String(result.stdout || "");
      const stderr = String(result.stderr || "");
      const errorText = result.error ? `\n${result.error.message}` : "";
      const combinedOutput = `${stdout}\n${stderr}${errorText}`.trim();
      const exitCode = typeof result.status === "number" ? result.status : 1;

      return {
        command: commandDisplay,
        exitCode,
        passed: exitCode === 0,
        stdout,
        stderr,
        output: combinedOutput,
        isSandboxed: true,
        isolationWarnings: [],
      };
    } catch (err: any) {
      return {
        command: commandDisplay,
        exitCode: 1,
        passed: false,
        stdout: "",
        stderr: err.message,
        output: err.message,
        isSandboxed: false,
        isolationWarnings: [`Docker execution failed: ${err.message}`],
      };
    }
  }
}

// Backward-compatible aliases and default instance
export { SanitizedLocalSandboxProvider as SandboxRuntime };
export const defaultSandboxRuntime = new SanitizedLocalSandboxProvider();
export const defaultSandboxProvider = defaultSandboxRuntime;

export function getAutoSandboxProvider(preferDocker = true): SandboxProvider {
  if (preferDocker) {
    const dockerProvider = new DockerSandboxProvider();
    if (dockerProvider.getAvailability().available) {
      return dockerProvider;
    }
  }
  return defaultSandboxRuntime;
}
