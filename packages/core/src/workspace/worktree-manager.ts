import { spawnSync } from "child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  type Stats,
} from "fs";
import { homedir as osHomedir, tmpdir } from "os";
import { dirname, join, resolve, sep } from "path";
import { sanitizeRunId } from "../run/artifact-bundle.js";
import { runBranchName } from "../run/run-branch.js";
import { isProtectedWorkspace } from "./workspace-guard.js";
import { getOpenContribDataDir, getOpenContribHome } from "../kernel/home.js";

/** Normalize path separators to forward slashes for consistent comparison on all platforms. */
function norm(p: string): string {
  return p.replace(/\\/g, "/");
}

export const GIT_DEFAULT_TIMEOUT_MS = 25_000;
export const GIT_NETWORK_TIMEOUT_MS = 180_000;

function tryClearWindowsReadOnly(targetPath: string): void {
  if (process.platform !== "win32") return;
  try {
    spawnSync("attrib", ["-r", targetPath, "/s", "/d"], {
      stdio: "ignore",
      timeout: 5000,
    });
  } catch {}
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

  const maxRetries = opts.maxRetries ?? (process.platform === "win32" ? 5 : 2);
  const retryDelay = opts.retryDelay ?? 150;
  let lastError: any = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      rmSync(resolved, {
        recursive: opts.recursive ?? true,
        force: opts.force ?? true,
      });
      return true;
    } catch (err: any) {
      lastError = err;
      if (attempt < maxRetries) {
        if (
          process.platform === "win32" &&
          (err.code === "EPERM" || err.code === "EACCES")
        ) {
          tryClearWindowsReadOnly(resolved);
        }
        const start = Date.now();
        const waitMs = retryDelay * (attempt + 1);
        while (Date.now() - start < waitMs) {
          // busy wait short backoff
        }
      }
    }
  }

  console.error(
    `[SAFE_RMSNRC] FAILED: rmSync('${targetPath}'): ${lastError?.message || "unknown error"}`,
  );
  return false;
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

function workspacePathKey(value: string): string {
  const prefix = sanitizeRunId(value).slice(0, 48) || "task";
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${prefix}-${digest}`;
}

export function linkDependenciesIfPresent(sourceRepoPath: string, targetPath: string): void {
  try {
    const isWin = process.platform === "win32";
    const symlinkType = isWin ? "junction" : "dir";

    // 1. Root node_modules
    const rootNm = join(sourceRepoPath, "node_modules");
    const targetNm = join(targetPath, "node_modules");
    if (existsSync(rootNm) && !existsSync(targetNm)) {
      try {
        symlinkSync(rootNm, targetNm, symlinkType);
      } catch {}
    }

    // 2. Monorepo packages/*/node_modules
    const sourcePackages = join(sourceRepoPath, "packages");
    if (existsSync(sourcePackages)) {
      try {
        const pkgs = readdirSync(sourcePackages);
        for (const pkg of pkgs) {
          const pkgNm = join(sourcePackages, pkg, "node_modules");
          const targetPkgNm = join(targetPath, "packages", pkg, "node_modules");
          if (existsSync(pkgNm) && !existsSync(targetPkgNm)) {
            mkdirSync(join(targetPath, "packages", pkg), { recursive: true });
            try {
              symlinkSync(pkgNm, targetPkgNm, symlinkType);
            } catch {}
          }
        }
      } catch {}
    }

    // 3. Python virtualenv (.venv) if present
    const rootVenv = join(sourceRepoPath, ".venv");
    const targetVenv = join(targetPath, ".venv");
    if (existsSync(rootVenv) && !existsSync(targetVenv)) {
      try {
        symlinkSync(rootVenv, targetVenv, symlinkType);
      } catch {}
    }
  } catch {}
}

export class WorktreeManager {
  private workspaceRoot: string;
  private cacheRoot: string;

  constructor() {
    this.workspaceRoot = join(getOpenContribDataDir(), "workspaces");
    this.cacheRoot = join(getOpenContribDataDir(), "repos");

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
    const result = spawnSync("git", ["-c", "credential.helper=", ...args], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "echo",
        GCM_INTERACTIVE: "never",
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

  isValidCachedRepo(repoPath: string, repoFullName: string): boolean {
    if (!existsSync(repoPath)) return false;
    const rev = this.runGit(["-C", repoPath, "rev-parse", "--git-dir"]);
    if (!rev.success) return false;
    try {
      this.verifyOrigin(repoPath, repoFullName);
      return true;
    } catch {
      return false;
    }
  }

  private resolveUpstreamBase(
    sourceRepoPath: string,
    baseBranch: string,
    repoFullName: string,
  ): string {
    this.verifyOrigin(sourceRepoPath, repoFullName);
    const fetch = this.runGit(
      [
        "-C",
        sourceRepoPath,
        "fetch",
        "origin",
        `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
      ],
      undefined,
      GIT_NETWORK_TIMEOUT_MS,
    );
    if (!fetch.success) {
      throw new Error(
        `WorkspaceBaseCommitUnavailableError: failed to fetch origin/${baseBranch}: ${fetch.stderr.trim() || "unknown Git error"}`,
      );
    }
    let resolved = this.runGit([
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
      // Fallback for bare repositories where remote branches map directly to refs/heads/
      resolved = this.runGit([
        "-C",
        sourceRepoPath,
        "rev-parse",
        "--verify",
        `refs/heads/${baseBranch}^{commit}`,
      ]);
    }
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
    const runSuffix = runId
      ? `-${createHash("sha256").update(runId).digest("hex").slice(0, 16)}`
      : "";
    const issueOrTaskKey = workspacePathKey(String(issueOrTaskId));
    const branchName = runId
      ? runBranchName(runId)
      : `opencontrib/fix-${issueOrTaskId}${runSuffix}`;
    const workspacePath =
      input.workspacePath ||
      join(this.workspaceRoot, `${sanitizedRepoName}__${issueOrTaskKey}${runSuffix}`);

    let sourceRepoPath = localRepoPath;
    if (sourceRepoPath && existsSync(sourceRepoPath)) {
      // Use provided local repo path; resolveUpstreamBase will verify origin and base commit
    } else {
      const cachedRepoPath = join(this.cacheRoot, sanitizedRepoName);
      if (
        existsSync(cachedRepoPath) &&
        !this.isValidCachedRepo(cachedRepoPath, repoFullName)
      ) {
        safeRmSync(cachedRepoPath, { recursive: true, force: true });
      }
      if (!existsSync(cachedRepoPath)) {
        const cloneUrl = `https://github.com/${repoFullName}.git`;
        const cloneResult = this.runGit(
          ["clone", "--bare", "--depth", "1", cloneUrl, cachedRepoPath],
          undefined,
          GIT_NETWORK_TIMEOUT_MS,
        );
        if (!cloneResult.success) {
          if (existsSync(cachedRepoPath)) {
            safeRmSync(cachedRepoPath, { recursive: true, force: true });
          }
          throw new Error(
            `WorkspaceBaseCommitUnavailableError: failed to clone ${repoFullName}: ${cloneResult.stderr.trim() || "Network/Auth failure"}`,
          );
        }
      }
      sourceRepoPath = cachedRepoPath;
    }

    const defaultBranch = this.detectDefaultBranch(sourceRepoPath);
    const baseCommitSha = this.resolveUpstreamBase(
      sourceRepoPath,
      defaultBranch,
      repoFullName,
    );

    if (existsSync(workspacePath)) {
      const head = this.runGit([
        "-C",
        workspacePath,
        "rev-parse",
        "--verify",
        "HEAD",
      ]);
      if (
        head.success &&
        head.stdout.trim().toLowerCase() !== baseCommitSha.toLowerCase()
      ) {
        if (input.workspacePath) {
          throw new Error(
            `WorkspaceBaseCommitUnavailableError: existing workspace '${workspacePath}' is not checked out at verified upstream base ${baseCommitSha}.`,
          );
        }
        // Stale or aborted workspace from an earlier interrupted run; clean up and recreate
        this.cleanupWorkspace(workspacePath, sourceRepoPath);
      } else if (head.success) {
        linkDependenciesIfPresent(sourceRepoPath, workspacePath);
        return {
          workspacePath,
          branchName,
          isWorktree: true,
          baseRepoPath: sourceRepoPath,
          baseCommitSha,
          baseBranch: defaultBranch,
        };
      } else {
        if (input.workspacePath) {
          throw new Error(
            `WorkspaceBaseCommitUnavailableError: existing workspace '${workspacePath}' has corrupt Git metadata.`,
          );
        }
        this.cleanupWorkspace(workspacePath, sourceRepoPath);
      }
    }

    try {
      this.runGit([
        "-C",
        sourceRepoPath,
        "worktree",
        "remove",
        "--force",
        workspacePath,
      ]);
      this.runGit(["-C", sourceRepoPath, "worktree", "prune"]);
      this.runGit(["-C", sourceRepoPath, "branch", "-D", branchName]);

      if (existsSync(workspacePath)) {
        safeRmSync(workspacePath, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200,
        });
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

      linkDependenciesIfPresent(sourceRepoPath, workspacePath);

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
        safeRmSync(workspacePath, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200,
        });
      }
      const cloneUrl = `https://github.com/${repoFullName}.git`;
      const cloneRes = this.runGit(
        [
          "clone",
          "--depth",
          "1",
          "-b",
          defaultBranch,
          cloneUrl,
          workspacePath,
        ],
        undefined,
        GIT_NETWORK_TIMEOUT_MS,
      );
      if (cloneRes.success) {
        const fallbackBaseCommitSha = this.resolveUpstreamBase(
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
          fallbackBaseCommitSha,
        ]);
        if (!checkoutResult.success) {
          throw new Error(
            `WorkspaceBaseCommitUnavailableError: failed to check out verified base ${fallbackBaseCommitSha}.`,
          );
        }
        linkDependenciesIfPresent(sourceRepoPath, workspacePath);
        return {
          workspacePath,
          branchName,
          isWorktree: false,
          baseRepoPath: workspacePath,
          baseCommitSha: fallbackBaseCommitSha,
          baseBranch: defaultBranch,
        };
      } else {
        if (existsSync(workspacePath)) {
          safeRmSync(workspacePath, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 200,
          });
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
        this.runGit(["-C", baseRepoPath, "worktree", "prune"]);
      } catch (removeError) {
        void removeError;
      }
    }

    if (existsSync(workspacePath)) {
      try {
        safeRmSync(workspacePath, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200,
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
    const opencontribHome = norm(resolve(getOpenContribDataDir()));
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
    files: Array<{
      path: string;
      operation: string;
      content?: string;
      mode?: "100644" | "100755" | "120000" | string;
    }>,
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
    for (const f of files) totalChars += f.content ? f.content.length : 0;
    if (totalChars > MAX_GENERATED_FILE_CHARS) {
      errors.push(
        `Generated content size (${totalChars} chars) exceeds safety limit (${MAX_GENERATED_FILE_CHARS})`,
      );
      return { appliedFiles, errors };
    }

    // Reject duplicate normalized paths inside one batch BEFORE any mutation.
    // Without this, a batch such as [CREATE symlink 'escape', MODIFY 'escape']
    // would let the second entry write through the link created by the first.
    const seenNormalizedPaths = new Set<string>();
    for (const f of files) {
      const key = resolve(workspacePath, f.path.replace(/\\/g, "/"));
      if (seenNormalizedPaths.has(key)) {
        errors.push(
          `Security violation: duplicate normalized path '${f.path}' in the same batch; the apply layer refuses to mutate one target twice.`,
        );
        return { appliedFiles, errors };
      }
      seenNormalizedPaths.add(key);
    }

    // Security Hardening: Anti-Symlink Traversal Pre-Validation
    // 1. Collect all paths that this batch will create as symlinks
    const batchSymlinkPaths = new Set<string>();
    for (const f of files) {
      if (f.mode === "120000") {
        batchSymlinkPaths.add(f.path.replace(/\\/g, "/"));
      }
    }

    // 2. Reject any file path whose ancestor is a newly created symlink in this batch
    for (const f of files) {
      const normPath = f.path.replace(/\\/g, "/");
      const parts = normPath.split("/");
      let currentAncestor = "";
      for (let i = 0; i < parts.length - 1; i++) {
        currentAncestor = currentAncestor
          ? `${currentAncestor}/${parts[i]}`
          : parts[i];
        if (batchSymlinkPaths.has(currentAncestor)) {
          errors.push(
            `Security violation: File path '${f.path}' attempts traversal beneath symlink '${currentAncestor}' created in same batch`,
          );
          return { appliedFiles, errors };
        }
      }
    }

    // 3. Reject any file path whose on-disk ancestor is currently a symlink
    const realRoot = existsSync(workspacePath)
      ? realpathSync(workspacePath)
      : resolve(workspacePath);

    for (const f of files) {
      const normPath = f.path.replace(/\\/g, "/");
      const parts = normPath.split("/");
      let currentRel = "";
      for (let i = 0; i < parts.length - 1; i++) {
        currentRel = currentRel ? `${currentRel}/${parts[i]}` : parts[i];
        const checkPath = resolve(workspacePath, currentRel);
        if (existsSync(checkPath)) {
          try {
            const st = lstatSync(checkPath);
            if (st.isSymbolicLink()) {
              errors.push(
                `Security violation: Ancestor path '${currentRel}' of file '${f.path}' is a symbolic link`,
              );
              return { appliedFiles, errors };
            }
          } catch (statErr: unknown) {
            void statErr;
          }
        }
      }

      // Check realpath boundary of parent directory if it exists
      const parentPath = resolve(workspacePath, dirname(f.path));
      if (existsSync(parentPath)) {
        try {
          const realParent = realpathSync(parentPath);
          if (!this.isPathWithinWorkspace(realRoot, realParent)) {
            errors.push(
              `Security violation: Resolved real parent path of '${f.path}' escapes workspace boundary`,
            );
            return { appliedFiles, errors };
          }
        } catch (realErr: unknown) {
          void realErr;
        }
      }
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
        // No-follow final-target inspection: lstat never follows a link, so
        // a symlinked target is observed (and later replaced) instead of
        // written through.
        let targetLstat: Stats | undefined;
        try {
          targetLstat = lstatSync(fullPath);
        } catch {
          targetLstat = undefined;
        }

        // Operation-semantic preflight: the apply layer must agree with the
        // declared patch semantics before touching the filesystem.
        if (f.operation === "CREATE") {
          if (targetLstat !== undefined) {
            errors.push(
              `PatchSemanticViolationError: CREATE target '${f.path}' already exists${targetLstat.isSymbolicLink() ? " (as a symbolic link)" : ""}; expected a missing target.`,
            );
            continue;
          }
        } else if (f.operation === "MODIFY") {
          if (targetLstat === undefined) {
            errors.push(
              `PatchSemanticViolationError: MODIFY target '${f.path}' does not exist; expected an existing file.`,
            );
            continue;
          }
        } else if (f.operation !== "DELETE") {
          errors.push(
            `PatchSemanticViolationError: unsupported operation '${f.operation}' for '${f.path}'.`,
          );
          continue;
        }

        if (f.operation === "DELETE") {
          // Explicit idempotency rule: a missing target is a no-op. rmSync
          // without `recursive` unlinks the link itself when the target is a
          // symlink; it never deletes or follows the link target.
          if (targetLstat !== undefined) rmSync(fullPath, { force: true });
          appliedFiles.push({ path: f.path, operation: "DELETE" });
          continue;
        }

        mkdirSync(dirname(fullPath), { recursive: true });

        // Handle symlink mode 120000: replace whatever occupies the path
        // (regular file or stale link) — rmSync unlinks the link itself.
        if (f.mode === "120000") {
          if (targetLstat !== undefined) rmSync(fullPath, { force: true });
          symlinkSync(f.content || "", fullPath);
        } else {
          // Never write through an existing symlink: unlink it FIRST, then
          // create a fresh regular file at the same path.
          if (targetLstat?.isSymbolicLink()) rmSync(fullPath, { force: true });
          writeFileSync(fullPath, f.content || "", "utf8");
          if (f.mode === "100755" && process.platform !== "win32") {
            const { chmodSync } = require("node:fs");
            chmodSync(fullPath, 0o755);
          }
        }
        appliedFiles.push({ path: f.path, operation: f.operation });
      } catch (err: any) {
        errors.push(`Failed applying '${f.path}': ${err.message}`);
      }
    }

    return { appliedFiles, errors };
  }
}
