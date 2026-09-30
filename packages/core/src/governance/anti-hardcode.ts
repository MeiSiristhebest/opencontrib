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

interface DiffPathToken {
  value: string;
  end: number;
}

interface DiffLexerState {
  inBlockComment: boolean;
  stringDelimiter?: string;
  stringTokenId?: string;
  stringValue: string;
  nextToken: number;
}

interface DiffLineRecord {
  added: boolean;
  hunk: number;
  content: string;
  code: string;
}

const SOURCE_FILE_EXTENSION =
  /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|swift|cs|c|h|cc|cpp|hpp|php|rb|sh|bash|zsh|ps1|scala|sc|dart|ex|exs|lua|sql|sol)$/i;

function isSourceCodeFile(filePath: string): boolean {
  if (!filePath || !/\.[^/]+$/.test(filePath)) return true;
  return SOURCE_FILE_EXTENSION.test(filePath);
}

function isTestOrDocFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  return (
    /(?:^|\/)(?:tests?|__tests__|fixtures?)(?:\/|$)/.test(norm) ||
    /\.(?:test|spec)\.[a-z0-9]+$/i.test(norm) ||
    /_test\.[a-z0-9]+$/i.test(norm) ||
    /(?:^|\/)test_[a-z0-9_]+\.[a-z0-9]+$/i.test(norm) ||
    /\.(?:md|mdx|rst|txt)$/i.test(norm) ||
    norm.startsWith('.github/')
  );
}

function readDiffPathToken(input: string, start = 0): DiffPathToken | undefined {
  let index = start;
  while (index < input.length && /\s/.test(input[index])) index++;
  if (index >= input.length) return undefined;

  if (input[index] !== '"') {
    const tokenStart = index;
    while (index < input.length && !/\s/.test(input[index])) index++;
    return { value: input.slice(tokenStart, index), end: index };
  }

  index++;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  while (index < input.length) {
    const char = input[index++];
    if (char === '"') {
      return {
        value: new TextDecoder('utf-8').decode(new Uint8Array(bytes)),
        end: index,
      };
    }
    if (char !== '\\') {
      const codePoint = input.codePointAt(index - 1);
      const value = String.fromCodePoint(codePoint ?? char.charCodeAt(0));
      if (value.length > 1) index++;
      bytes.push(...encoder.encode(value));
      continue;
    }

    if (/^[0-7]{3}$/.test(input.slice(index, index + 3))) {
      bytes.push(Number.parseInt(input.slice(index, index + 3), 8));
      index += 3;
      continue;
    }

    const escaped = input[index++];
    const decodedEscape: Record<string, string> = {
      a: '\x07',
      b: '\b',
      t: '\t',
      n: '\n',
      v: '\v',
      f: '\f',
      r: '\r',
      '"': '"',
      '\\': '\\',
    };
    bytes.push(...encoder.encode(decodedEscape[escaped] ?? escaped));
  }

  return undefined;
}

function stripDiffPrefix(path: string): string {
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}

function parseGitDiffPath(header: string): string | undefined {
  const payload = header.slice('diff --git '.length);
  const oldPath = readDiffPathToken(payload);
  if (!oldPath) return undefined;
  const newPath = readDiffPathToken(payload, oldPath.end);
  return newPath ? stripDiffPrefix(newPath.value) : undefined;
}

function parseUnifiedNewPath(header: string): string | undefined {
  const token = readDiffPathToken(header.slice('+++ '.length));
  if (!token || token.value === '/dev/null') return undefined;
  return stripDiffPrefix(token.value);
}

function isHashCommentLanguage(filePath: string): boolean {
  return /\.(?:py|sh|bash|zsh|ps1|rb)$/i.test(filePath);
}

function extractTemplateExpressions(templateBody: string): string[] {
  const expressions: string[] = [];

  for (let index = 0; index < templateBody.length; index++) {
    if (templateBody[index] === '\\') {
      index++;
      continue;
    }
    if (templateBody[index] !== '$' || templateBody[index + 1] !== '{') {
      continue;
    }

    const expressionStart = index + 2;
    let braceDepth = 1;
    let quote: string | undefined;
    let inLineComment = false;
    let inBlockComment = false;
    let expressionEnd = -1;

    for (let cursor = expressionStart; cursor < templateBody.length; cursor++) {
      const current = templateBody[cursor];
      const next = templateBody[cursor + 1];

      if (inLineComment) {
        if (current === '\n') inLineComment = false;
        continue;
      }
      if (inBlockComment) {
        if (current === '*' && next === '/') {
          inBlockComment = false;
          cursor++;
        }
        continue;
      }
      if (quote) {
        if (current === '\\') {
          cursor++;
        } else if (current === quote) {
          quote = undefined;
        }
        continue;
      }

      if (current === '/' && next === '/') {
        inLineComment = true;
        cursor++;
        continue;
      }
      if (current === '/' && next === '*') {
        inBlockComment = true;
        cursor++;
        continue;
      }
      if (current === '"' || current === "'" || current === '`') {
        quote = current;
        continue;
      }
      if (current === '{') {
        braceDepth++;
      } else if (current === '}' && --braceDepth === 0) {
        expressionEnd = cursor;
        break;
      }
    }

    if (expressionEnd < 0) break;
    expressions.push(templateBody.slice(expressionStart, expressionEnd));
    index = expressionEnd;
  }

  return expressions;
}

function scanDiffSourceLine(
  line: string,
  filePath: string,
  state: DiffLexerState,
  stringValues: Map<string, string>,
): string {
  let index = 0;
  let code = '';
  const hashComments = isHashCommentLanguage(filePath);
  const supportsTripleQuotes = /\.py$/i.test(filePath);

  while (index < line.length) {
    if (state.inBlockComment) {
      const end = line.indexOf('*/', index);
      if (end < 0) break;
      state.inBlockComment = false;
      index = end + 2;
      continue;
    }

    if (state.stringDelimiter) {
      if (line[index] === '\\' && index + 1 < line.length) {
        state.stringValue += line.slice(index, index + 2);
        index += 2;
      } else if (line.startsWith(state.stringDelimiter, index)) {
        if (state.stringTokenId) {
          stringValues.set(`__STR_${state.stringTokenId}__`, state.stringValue);
          if (state.stringDelimiter === '`') {
            for (const expression of extractTemplateExpressions(state.stringValue)) {
              const expressionState: DiffLexerState = {
                inBlockComment: false,
                stringValue: '',
                nextToken: state.nextToken,
              };
              code += ` ${scanDiffSourceLine(expression, filePath, expressionState, stringValues)} `;
              state.nextToken = expressionState.nextToken;
            }
          }
        }
        index += state.stringDelimiter.length;
        state.stringDelimiter = undefined;
        state.stringTokenId = undefined;
        state.stringValue = '';
      } else {
        state.stringValue += line[index];
        index++;
      }
      continue;
    }

    if (line.startsWith('/*', index)) {
      state.inBlockComment = true;
      index += 2;
      continue;
    }
    if (!hashComments && line.startsWith('//', index)) break;
    if (hashComments && line[index] === '#') break;

    const quote = line[index];
    if (quote === '"' || quote === "'" || quote === '`') {
      const delimiter =
        supportsTripleQuotes && line.startsWith(quote.repeat(3), index)
          ? quote.repeat(3)
          : quote;
      const tokenId = String(state.nextToken++);
      state.stringDelimiter = delimiter;
      state.stringTokenId = tokenId;
      state.stringValue = '';
      stringValues.set(`__STR_${tokenId}__`, '');
      code += `__STR_${tokenId}__`;
      index += delimiter.length;
      continue;
    }

    code += line[index];
    index++;
  }

  if (state.stringDelimiter === '`') state.stringValue += '\n';
  if (state.stringTokenId) {
    stringValues.set(`__STR_${state.stringTokenId}__`, state.stringValue);
  }
  return code;
}

function addViolation(
  violations: AntiHardcodeViolation[],
  file: string,
  line: string,
  rule: AntiHardcodeRule,
  reason: string,
): void {
  violations.push({ file, line, rule, reason });
}

function analyzeFileChanges(
  filePath: string,
  records: DiffLineRecord[],
  stringValues: Map<string, string>,
  options: AntiHardcodeOptions,
  violations: AntiHardcodeViolation[],
): void {
  if (!isSourceCodeFile(filePath) || isTestOrDocFile(filePath)) return;

  const repoReference =
    /\b(?:target)?(?:repo|repository|origin|upstream)(?:Name|FullName)?\s*(?:=+|!==?|\.includes\s*\()\s*(__STR_\d+__)/i;
  const issueNumberPattern = options.issueNumber
    ? new RegExp(
        `\\b(?:issue(?:Number|Id)?|prNumber|ticket|bugId)(?:\\s*(?:\\?\\.|\\.)\\s*(?:number|id))?\\s*(?:===|==)\\s*${options.issueNumber}\\b`,
        'i',
      )
    : undefined;
  const absolutePathPatterns = [
    /^[a-z]:[\\/]/i,
    /^\\\\[^\\/]+[\\/][^\\/]+/,
    /^~[\\/]/,
    /^\/(?:home|root|tmp|var|etc|usr|opt|mnt|media|private|volumes|library|system|applications|workspace|workspaces|dev|proc|run|srv|bin|sbin|lib)(?:\/|$)/i,
    /^\/Users(?:\/|$)/,
  ];

  for (const record of records) {
    if (!record.added) continue;
    const code = record.code.trim();
    if (!code) continue;

    const repoMatch = repoReference.exec(code);
    if (repoMatch) {
      const literal = stringValues.get(repoMatch[1]);
      if (literal && options.targetRepo && literal.toLowerCase() === options.targetRepo.toLowerCase()) {
        addViolation(
          violations,
          filePath,
          record.content.trim(),
          'REPO_LITERAL_DISCRIMINATION',
          `Production logic hardcodes target repository name '${options.targetRepo}'. Solutions must be generalized and decoupled from repository-specific string literals.`,
        );
        continue;
      }
      if (literal && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(literal)) {
        addViolation(
          violations,
          filePath,
          record.content.trim(),
          'REPO_LITERAL_DISCRIMINATION',
          'Detected repository-name literal comparison in production code. Use capability/manifest feature detection rather than repo-name discrimination.',
        );
        continue;
      }
    }

    if (issueNumberPattern?.test(code)) {
      addViolation(
        violations,
        filePath,
        record.content.trim(),
        'ISSUE_NUMBER_HARDCODING',
        `Production logic explicitly branches on issue #${options.issueNumber}. A fix must resolve the underlying logic defect universally rather than special-casing the bug identifier.`,
      );
      continue;
    }

    for (const pathToken of new Set(code.match(/__STR_\d+__/g) || [])) {
      const value = stringValues.get(pathToken)?.replace(/\\\\/g, '\\').trim();
      if (value && absolutePathPatterns.some((pattern) => pattern.test(value))) {
        addViolation(
          violations,
          filePath,
          record.content.trim(),
          'ABSOLUTE_ENVIRONMENT_PATH',
          'Hardcoded absolute path detected in production logic. Resolve paths from repository or environment context instead.',
        );
      }
    }
  }

  const hunks = new Map<number, DiffLineRecord[]>();
  for (const record of records) {
    const lines = hunks.get(record.hunk) || [];
    lines.push(record);
    hunks.set(record.hunk, lines);
  }

  const shortCircuitPattern =
    /\bif\s*\(\s*[a-zA-Z_$][\w$]*(?:(?:\?\.|\.)[a-zA-Z_$][\w$]*)*\s*(?:===|==)\s*(__STR_\d+__)\s*\)\s*(?:\{[^}]{0,500}?\breturn\b|\breturn\b)/i;
  const sampleValuePattern = /^(?:test[-_]sample|mock[-_]input|sample[-_]data|placeholder)$/i;

  for (const hunkRecords of hunks.values()) {
    const hunkCode = hunkRecords.map((record) => record.code).join('\n');
    for (const match of hunkCode.matchAll(new RegExp(shortCircuitPattern, 'gi'))) {
      const tokenId = match[1];
      const sampleValue = stringValues.get(tokenId);
      const condition = hunkRecords.find(
        (record) => record.added && record.code.includes(tokenId),
      );
      if (!sampleValue || !sampleValuePattern.test(sampleValue) || !condition) continue;
      addViolation(
        violations,
        filePath,
        condition.content.trim(),
        'TEST_SAMPLE_SHORT_CIRCUIT',
        'Detected artificial short-circuit logic tailored solely to satisfy test inputs.',
      );
    }
  }
}

/**
 * Lints source-code additions for repository-specific workarounds, issue-number branches,
 * machine-local paths, and test-sample short-circuits.
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

  let currentFile = '';
  let inHunk = false;
  let currentHunk = 0;
  let records: DiffLineRecord[] = [];
  let stringValues = new Map<string, string>();
  let lexerState: DiffLexerState = {
    inBlockComment: false,
    stringValue: '',
    nextToken: 1,
  };

  const finishFile = () => {
    analyzeFileChanges(currentFile, records, stringValues, options, violations);
  };
  const resetFile = (filePath: string) => {
    currentFile = filePath;
    records = [];
    stringValues = new Map<string, string>();
    lexerState = { inBlockComment: false, stringValue: '', nextToken: 1 };
    inHunk = false;
    currentHunk = 0;
  };

  for (const rawLine of diffText.split(/\r?\n/)) {
    if (rawLine.startsWith('diff --git ')) {
      finishFile();
      resetFile(parseGitDiffPath(rawLine) || '');
      continue;
    }

    if (!inHunk && rawLine.startsWith('+++ ')) {
      const newFile = parseUnifiedNewPath(rawLine);
      if (newFile && newFile !== currentFile) {
        finishFile();
        resetFile(newFile);
      }
      continue;
    }

    if (rawLine.startsWith('@@')) {
      inHunk = true;
      currentHunk++;
      lexerState = { inBlockComment: false, stringValue: '', nextToken: lexerState.nextToken };
      continue;
    }

    if (!inHunk || !isSourceCodeFile(currentFile) || isTestOrDocFile(currentFile)) {
      continue;
    }

    const added = rawLine.startsWith('+') && !rawLine.startsWith('+++');
    const context = rawLine.startsWith(' ');
    if (!added && !context) continue;

    const content = rawLine.slice(1);
    const code = scanDiffSourceLine(content, currentFile, lexerState, stringValues);
    records.push({ added, hunk: currentHunk, content, code });
  }

  finishFile();

  const isClean = violations.length === 0;
  const summary = isClean
    ? 'Anti-hardcode and generalization gate passed cleanly.'
    : `Anti-hardcode gate FAILED: detected ${violations.length} hardcoded shortcut(s) in production logic.`;

  return { isClean, violations, summary };
}
