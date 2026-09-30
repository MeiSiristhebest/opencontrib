export type AntiHardcodeRule =
  | 'REPO_LITERAL_DISCRIMINATION'
  | 'ISSUE_NUMBER_HARDCODING'
  | 'ABSOLUTE_ENVIRONMENT_PATH'
  | 'TEST_SAMPLE_SHORT_CIRCUIT';

export interface AntiHardcodeViolation {
  file: string;
  line: string;
  reason: string;
  rule: AntiHardcodeRule;
}

export interface AntiHardcodeAuditResult {
  isClean: boolean;
  violations: AntiHardcodeViolation[];
  summary: string;
}

export interface AntiHardcodeOptions {
  targetRepo?: string;
  issueNumber?: number;
}

function isTestOrDocFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  return (
    /(?:^|\/)(?:tests?|__tests__|testing|fixtures?|mocks?)(?:\/|$)/i.test(norm) ||
    /\.(?:test|spec)\.[a-z0-9]+$/i.test(norm) ||
    /_test\.[a-z0-9]+$/i.test(norm) ||
    /(?:^|\/)test_[a-z0-9_]+\.[a-z0-9]+$/i.test(norm) ||
    /\.(?:md|mdx|rst|txt)$/i.test(norm) ||
    norm.startsWith('.github/')
  );
}

/**
 * Lints patch diffs for anti-generalization defects and lazy model shortcuts, such as
 * hardcoded repository names, hardcoded issue IDs, machine-specific paths, or test-case short-circuits.
 */
export function lintAntiHardcode(
  diffText: string,
  options: AntiHardcodeOptions = {},
): AntiHardcodeAuditResult {
  const violations: AntiHardcodeViolation[] = [];
  if (!diffText || typeof diffText !== 'string') {
    return {
      isClean: true,
      violations: [],
      summary: 'No diff content provided.',
    };
  }

  const lines = diffText.split(/\r?\n/);
  let currentFile = '';
  let inTestOrDoc = false;

  for (const rawLine of lines) {
    // Track file header
    const diffHeaderMatch = rawLine.match(/^diff --git [ab]\/(.+?) [ab]\/(.+)$/);
    if (diffHeaderMatch) {
      currentFile = diffHeaderMatch[2];
      inTestOrDoc = isTestOrDocFile(currentFile);
      continue;
    }
    const plusFileMatch = rawLine.match(/^\+\+\+ [bw]\/(.+)$/);
    if (plusFileMatch) {
      currentFile = plusFileMatch[1];
      inTestOrDoc = isTestOrDocFile(currentFile);
      continue;
    }

    // Only inspect added production code lines (skip diff headers and deleted lines)
    if (!rawLine.startsWith('+') || rawLine.startsWith('+++') || inTestOrDoc) {
      continue;
    }

    const code = rawLine.slice(1).trim();
    if (!code || code.startsWith('//') || code.startsWith('#') || code.startsWith('/*') || code.startsWith('*')) {
      continue;
    }

    // 1. Repo Literal Discrimination in production logic (e.g. if (repo === 'alibaba/open-code-review'))
    if (options.targetRepo) {
      const escapedRepo = options.targetRepo.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      const repoRegex = new RegExp(`['"\`]${escapedRepo}['"\`]`, 'i');
      if (repoRegex.test(code)) {
        violations.push({
          file: currentFile,
          line: code,
          rule: 'REPO_LITERAL_DISCRIMINATION',
          reason: `Production logic hardcodes target repository name '${options.targetRepo}'. Solutions must be generalized and decoupled from repository-specific string literals.`,
        });
        continue;
      }
    }
    // Generic check for owner/repo branching: if (repo.includes("foo/bar")) or repo === "foo/bar"
    const genericRepoDiscrimination = /\b(?:repo|repository|origin|upstream)(?:Name|FullName)?\s*(?:===?|!==?|\.includes\()\s*['"][a-zA-Z0-9_\-.]+\/[a-zA-Z0-9_\-.]+['"]/i;
    if (genericRepoDiscrimination.test(code)) {
      violations.push({
        file: currentFile,
        line: code,
        rule: 'REPO_LITERAL_DISCRIMINATION',
        reason: 'Detected repository-name literal comparison in production code. Use capability/manifest feature detection rather than repo-name discrimination.',
      });
      continue;
    }

    // 2. Issue Number Hardcoding in production logic (e.g. if (issueNumber === 1614))
    if (options.issueNumber) {
      const issueRegex = new RegExp(`\\b(?:issue|issueNumber|issueId|prNumber|ticket|bugId)\\s*(?:===?|==)\\s*${options.issueNumber}\\b`, 'i');
      if (issueRegex.test(code)) {
        violations.push({
          file: currentFile,
          line: code,
          rule: 'ISSUE_NUMBER_HARDCODING',
          reason: `Production logic explicitly branches on issue #${options.issueNumber}. A fix must resolve the underlying logic defect universally, not特判 on the bug identifier.`,
        });
        continue;
      }
    }

    // 3. Absolute Environment Path Traps (e.g. C:\Users\... or /home/runner/work/...)
    const absolutePathRegex = /(?:[A-Za-z]:[/\\]+[Uu]sers[/\\]+[^\s"'\\]+|\/home\/(?:runner|[a-zA-Z0-9_\-]+)\/(?:work|[^\s"'/]+))/i;
    if (absolutePathRegex.test(code)) {
      violations.push({
        file: currentFile,
        line: code,
        rule: 'ABSOLUTE_ENVIRONMENT_PATH',
        reason: 'Hardcoded machine-local or runner-specific absolute path detected in production logic. Paths must be relative or dynamically resolved via environment variables.',
      });
      continue;
    }

    // 4. Test Sample Short-Circuit in production logic (e.g. if (param === '__sample__') return ...)
    const sampleShortCircuitRegex = /if\s*\(\s*[a-zA-Z0-9_.]+\s*(?:===?|==)\s*['"](?:test[-_]sample|mock[-_]input|sample[-_]data|placeholder)['"]\s*\)\s*return/i;
    if (sampleShortCircuitRegex.test(code)) {
      violations.push({
        file: currentFile,
        line: code,
        rule: 'TEST_SAMPLE_SHORT_CIRCUIT',
        reason: 'Detected artificial short-circuit logic tailored solely to satisfy test inputs.',
      });
      continue;
    }
  }

  const isClean = violations.length === 0;
  let summary = 'Anti-hardcode and generalization gate passed cleanly.';
  if (!isClean) {
    summary = `Anti-hardcode gate FAILED: detected ${violations.length} hardcoded shortcut(s) in production logic.`;
  }

  return {
    isClean,
    violations,
    summary,
  };
}
