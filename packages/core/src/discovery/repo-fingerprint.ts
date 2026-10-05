import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { detectRunnableCommandsFromDir } from './context-assembler.js';

const MAX_TEST_SOURCE_PREFIX_BYTES = 64 * 1024;

export function runRepositoryGit(args: string[]): { success: boolean; stdout: string } {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 25_000,
    env: {
      ...process.env,
      GIT_ASKPASS: 'echo',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  return { success: result.status === 0, stdout: result.stdout || '' };
}

function readSourcePrefix(filePath: string): string {
  const descriptor = openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(MAX_TEST_SOURCE_PREFIX_BYTES);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    closeSync(descriptor);
  }
}

function hasCargoManifestNear(repoPath: string, directory: string): boolean {
  const root = resolve(repoPath);
  const rootPrefix = root.endsWith(sep) ? root : `${root}${sep}`;
  let current = resolve(directory);
  while (current === root || current.startsWith(rootPrefix)) {
    if (existsSync(join(current, 'Cargo.toml'))) return true;
    if (current === root) return false;
    current = dirname(current);
  }
  return false;
}

export type CommitConventionType =
  | 'unknown'
  | 'conventional'
  | 'bracketed_component'
  | 'capitalized_imperative'
  | 'unstructured';

export interface RepoEngineeringFingerprint {
  repoFullName?: string;
  commitStyle: {
    primaryConvention: CommitConventionType;
    sampleRecentCommits: string[];
    requiresSignedOffBy?: boolean;
    historyShallow: boolean;
    recommendedCommitExample: string;
  };
  testConventions: {
    filePattern: string;
    frameworkName: string;
    sampleTestPath?: string;
    searchLimited: boolean;
  };
  strictnessGateways: {
    hasPreCommit: boolean;
    hasStrictLint: boolean;
    linterCommands: string[];
  };
  contributorPersonaAdvice: string;
}

export interface AnalyzeFingerprintOptions {
  repoPath: string;
  repoFullName?: string;
  recentCommitMessages?: string[];
  runGit?: (args: string[]) => { success: boolean; stdout: string };
}

function detectJavaScriptTestFramework(repoPath: string): string {
  try {
    const rootEntries = readdirSync(repoPath);
    const packagePath = join(repoPath, 'package.json');
    let dependencyNames: string[] = [];
    let testScript = '';

    if (existsSync(packagePath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packagePath, 'utf8')) as {
          dependencies?: Record<string, unknown>;
          devDependencies?: Record<string, unknown>;
          peerDependencies?: Record<string, unknown>;
          scripts?: Record<string, unknown>;
        };
        dependencyNames = [
          ...Object.keys(packageJson.dependencies || {}),
          ...Object.keys(packageJson.devDependencies || {}),
          ...Object.keys(packageJson.peerDependencies || {}),
        ];
        testScript = String(packageJson.scripts?.test || '').toLowerCase();
      } catch {
        // An unreadable package manifest does not establish a test runner.
      }
    }

    const hasConfig = (name: string) =>
      rootEntries.some((entry) => entry.toLowerCase().startsWith(name.toLowerCase()));
    const hasDependency = (name: string) =>
      dependencyNames.some((dependency) => dependency.toLowerCase() === name.toLowerCase());

    if (hasDependency('vitest') || hasConfig('vitest.config.')) return 'vitest';
    if (hasDependency('jest') || hasConfig('jest.config.')) return 'jest';
    if (hasDependency('mocha') || hasConfig('.mocharc')) return 'mocha';
    if (hasDependency('ava')) return 'ava';
    if (/\bbun\s+test\b/.test(testScript)) return 'bun test';
    if (/\bnode\s+--test\b/.test(testScript)) return 'node:test';
    if (/\b(?:npm|pnpm|yarn)\s+exec\s+vitest\b/.test(testScript)) return 'vitest';
    if (/\b(?:npm|pnpm|yarn)\s+exec\s+jest\b/.test(testScript)) return 'jest';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Classifies commit message convention based on statistical pattern matching.
 */
export function classifyCommitConvention(messages: string[]): {
  convention: CommitConventionType;
  requiresSignedOffBy: boolean;
} {
  const authoredMessages = (messages || []).filter((message) => {
    const title = message.trim().split(/\r?\n/, 1)[0] || '';
    return title.length > 0 && !/^merge\b/i.test(title);
  });

  if (authoredMessages.length === 0) {
    return {
      convention: 'conventional',
      requiresSignedOffBy: false,
    };
  }

  let conventionalCount = 0;
  let bracketedCount = 0;
  let capitalizedCount = 0;
  let signedOffByCount = 0;

  for (const raw of authoredMessages) {
    const lines = raw.trim().split(/\r?\n/);
    const title = lines[0] || '';
    if (!title) continue;

    // Check signed-off-by trailer in commit body
    if (lines.some((l) => /^Signed-off-by:\s+/i.test(l.trim()))) {
      signedOffByCount++;
    }

    // Conventional Commits: feat(scope): message, fix: message
    if (/^(?:feat|fix|refactor|perf|test|docs|style|build|ci|chore)(?:\([a-zA-Z0-9_\-./]+\))?!?:\s+/i.test(title)) {
      conventionalCount++;
      continue;
    }

    // Bracketed component: [Python] Fix ..., [core/router]: ...
    if (/^\[[a-zA-Z0-9_\-./]+\](?:\s*:\s*|\s+)/.test(title)) {
      bracketedCount++;
      continue;
    }

    // Capitalized imperative: Fix ..., Add ..., Update ..., Implement ...
    if (/^[A-Z][a-z0-9_]+(?:\s+[a-zA-Z0-9_\-]+)+/.test(title)) {
      capitalizedCount++;
    }
  }

  const requiresSignedOffBy =
    signedOffByCount >= Math.ceil(authoredMessages.length * 0.3);
  const strongestStyleCount = Math.max(
    conventionalCount,
    bracketedCount,
    capitalizedCount,
  );

  if (strongestStyleCount / authoredMessages.length <= 0.5) {
    return { convention: 'unstructured', requiresSignedOffBy };
  }
  if (conventionalCount >= bracketedCount && conventionalCount >= capitalizedCount && conventionalCount > 0) {
    return { convention: 'conventional', requiresSignedOffBy };
  }
  if (bracketedCount > conventionalCount && bracketedCount >= capitalizedCount) {
    return { convention: 'bracketed_component', requiresSignedOffBy };
  }
  if (capitalizedCount > 0) {
    return { convention: 'capitalized_imperative', requiresSignedOffBy };
  }

  return { convention: 'unstructured', requiresSignedOffBy };
}

/**
 * Reverse-engineers target repository engineering habits, test file naming conventions,
 * commit formatting rules, and strictness gates to eliminate "outsider / AI" dissonance.
 */
export function analyzeRepoEngineeringFingerprint(
  options: AnalyzeFingerprintOptions,
): RepoEngineeringFingerprint {
  const { repoPath, repoFullName } = options;

  let messages = options.recentCommitMessages || [];
  let historyShallow = false;

  // If commit messages weren't provided directly, attempt to read via runGit
  if (options.runGit && existsSync(repoPath)) {
    try {
      const shallowRes = options.runGit([
        '-C',
        repoPath,
        'rev-parse',
        '--is-shallow-repository',
      ]);
      historyShallow = shallowRes.success && shallowRes.stdout.trim() === 'true';
      if (messages.length === 0) {
        const gitRes = options.runGit([
          '-C',
          repoPath,
          'log',
          '-n',
          '20',
          '--no-merges',
          '--format=%B---COMMIT_SEP---',
        ]);
        if (gitRes.success && gitRes.stdout) {
          messages = gitRes.stdout
            .split('---COMMIT_SEP---')
            .map((m) => m.trim())
            .filter(Boolean);
        }
      }
    } catch {
      // best-effort
    }
  }

  messages = messages.filter((message) => {
    const title = message.trim().split(/\r?\n/, 1)[0] || '';
    return title.length > 0 && !/^merge\b/i.test(title);
  });
  const classifiedConvention = classifyCommitConvention(messages);
  const convention = historyShallow ? 'unknown' : classifiedConvention.convention;
  const requiresSignedOffBy = historyShallow
    ? undefined
    : classifiedConvention.requiresSignedOffBy;

  let recommendedCommitExample = historyShallow
    ? 'Review repository contribution rules before choosing a commit format.'
    : 'fix(core): handle edge-case null pointer in stream reader';
  if (convention === 'bracketed_component') {
    recommendedCommitExample = '[Core] Fix edge-case null pointer in stream reader';
  } else if (convention === 'capitalized_imperative') {
    recommendedCommitExample = 'Fix edge-case null pointer in stream reader';
  }

  // Detect test conventions from filesystem
  let filePattern = 'unknown';
  let frameworkName = 'unknown';
  let sampleTestPath: string | undefined;
  let testSearchLimited = false;

  if (existsSync(repoPath)) {
    try {
      const skippedDirectories = new Set([
        'node_modules',
        '.git',
        'dist',
        'build',
        '.opencontrib',
        '.venv',
        'venv',
        'vendor',
        '.yarn',
        '.pnpm-store',
        '.pytest_cache',
        '.mypy_cache',
        '.ruff_cache',
        '.tox',
        '__pycache__',
        '.cache',
        'coverage',
        '.next',
        '.nuxt',
        '.turbo',
        'target',
      ]);
      const javascriptFramework = detectJavaScriptTestFramework(repoPath);
      const walkAndFindTest = (root: string): string | undefined => {
        const maxScannedEntries = 50_000;
        const directories = [root];
        let nextDirectory = 0;
        let scannedEntries = 0;

        while (
          nextDirectory < directories.length &&
          scannedEntries < maxScannedEntries
        ) {
          const dir = directories[nextDirectory++];
          const entries = readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (scannedEntries >= maxScannedEntries) {
              testSearchLimited = true;
              return undefined;
            }
            scannedEntries += 1;
            if (skippedDirectories.has(entry.name.toLowerCase())) continue;
            const full = join(dir, entry.name);
            if (entry.isFile()) {
              const javascriptTestMatch = entry.name.match(
                /^.+\.(test|spec)\.([cm]?[jt]sx?)$/i,
              );
              if (javascriptTestMatch) {
                filePattern = `*.${javascriptTestMatch[1].toLowerCase()}.${javascriptTestMatch[2].toLowerCase()}`;
                frameworkName = javascriptFramework;
                return full;
              }
              if (/^test_[a-zA-Z0-9_]+\.py$/i.test(entry.name)) {
                filePattern = 'test_*.py';
                frameworkName = 'pytest';
                return full;
              }
              if (/_test\.py$/i.test(entry.name)) {
                filePattern = '*_test.py';
                frameworkName = 'pytest/unittest';
                return full;
              }
              if (/_test\.go$/i.test(entry.name)) {
                filePattern = '*_test.go';
                frameworkName = 'go test';
                return full;
              }
              const relativePath = relative(root, full).replace(/\\/g, '/');
              if (
                /\.rs$/i.test(entry.name) &&
                /^tests\/[^/]+\.rs$/i.test(relativePath) &&
                hasCargoManifestNear(repoPath, dir)
              ) {
                filePattern = 'tests/*.rs';
                frameworkName = 'cargo test';
                return full;
              }
              const jvmPrefixTest = /^Test.*\.(java|kt)$/i.exec(entry.name);
              const jvmSuffixTest = /^.*(Test|Tests|Spec)\.(java|kt)$/i.exec(entry.name);
              const jvmTest = jvmPrefixTest || jvmSuffixTest;
              const dotnetTest = /(?:Test|Tests)\.cs$/i.test(entry.name);
              if (jvmTest || dotnetTest) {
                const contents = readSourcePrefix(full);
                filePattern = jvmTest
                  ? jvmPrefixTest
                    ? `Test*.${jvmTest[1].toLowerCase()}`
                    : `*${jvmTest[1]}.${jvmTest[2].toLowerCase()}`
                  : `*${entry.name.endsWith('Tests.cs') ? 'Tests' : 'Test'}.cs`;
                frameworkName = /\borg\.junit\b/.test(contents) ? 'JUnit'
                  : /\borg\.testng\b/.test(contents) ? 'TestNG'
                  : /\bkotlin\.test\b/.test(contents) ? 'kotlin.test'
                  : /\busing\s+Xunit\b/.test(contents) ? 'xUnit'
                  : /\bNUnit\.Framework\b/.test(contents) ? 'NUnit'
                  : /\bMicrosoft\.VisualStudio\.TestTools\.UnitTesting\b/.test(contents) ? 'MSTest'
                  : 'unknown';
                return full;
              }
            } else if (entry.isDirectory()) {
              directories.push(full);
            }
          }
        }
        if (nextDirectory < directories.length) testSearchLimited = true;
        return undefined;
      };

      sampleTestPath = walkAndFindTest(repoPath);
    } catch {}
  }

  // Detect strictness gateways
  const runnable = existsSync(repoPath) ? detectRunnableCommandsFromDir(repoPath) : {};
  const hasPreCommit = runnable.lintCommand === 'pre-commit run --all-files';
  const linterCommands: string[] = [];
  if (runnable.lintCommand) {
    linterCommands.push(runnable.lintCommand);
  }

  let personaAdvice = historyShallow
    ? 'Commit style and DCO policy could not be inferred because repository history is shallow. Check the repository contribution rules.'
    : `Target repository favors ${convention} commit messages. Write concise, declarative commits.`;
  if (requiresSignedOffBy) {
    personaAdvice += ' Every commit must include a valid `Signed-off-by` trailer (DCO requirement).';
  }
  if (testSearchLimited) {
    personaAdvice += ' Test convention search hit its entry limit; a missing sample is incomplete evidence.';
  }
  if (hasPreCommit) {
    personaAdvice += ' Pre-commit hooks are configured; inspect and follow their checks before pushing.';
  }

  return {
    repoFullName,
    commitStyle: {
      primaryConvention: convention,
      sampleRecentCommits: messages.slice(0, 5),
      requiresSignedOffBy,
      historyShallow,
      recommendedCommitExample,
    },
    testConventions: {
      filePattern,
      frameworkName,
      sampleTestPath,
      searchLimited: testSearchLimited,
    },
    strictnessGateways: {
      hasPreCommit,
      hasStrictLint: linterCommands.length > 0,
      linterCommands,
    },
    contributorPersonaAdvice: personaAdvice,
  };
}
