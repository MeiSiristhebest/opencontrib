import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { homedir as osHomedir, tmpdir } from "os";
import { dirname, join, resolve, sep } from "path";
import { sanitizeRunId } from "../run/artifact-bundle.js";
import { runBranchName } from "../run/run-branch.js";
import { isProtectedWorkspace } from "./workspace-guard.js";
import { getOpenContribHome } from "../kernel/home.js";

/** Normalize path separators to forward slashes for consistent comparison on all platforms. */
function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

export function safeRmSync(
  targetPath: string,
  opts: {
    recursive?: boolean;
    force?: boolean;
    maxRetries?: number;
    retryDelay?: number;
  } = {},
  allowedParents?: string[],
): boolean {
  const resolved = norm(resolve(targetPath));
  const homedirPath = norm(resolve(osHomedir()));
  const tempDir = norm(resolve(tmpdir()));
  const customHome = getOpenContribHome();
  const opencontribHome = norm(resolve(homedirPath, ".opencontrib"));
  const customOpencontribHome = norm(
    resolve(
      customHome.endsWith(".opencontrib")
        ? customHome
        : join(customHome, ".opencontrib"),
    ),
  );

  const SEP = "/";

  // Allowlist: must be within one of these parents
  const defaultAllowed = [
    opencontribHome,
    customOpencontribHome,
    tempDir,
    ...(allowedParents || []).map((p) => norm(resolve(p))),
  ];
  const isWithinAllowed = defaultAllowed.some(
    (parent) => resolved === parent || resolved.startsWith(parent + SEP),
  );

  if (!isWithinAllowed) {
    console.error(
      `[SAFE_RMSNRC] BLOCKED: '${targetPath}' is outside allowed parent directories`,
    );
    console.error(`  Allowed: ${defaultAllowed.join(", ")}`);
    console.error(`  Target:  ${resolved}`);
    return false;
  }

  // Never delete root directories themselves (only their children)
  if (
    resolved === opencontribHome ||
    resolved === customOpencontribHome ||
    resolved === homedirPath ||
    resolved === norm(resolve(customHome)) ||
    resolved === tempDir ||
    resolved === "/"
  ) {
    console.error(
      `[SAFE_RMSNRC] BLOCKED: Refusing to delete root directory '${targetPath}'`,
    );
    return false;
  }

  // Never delete a protected workspace (guardfile enforcement)
  if (isProtectedWorkspace(resolved)) {
    console.error(
      `[SAFE_RMSNRC] BLOCKED: '${targetPath}' contains .opencontrib-guard, refusing to delete protected workspace`,
    );
    return false;
  }

  try {
    rmSync(resolved, opts);
    return true;
  } catch (err: any) {
    console.error(
      `[SAFE_RMSNRC] FAILED: rmSync('${targetPath}'): ${err.message}`,
    );
    return false;
  }
}

export const MAX_DISCOVERED_FILES = 250;
export const MAX_GENERATED_FILES = 6;
export const MAX_GENERATED_FILE_CHARS = 60_000;
export const MAX_SNIPPET_CHARS = 8_000;

export interface WorkspaceContext {
  workspacePath: string;
  branchName: string;
  isWorktree: boolean;
  baseRepoPath: string;
  baseCommitSha: string;
  baseBranch?: string;
}

export class WorktreeManager {
  private workspaceRoot: string;
  private cacheRoot: string;

  constructor() {
    this.workspaceRoot = join(
      getOpenContribHome(),
      ".opencontrib",
      "workspaces",
    );
    this.cacheRoot = join(getOpenContribHome(), ".opencontrib", "repos");

    if (!existsSync(this.workspaceRoot))
      mkdirSync(this.workspaceRoot, { recursive: true });
    if (!existsSync(this.cacheRoot))
      mkdirSync(this.cacheRoot, { recursive: true });
  }

  runGit(
    args: string[],
    cwd?: string,
    timeoutMs = 25000,
  ): { success: boolean; stdout: string; stderr: string } {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "echo",
      },
    });
    return {
      success: result.status === 0,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
    };
  }

  detectDefaultBranch(sourceRepoPath: string): string {
    const headResult = this.runGit([
      "-C",
      sourceRepoPath,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
    ]);
    if (headResult.success && headResult.stdout.trim()) {
      const match = headResult.stdout
        .trim()
        .match(/refs\/remotes\/origin\/(.+)$/);
      if (match) return match[1];
    }

    const branchResult = this.runGit(["-C", sourceRepoPath, "branch", "-a"]);
    if (branchResult.success) {
      if (branchResult.stdout.includes("main")) return "main";
      if (branchResult.stdout.includes("master")) return "master";
    }

    return "main";
  }

  private verifyOrigin(sourceRepoPath: string, repoFullName: string): void {
    const remote = this.runGit([
      "-C",
      sourceRepoPath,
      "remote",
      "get-url",
      "origin",
    ]);
    const originUrl = remote.stdout.trim().toLowerCase().replace(/\\/g, "/");
    const prefixes = [
      "https://github.com/",
      "http://github.com/",
      "git@github.com:",
      "ssh://git@github.com/",
    ];
    const prefix = prefixes.find((candidate) =>
      originUrl.startsWith(candidate),
    );
    const originRepo = prefix
      ? originUrl.slice(prefix.length).replace(/\.git$/, "")
      : undefined;
    if (!remote.success || originRepo !== repoFullName.toLowerCase().trim()) {
      throw new Error(
        `WorkspaceOriginVerificationError: repository '${sourceRepoPath}' origin does not match '${repoFullName}'.`,
      );
    }
  }

  private resolveUpstreamBase(
    sourceRepoPath: string,
    baseBranch: string,
    repoFullName: string,
  ): string {
    this.verifyOrigin(sourceRepoPath, repoFullName);
    const fetch = this.runGit([
      "-C",
      sourceRepoPath,
      "fetch",
      "--prune",
      "origin",
      `${baseBranch}:refs/remotes/origin/${baseBranch}`,
    ]);
    if (!fetch.success) {
      throw new Error(
        `WorkspaceBaseCommitUnavailableError: failed to fetch origin/${baseBranch}: ${fetch.stderr.trim() || "unknown Git error"}`,
      );
    }
    const resolved = this.runGit([
      "-C",
      sourceRepoPath,
      "rev-parse",
      "--verify",
      `refs/remotes/origin/${baseBranch}^{commit}`,
    ]);
    if (
      !resolved.success ||
      !/^[0-9a-f]{7,64}$/i.test(resolved.stdout.trim())
    ) {
      throw new Error(
        `WorkspaceBaseCommitUnavailableError: cannot resolve verified origin/${baseBranch} after fetch.`,
      );
    }
    return resolved.stdout.trim();
  }

  createIsolatedWorkspace(input: {
    repoFullName: string;
    issueOrTaskId: string | number;
    localRepoPath?: string;
    runId?: string;
    /** Existing canonical workspace to revalidate without reallocating it. */
    workspacePath?: string;
  }): WorkspaceContext {
    const { repoFullName, issueOrTaskId, localRepoPath, runId } = input;
    const sanitizedRepoName = repoFullName.replace("/", "__");
    const cleanRunId = runId ? sanitizeRunId(runId) : "";
    const runSuffix = cleanRunId ? `-${cleanRunId.slice(-6)}` : "";
    const branchName = runId
      ? runBranchName(runId)
      : `opencontrib/fix-${issueOrTaskId}${runSuffix}`;
    const workspacePath =
      input.workspacePath ||
      join(
        this.workspaceRoot,
        `${sanitizedRepoName}__${issueOrTaskId}${runSuffix}`,
      );

    let sourceRepoPath = localRepoPath;
    if (!sourceRepoPath || !existsSync(sourceRepoPath)) {
      sourceRepoPath = join(this.cacheRoot, sanitizedRepoName);
    }

    if (existsSync(workspacePath)) {
      if (!existsSync(sourceRepoPath)) {
        throw new Error(
          `WorkspaceBaseCommitUnavailableError: existing workspace '${workspacePath}' has no verifiable upstream repository.`,
        );
      }
      const baseBranch = this.detectDefaultBranch(sourceRepoPath);
      const baseCommitSha = this.resolveUpstreamBase(
        sourceRepoPath,
        baseBranch,
        repoFullName,
      );
      const head = this.runGit([
        "-C",
        workspacePath,
        "rev-parse",
        "--verify",
        "HEAD",
      ]);
      if (
        !head.success ||
        head.stdout.trim().toLowerCase() !== baseCommitSha.toLowerCase()
      ) {
        throw new Error(
          `WorkspaceBaseCommitUnavailableError: existing workspace '${workspacePath}' is not checked out at verified upstream base ${baseCommitSha}.`,
        );
      }
      return {
        workspacePath,
        branchName,
        isWorktree: true,
        baseRepoPath: sourceRepoPath,
        baseCommitSha,
        baseBranch,
      };
    }

    if (localRepoPath && existsSync(localRepoPath)) {
      sourceRepoPath = localRepoPath;
    }

    if (!sourceRepoPath || !existsSync(sourceRepoPath)) {
      const cachedRepoPath = join(this.cacheRoot, sanitizedRepoName);
      if (!existsSync(cachedRepoPath)) {
        const cloneUrl = `https://github.com/${repoFullName}.git`;
        const cloneResult = this.runGit([
          "clone",
          "--bare",
          "--depth",
          "1",
          cloneUrl,
          cachedRepoPath,
        ]);
        if (!cloneResult.success) {
          throw new Error(
            `WorkspaceBaseCommitUnavailableError: failed to clone ${repoFullName}: ${cloneResult.stderr.trim() || "Network/Auth failure"}`,
          );
        }
      }
      sourceRepoPath = cachedRepoPath;
    }

    const defaultBranch = this.detectDefaultBranch(sourceRepoPath);

    try {
      // Never use the local repository HEAD as the contribution base. Fetch
      // and resolve the exact upstream remote-tracking commit first.
      const baseCommitSha = this.resolveUpstreamBase(
        sourceRepoPath,
        defaultBranch,
        repoFullName,
      );

      this.runGit(["-C", sourceRepoPath, "worktree", "prune"]);
      this.runGit(["-C", sourceRepoPath, "branch", "-D", branchName]);

      if (existsSync(workspacePath)) {
        try {
          safeRmSync(workspacePath, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 100,
          });
        } catch (cleanupError) {
          void cleanupError;
        }
      }

      const addResult = this.runGit([
        "-C",
        sourceRepoPath,
        "worktree",
        "add",
        "--force",
        "-B",
        branchName,
        workspacePath,
        baseCommitSha,
      ]);

      if (!addResult.success) throw new Error(addResult.stderr);

      return {
        workspacePath,
        branchName,
        isWorktree: true,
        baseRepoPath: sourceRepoPath,
        baseCommitSha,
        baseBranch: defaultBranch,
      };
    } catch (createWorktreeError: any) {
      void createWorktreeError;
      if (existsSync(workspacePath)) {
        try {
          safeRmSync(workspacePath, {
            recursive: true,
            force: true,
            maxRetries: 3,
            retryDelay: 100,
          });
        } catch (cleanupError) {
          void cleanupError;
        }
      }
      mkdirSync(workspacePath, { recursive: true });
      const cloneUrl = `https://github.com/${repoFullName}.git`;
      const cloneRes = this.runGit([
        "clone",
        "--depth",
        "1",
        "-b",
        defaultBranch,
        cloneUrl,
        workspacePath,
      ]);
      if (cloneRes.success) {
        const baseCommitSha = this.resolveUpstreamBase(
          workspacePath,
          defaultBranch,
          repoFullName,
        );
        const checkoutResult = this.runGit([
          "-C",
          workspacePath,
          "checkout",
          "-B",
          branchName,
          baseCommitSha,
        ]);
        if (!checkoutResult.success) {
          throw new Error(
            `WorkspaceBaseCommitUnavailableError: failed to check out verified base ${baseCommitSha}.`,
          );
        }
        return {
          workspacePath,
          branchName,
          isWorktree: false,
          baseRepoPath: workspacePath,
          baseCommitSha,
          baseBranch: defaultBranch,
        };
      } else {
        if (existsSync(workspacePath)) {
          try {
            safeRmSync(workspacePath, {
              recursive: true,
              force: true,
              maxRetries: 3,
              retryDelay: 100,
            });
          } catch (cleanupError) {
            void cleanupError;
          }
        }
        throw new Error(
          `WorkspaceBaseCommitUnavailableError: failed to clone ${repoFullName}: ${cloneRes.stderr.trim() || "Network/Auth failure"}`,
        );
      }
    }
  }

  cleanupWorkspace(workspacePath: string, baseRepoPath?: string): void {
    if (!existsSync(workspacePath)) return;

    if (baseRepoPath && existsSync(baseRepoPath)) {
      try {
        this.runGit([
          "-C",
          baseRepoPath,
          "worktree",
          "remove",
          "--force",
          workspacePath,
        ]);
      } catch (removeError) {
        void removeError;
      }
    }

    if (existsSync(workspacePath)) {
      try {
        safeRmSync(workspacePath, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        });
      } catch (cleanupError) {
        void cleanupError;
      }
    }
  }

  listWorkspaces(): Array<{
    name: string;
    path: string;
    isProtected: boolean;
  }> {
    if (!existsSync(this.workspaceRoot)) return [];
    try {
      const items = readdirSync(this.workspaceRoot);
      return items.map((item) => {
        const fullPath = join(this.workspaceRoot, item);
        return {
          name: item,
          path: fullPath,
          isProtected: isProtectedWorkspace(fullPath),
        };
      });
    } catch {
      return [];
    }
  }

  purgeAllWorkspaces(
    options: { cleanRepos?: boolean; cleanScratchDir?: string } = {},
  ): {
    purgedWorkspaces: string[];
    purgedScratchFiles: string[];
    cleanedRepos: boolean;
  } {
    const { cleanRepos = false, cleanScratchDir } = options;
    const purgedWorkspaces: string[] = [];
    const purgedScratchFiles: string[] = [];

    if (existsSync(this.workspaceRoot)) {
      const items = readdirSync(this.workspaceRoot);
      for (const item of items) {
        const itemPath = join(this.workspaceRoot, item);
        try {
          if (safeRmSync(itemPath, { recursive: true, force: true })) {
            purgedWorkspaces.push(item);
          }
        } catch (cleanupError) {
          void cleanupError;
        }
      }
    }

    let cleanedRepos = false;
    if (cleanRepos && existsSync(this.cacheRoot)) {
      try {
        if (safeRmSync(this.cacheRoot, { recursive: true, force: true })) {
          mkdirSync(this.cacheRoot, { recursive: true });
          cleanedRepos = true;
        }
      } catch (cleanupError) {
        void cleanupError;
      }
    }

    if (cleanScratchDir && existsSync(cleanScratchDir)) {
      if (!this.isSafeScratchDirectory(cleanScratchDir)) {
        throw new Error(
          `Security boundary violation: cleanScratchDir "${cleanScratchDir}" is not a permitted scratch location.`,
        );
      }
      const scratchItems = readdirSync(cleanScratchDir);
      for (const item of scratchItems) {
        const itemPath = join(cleanScratchDir, item);
        try {
          if (safeRmSync(itemPath, { recursive: true, force: true })) {
            purgedScratchFiles.push(item);
          }
        } catch (cleanupError) {
          void cleanupError;
        }
      }
    }

    return {
      purgedWorkspaces,
      purgedScratchFiles,
      cleanedRepos,
    };
  }

  isSafeScratchDirectory(dirPath: string): boolean {
    const resolved = norm(resolve(dirPath));
    const opencontribHome = norm(resolve(getOpenContribHome(), ".opencontrib"));
    const tempDir = norm(resolve(tmpdir()));

    if (resolved === "/" || resolved === norm(resolve(getOpenContribHome()))) {
      return false;
    }

    if (
      resolved.startsWith(opencontribHome + "/") ||
      resolved === opencontribHome
    ) {
      return true;
    }
    if (resolved.startsWith(tempDir + "/") || resolved === tempDir) {
      return true;
    }

    // Allow dedicated scratch directories (e.g., ./scratch, .opencontrib/scratch, temp/scratch)
    if (resolved.endsWith("/scratch") || resolved.endsWith("/.scratch")) {
      return true;
    }

    return false;
  }

  isPathWithinWorkspace(
    workspacePath: string,
    targetRelativePath: string,
  ): boolean {
    const resolvedRoot = resolve(workspacePath);
    const resolvedTarget = resolve(workspacePath, targetRelativePath);
    return (
      resolvedTarget.startsWith(resolvedRoot + sep) ||
      resolvedTarget === resolvedRoot
    );
  }

  applySurgicalFilesSafely(
    workspacePath: string,
    files: Array<{ path: string; operation: string; content: string }>,
  ): {
    appliedFiles: Array<{ path: string; operation: string }>;
    errors: string[];
  } {
    const appliedFiles: Array<{ path: string; operation: string }> = [];
    const errors: string[] = [];

    if (files.length > MAX_GENERATED_FILES) {
      errors.push(
        `Generated files count (${files.length}) exceeds safety limit (${MAX_GENERATED_FILES})`,
      );
      return { appliedFiles, errors };
    }

    let totalChars = 0;
    for (const f of files) totalChars += f.content.length;
    if (totalChars > MAX_GENERATED_FILE_CHARS) {
      errors.push(
        `Generated content size (${totalChars} chars) exceeds safety limit (${MAX_GENERATED_FILE_CHARS})`,
      );
      return { appliedFiles, errors };
    }

    for (const f of files) {
      if (!this.isPathWithinWorkspace(workspacePath, f.path)) {
        errors.push(
          `Security violation: File path '${f.path}' attempts path traversal outside workspace root`,
        );
        continue;
      }

      const normalizedPath = f.path.replace(/\\/g, "/");
      if (normalizedPath.startsWith(".git/") || normalizedPath === ".git") {
        errors.push(
          `Security violation: Write to protected directory '${f.path}' is forbidden`,
        );
        continue;
      }

      const fullPath = resolve(workspacePath, f.path);
      try {
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, f.content, "utf8");
        appliedFiles.push({ path: f.path, operation: f.operation });
      } catch (err: any) {
        errors.push(`Failed writing '${f.path}': ${err.message}`);
      }
    }

    return { appliedFiles, errors };
  }
}
