import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectRunnableCommandsFromDir } from './context-assembler.js';

export type CommitConventionType =
  | 'conventional'
  | 'bracketed_component'
  | 'capitalized_imperative'
  | 'unstructured';

export interface RepoEngineeringFingerprint {
  repoFullName?: string;
  commitStyle: {
    primaryConvention: CommitConventionType;
    sampleRecentCommits: string[];
    requiresSignedOffBy: boolean;
    recommendedCommitExample: string;
  };
  testConventions: {
    filePattern: string;
    frameworkName: string;
    sampleTestPath?: string;
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

  // If commit messages weren't provided directly, attempt to read via runGit
  if (messages.length === 0 && options.runGit && existsSync(repoPath)) {
    try {
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
    } catch {
      // best-effort
    }
  }

  messages = messages.filter((message) => {
    const title = message.trim().split(/\r?\n/, 1)[0] || '';
    return title.length > 0 && !/^merge\b/i.test(title);
  });
  const { convention, requiresSignedOffBy } = classifyCommitConvention(messages);

  let recommendedCommitExample = 'fix(core): handle edge-case null pointer in stream reader';
  if (convention === 'bracketed_component') {
    recommendedCommitExample = '[Core] Fix edge-case null pointer in stream reader';
  } else if (convention === 'capitalized_imperative') {
    recommendedCommitExample = 'Fix edge-case null pointer in stream reader';
  }

  // Detect test conventions from filesystem
  let filePattern = 'unknown';
  let frameworkName = 'unknown';
  let sampleTestPath: string | undefined;

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
      const walkAndFindTest = (dir: string, depth = 0): string | undefined => {
        if (depth > 3) return undefined;
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
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
          } else if (entry.isDirectory()) {
            const found = walkAndFindTest(full, depth + 1);
            if (found) return found;
          }
        }
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

  let personaAdvice = `Target repository favors ${convention} commit messages. Write concise, declarative commits.`;
  if (requiresSignedOffBy) {
    personaAdvice += ' Every commit must include a valid `Signed-off-by` trailer (DCO requirement).';
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
      recommendedCommitExample,
    },
    testConventions: {
      filePattern,
      frameworkName,
      sampleTestPath,
    },
    strictnessGateways: {
      hasPreCommit,
      hasStrictLint: linterCommands.length > 0,
      linterCommands,
    },
    contributorPersonaAdvice: personaAdvice,
  };
}
