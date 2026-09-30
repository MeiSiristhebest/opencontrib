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

/**
 * Classifies commit message convention based on statistical pattern matching.
 */
export function classifyCommitConvention(messages: string[]): {
  convention: CommitConventionType;
  requiresSignedOffBy: boolean;
} {
  if (!messages || messages.length === 0) {
    return {
      convention: 'conventional',
      requiresSignedOffBy: false,
    };
  }

  let conventionalCount = 0;
  let bracketedCount = 0;
  let capitalizedCount = 0;
  let signedOffByCount = 0;

  for (const raw of messages) {
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

  const requiresSignedOffBy = signedOffByCount >= Math.max(1, Math.floor(messages.length * 0.3));

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

  const { convention, requiresSignedOffBy } = classifyCommitConvention(messages);

  let recommendedCommitExample = 'fix(core): handle edge-case null pointer in stream reader';
  if (convention === 'bracketed_component') {
    recommendedCommitExample = '[Core] Fix edge-case null pointer in stream reader';
  } else if (convention === 'capitalized_imperative') {
    recommendedCommitExample = 'Fix edge-case null pointer in stream reader';
  }

  // Detect test conventions from filesystem
  let filePattern = 'test_*.py';
  let frameworkName = 'pytest';
  let sampleTestPath: string | undefined;

  if (existsSync(repoPath)) {
    try {
      const walkAndFindTest = (dir: string, depth = 0): string | undefined => {
        if (depth > 3) return undefined;
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (['node_modules', '.git', 'dist', 'build', '.opencontrib'].includes(entry.name)) continue;
          const full = join(dir, entry.name);
          if (entry.isFile()) {
            if (/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(entry.name)) {
              filePattern = '*.test.ts';
              frameworkName = 'vitest/jest';
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
  const hasPreCommit = existsSync(join(repoPath, '.pre-commit-config.yaml')) || existsSync(join(repoPath, '.pre-commit-config.yml'));
  const linterCommands: string[] = [];
  if (runnable.lintCommand) {
    linterCommands.push(runnable.lintCommand);
  }

  let personaAdvice = `Target repository favors ${convention} commit messages. Write concise, declarative commits.`;
  if (requiresSignedOffBy) {
    personaAdvice += ' Every commit must include a valid `Signed-off-by` trailer (DCO requirement).';
  }
  if (hasPreCommit) {
    personaAdvice += ' Pre-commit hooks are configured; all files must pass strict formatting before pushing.';
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
      hasStrictLint: hasPreCommit || linterCommands.length > 0,
      linterCommands,
    },
    contributorPersonaAdvice: personaAdvice,
  };
}
