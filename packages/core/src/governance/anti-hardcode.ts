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
  /** Base contents for modified files, used to seed lexical state at diff hunks. */
  baseFileContents?: ReadonlyMap<string, string>;
}

interface DiffPathToken {
  value: string;
  end: number;
}

interface DiffLexerState {
  inBlockComment: boolean;
  inHtmlComment?: boolean;
  stringDelimiter?: string;
  stringTokenId?: string;
  stringValue: string;
  stringAddedFlags: boolean[];
  stringSourceLines: string[];
  stringIsFString: boolean;
  stringIsCppRaw?: boolean;
  nextToken: number;
}

interface DiffLineRecord {
  added: boolean;
  hunk: number;
  content: string;
  code: string;
}

const SOURCE_FILE_EXTENSION =
  /\.(?:[cm]?[jt]sx?|vue|svelte|py|go|rs|java|kt|kts|swift|cs|c|h|cc|cpp|hpp|php|rb|sh|bash|zsh|ps1|scala|sc|dart|ex|exs|lua|sql|sol)$/i;

function isSourceCodeFile(filePath: string): boolean {
  const basename = filePath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() || '';
  if (/^(?:readme|contributing|changelog|changes|history|license|notice|authors|copying|install|code_of_conduct)(?:\.(?:md|mdx|rst|txt))?$/.test(basename)) {
    return false;
  }
  if (!filePath || !/\.[^/]+$/.test(filePath)) return true;
  return SOURCE_FILE_EXTENSION.test(filePath);
}

function isTestOrDocFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/').toLowerCase();
  return (
    /(?:^|\/)(?:tests?|__tests__|fixtures?|mocks?)(?:\/|$)/.test(norm) ||
    /\.(?:test|spec)\.[a-z0-9]+$/i.test(norm) ||
    /_test\.[a-z0-9]+$/i.test(norm) ||
    /(?:^|\/)test_[a-z0-9_]+\.[a-z0-9]+$/i.test(norm) ||
    /\.(?:md|mdx|rst|txt)$/i.test(norm)
  );
}

function isRustLifetimeToken(line: string, quoteIndex: number, filePath: string): boolean {
  if (!/\.rs$/i.test(filePath)) return false;
  const lifetime = line.slice(quoteIndex).match(/^'[A-Za-z_][A-Za-z0-9_]*/)?.[0];
  return Boolean(
    lifetime && line[quoteIndex + lifetime.length] !== "'",
  );
}

function isWebRoutePathReference(code: string, pathToken: string): boolean {
  const tokenIndex = code.indexOf(pathToken);
  if (tokenIndex < 0) return false;
  const prefix = code.slice(Math.max(0, tokenIndex - 120), tokenIndex);
  return (
    /<Route\b[^>]*\bpath\s*=\s*\{?\s*$/i.test(prefix) ||
    /\b(?:route|routePath|pathname|href|url)\s*[:=]\s*\{?\s*$/i.test(prefix) ||
    /\b(?:routes|router)\b[^;\n]*\bpath\s*:\s*\{?\s*$/i.test(prefix)
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

function parseHunkOldRange(header: string): { start: number; count: number } | undefined {
  const match = header.match(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/);
  if (!match) return undefined;
  return { start: Number(match[1]), count: match[2] === undefined ? 1 : Number(match[2]) };
}

function isHashCommentLanguage(filePath: string): boolean {
  return /\.(?:py|sh|bash|zsh|ps1|rb)$/i.test(filePath);
}

function isDashCommentLanguage(filePath: string): boolean {
  return /\.(?:lua|sql)$/i.test(filePath);
}

function extractTemplateExpressions(
  templateBody: string,
): Array<{ expression: string; start: number; end: number }> {
  const expressions: Array<{ expression: string; start: number; end: number }> = [];

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
    expressions.push({
      expression: templateBody.slice(expressionStart, expressionEnd),
      start: expressionStart,
      end: expressionEnd,
    });
    index = expressionEnd;
  }

  return expressions;
}

function extractPythonFStringExpressions(
  stringBody: string,
): Array<{ expression: string; start: number; end: number }> {
  const expressions: Array<{ expression: string; start: number; end: number }> = [];

  for (let index = 0; index < stringBody.length; index++) {
    if (stringBody[index] !== '{') continue;
    if (stringBody[index + 1] === '{') {
      index++;
      continue;
    }

    const expressionStart = index + 1;
    let braceDepth = 1;
    let quote: string | undefined;
    let inLineComment = false;
    let expressionEnd = -1;

    for (let cursor = expressionStart; cursor < stringBody.length; cursor++) {
      const current = stringBody[cursor];
      if (inLineComment) {
        if (current === '\n') inLineComment = false;
        continue;
      }
      if (quote) {
        if (current === '\\') {
          cursor++;
        } else if (stringBody.startsWith(quote, cursor)) {
          cursor += quote.length - 1;
          quote = undefined;
        }
        continue;
      }
      if (current === '#') {
        inLineComment = true;
        continue;
      }
      if (current === '"' || current === "'") {
        quote = stringBody.startsWith(current.repeat(3), cursor)
          ? current.repeat(3)
          : current;
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
    expressions.push({
      expression: stringBody.slice(expressionStart, expressionEnd),
      start: expressionStart,
      end: expressionEnd,
    });
    index = expressionEnd;
  }

  return expressions;
}

function isPythonFStringPrefix(line: string, quoteIndex: number): boolean {
  const prefix = line
    .slice(0, quoteIndex)
    .match(/(?:^|[^a-zA-Z0-9_])(f|fr|rf)$/i)?.[1];
  return prefix !== undefined;
}

function stringPrefixBeforeQuote(line: string, quoteIndex: number, filePath: string): string {
  const preceding = line.slice(0, quoteIndex);
  let match: RegExpMatchArray | null = null;
  if (/\.py$/i.test(filePath)) {
    match = preceding.match(/(?:^|[^a-zA-Z0-9_])(br|rb|fr|rf|r|u|b|f)$/i);
  } else if (/\.rs$/i.test(filePath)) {
    match = preceding.match(/(?:^|[^a-zA-Z0-9_])((?:br|r)#+|br|r|b|c)$/);
  } else if (/\.(?:c|h|cc|cpp|hpp)$/i.test(filePath)) {
    match = preceding.match(/(?:^|[^a-zA-Z0-9_])(u8|u|U|L)$/);
  }
  return match?.[1] || '';
}

function cppRawStringBeforeQuote(
  line: string,
  quoteIndex: number,
  filePath: string,
): { prefix: string; contentStart: number; closingDelimiter: string } | undefined {
  if (!/\.(?:c|h|cc|cpp|hpp)$/i.test(filePath)) return undefined;
  const match = line
    .slice(0, quoteIndex)
    .match(/(?:^|[^a-zA-Z0-9_])((?:u8|u|U|L)?R)$/);
  if (!match) return undefined;

  const delimiterStart = quoteIndex + 1;
  const openParen = line.indexOf('(', delimiterStart);
  if (openParen < 0 || openParen - delimiterStart > 16) return undefined;
  const delimiter = line.slice(delimiterStart, openParen);
  if (/[\s()\\]/.test(delimiter)) return undefined;

  return {
    prefix: match[1],
    contentStart: openParen + 1,
    closingDelimiter: `)${delimiter}"`,
  };
}

function scanDiffSourceLine(
  line: string,
  filePath: string,
  state: DiffLexerState,
  stringValues: Map<string, string>,
  lineAdded: boolean,
  sourceLine: string,
  embeddedRecords: DiffLineRecord[],
  hunk: number,
): string {
  let index = 0;
  let code = '';
  const hashComments = isHashCommentLanguage(filePath);
  const dashComments = isDashCommentLanguage(filePath);
  const supportsTripleQuotes = /\.(?:py|kt|kts)$/i.test(filePath);
  const supportsTemplateInterpolation =
    /\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(filePath);

  const appendStringContent = (value: string) => {
    state.stringValue += value;
    if (
      (state.stringDelimiter === '`' && supportsTemplateInterpolation) ||
      state.stringIsFString
    ) {
      for (let offset = 0; offset < value.length; offset++) {
        state.stringAddedFlags.push(lineAdded);
        state.stringSourceLines.push(sourceLine);
      }
    }
  };

  while (index < line.length) {
    if (state.inBlockComment) {
      const end = line.indexOf('*/', index);
      if (end < 0) break;
      state.inBlockComment = false;
      index = end + 2;
      continue;
    }

    if (state.stringDelimiter) {
      if (
        !state.stringIsCppRaw &&
        line[index] === '\\' &&
        index + 1 < line.length
      ) {
        appendStringContent(line.slice(index, index + 2));
        index += 2;
      } else if (line.startsWith(state.stringDelimiter, index)) {
        if (state.stringTokenId) {
          stringValues.set(`__STR_${state.stringTokenId}__`, state.stringValue);
          const expressions =
            state.stringDelimiter === '`' && supportsTemplateInterpolation
              ? extractTemplateExpressions(state.stringValue)
              : state.stringIsFString
                ? extractPythonFStringExpressions(state.stringValue)
                : [];
          for (const expression of expressions) {
              const addedOffset = state.stringAddedFlags
                .slice(expression.start, expression.end)
                .findIndex(Boolean);
              if (addedOffset < 0) continue;
              const sourceIndex = expression.start + addedOffset;
              const expressionSourceLine =
                state.stringSourceLines[sourceIndex] || sourceLine;
              const expressionState: DiffLexerState = {
                inBlockComment: false,
                stringValue: '',
                stringAddedFlags: [],
                stringSourceLines: [],
                stringIsFString: false,
                nextToken: state.nextToken,
              };
              const expressionCode = scanDiffSourceLine(
                expression.expression,
                filePath,
                expressionState,
                stringValues,
                true,
                expressionSourceLine,
                embeddedRecords,
                hunk,
              );
              embeddedRecords.push({
                added: true,
                hunk,
                content: expressionSourceLine,
                code: expressionCode,
              });
              state.nextToken = expressionState.nextToken;
          }
        }
        index += state.stringDelimiter.length;
        state.stringDelimiter = undefined;
        state.stringTokenId = undefined;
        state.stringValue = '';
        state.stringAddedFlags = [];
        state.stringSourceLines = [];
        state.stringIsFString = false;
        state.stringIsCppRaw = false;
      } else {
        appendStringContent(line[index]);
        index++;
      }
      continue;
    }

    if (state.inHtmlComment) {
      const end = line.indexOf('-->', index);
      if (end < 0) break;
      state.inHtmlComment = false;
      index = end + 3;
      continue;
    }
    if (/\.(?:vue|svelte)$/i.test(filePath) && line.startsWith('<!--', index)) {
      state.inHtmlComment = true;
      index += 4;
      continue;
    }

    if (line.startsWith('/*', index)) {
      state.inBlockComment = true;
      index += 2;
      continue;
    }
    if (!hashComments && line.startsWith('//', index)) break;
    if (hashComments && line[index] === '#') break;
    if (dashComments && line.startsWith('--', index)) break;

    const quote = line[index];
    if (quote === "'" && isRustLifetimeToken(line, index, filePath)) {
      code += quote;
      index++;
      continue;
    }
    if (quote === '"' || quote === "'" || quote === '`') {
      const cppRawString = cppRawStringBeforeQuote(line, index, filePath);
      if (cppRawString) {
        code = code.slice(0, -cppRawString.prefix.length);
        const tokenId = String(state.nextToken++);
        state.stringDelimiter = cppRawString.closingDelimiter;
        state.stringTokenId = tokenId;
        state.stringValue = '';
        state.stringAddedFlags = [];
        state.stringSourceLines = [];
        state.stringIsFString = false;
        state.stringIsCppRaw = true;
        stringValues.set(`__STR_${tokenId}__`, '');
        code += `__STR_${tokenId}__`;
        index = cppRawString.contentStart;
        continue;
      }

      const stringPrefix = stringPrefixBeforeQuote(line, index, filePath);
      if (stringPrefix) code = code.slice(0, -stringPrefix.length);
      const delimiter =
        supportsTripleQuotes && line.startsWith(quote.repeat(3), index)
          ? quote.repeat(3)
          : quote;
      const tokenId = String(state.nextToken++);
      state.stringDelimiter = delimiter;
      state.stringTokenId = tokenId;
      state.stringValue = '';
      state.stringAddedFlags = [];
      state.stringSourceLines = [];
      state.stringIsFString = supportsTripleQuotes && isPythonFStringPrefix(line, index);
      state.stringIsCppRaw = false;
      stringValues.set(`__STR_${tokenId}__`, '');
      code += `__STR_${tokenId}__`;
      index += delimiter.length;
      continue;
    }

    code += line[index];
    index++;
  }

  if (
    state.stringDelimiter === '`' ||
    (state.stringIsFString && state.stringDelimiter?.length === 3)
  ) {
    appendStringContent('\n');
  }
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

function buildHunkSource(records: DiffLineRecord[]): {
  code: string;
  hasAddedCode(start: number, end: number): boolean;
  firstAddedRecord(start: number, end: number): DiffLineRecord | undefined;
} {
  const spans: Array<{ start: number; end: number; record: DiffLineRecord }> = [];
  let code = '';
  for (const record of records) {
    const start = code.length;
    code += `${record.code}\n`;
    spans.push({ start, end: code.length - 1, record });
  }
  const matchingSpans = (start: number, end: number) =>
    spans.filter((span) => span.end >= start && span.start <= end);
  return {
    code,
    hasAddedCode: (start, end) => matchingSpans(start, end).some((span) => span.record.added),
    firstAddedRecord: (start, end) =>
      matchingSpans(start, end).find((span) => span.record.added)?.record,
  };
}

function branchReturnIndex(source: string, conditionEnd: number): number | undefined {
  const tail = source.slice(conditionEnd);
  const firstToken = tail.match(/^\s*(\{|:)?/);
  const opener = firstToken?.[1];
  const afterOpener = tail.slice(firstToken?.[0].length || 0);
  const afterOpenerStart = conditionEnd + (firstToken?.[0].length || 0);

  if (opener === '{') {
    let depth = 1;
    const tokenPattern = /[{}]|\breturn\b/g;
    for (const token of afterOpener.matchAll(tokenPattern)) {
      if (token[0] === '{') depth++;
      else if (token[0] === '}' && --depth === 0) return undefined;
      else if (token[0] === 'return') return afterOpenerStart + (token.index ?? 0);
    }
    return undefined;
  }

  if (opener === ':') {
    const conditionStart = source.lastIndexOf('\n', conditionEnd) + 1;
    const conditionIndent = source.slice(conditionStart, conditionEnd).match(/^\s*/)?.[0].length || 0;
    let lineOffset = 0;
    for (const line of afterOpener.split('\n')) {
      if (!line.trim()) {
        lineOffset += line.length + 1;
        continue;
      }
      const indent = line.match(/^\s*/)?.[0].length || 0;
      if (indent <= conditionIndent) return undefined;
      const returnMatch = line.match(/\breturn\b/);
      if (returnMatch) return afterOpenerStart + lineOffset + returnMatch.index!;
      lineOffset += line.length + 1;
    }
    return undefined;
  }

  const returnMatch = afterOpener.match(/^\s*\breturn\b/);
  return returnMatch
    ? afterOpenerStart + returnMatch[0].search(/\breturn\b/)
    : undefined;
}

function analyzeFileChanges(
  filePath: string,
  records: DiffLineRecord[],
  stringValues: Map<string, string>,
  options: AntiHardcodeOptions,
  violations: AntiHardcodeViolation[],
): void {
  if (!isSourceCodeFile(filePath) || isTestOrDocFile(filePath)) return;

  const repoVariable =
    String.raw`\b(?:target)?(?:repo|repository|origin|upstream)(?:Name|FullName)?\b`;
  const stringToken = String.raw`__STR_\d+__`;
  const repoReference = new RegExp(
    `(?:${repoVariable}\\s*(?:=+|!==?)\\s*(${stringToken})|(${stringToken})\\s*(?:===|==)\\s*${repoVariable}|${repoVariable}\\s*\\.includes\\s*\\(\\s*(${stringToken}))`,
    'gi',
  );
  const issueVariable =
    String.raw`\b(?:issue(?:Number|Id)?|prNumber|ticket|bugId)(?:\s*(?:\?\.|\.)\s*(?:number|id))?\b`;
  const issueNumberPattern = options.issueNumber
    ? new RegExp(
        `(?:${issueVariable}\\s*(?:===|==)\\s*${options.issueNumber}\\b|\\b${options.issueNumber}\\s*(?:===|==)\\s*${issueVariable})`,
        'gi',
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

    for (const pathToken of new Set(code.match(/__STR_\d+__/g) || [])) {
      const value = stringValues.get(pathToken)?.replace(/\\\\/g, '\\').trim();
      if (
        value &&
        absolutePathPatterns.some((pattern) => pattern.test(value)) &&
        !isWebRoutePathReference(record.code, pathToken)
      ) {
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
    const source = buildHunkSource(hunkRecords);
    for (const match of source.code.matchAll(repoReference)) {
      const tokenId = match[1] || match[2] || match[3];
      const sampleValue = stringValues.get(tokenId);
      const matchedRecord = source.firstAddedRecord(match.index, match.index + match[0].length);
      if (!matchedRecord) continue;
      if (sampleValue && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(sampleValue)) {
        const isTarget = options.targetRepo && sampleValue.toLowerCase() === options.targetRepo.toLowerCase();
        addViolation(
          violations,
          filePath,
          matchedRecord.content.trim(),
          'REPO_LITERAL_DISCRIMINATION',
          isTarget
            ? `Production logic hardcodes target repository name '${options.targetRepo}'. Solutions must be generalized and decoupled from repository-specific string literals.`
            : 'Detected repository-name literal comparison in production code. Use capability/manifest feature detection rather than repo-name discrimination.',
        );
      }
    }

    if (issueNumberPattern) {
      for (const match of source.code.matchAll(issueNumberPattern)) {
        const matchedRecord = source.firstAddedRecord(match.index, match.index + match[0].length);
        if (!matchedRecord) continue;
        addViolation(
          violations,
          filePath,
          matchedRecord.content.trim(),
          'ISSUE_NUMBER_HARDCODING',
          `Production logic explicitly branches on issue #${options.issueNumber}. A fix must resolve the underlying logic defect universally rather than special-casing the bug identifier.`,
        );
      }
    }

    const comparisonVariable =
      `(?:${issueVariable}|[a-zA-Z_$][\\w$]*(?:(?:\\?\\.|\\.)[a-zA-Z_$][\\w$]*)*)`;
    const sampleComparison = new RegExp(
      `\\b(?:if|elif)\\s*(?:\\(\\s*)?(?:(${comparisonVariable})\\s*(?:===|==)\\s*(${stringToken})|(${stringToken})\\s*(?:===|==)\\s*(${comparisonVariable}))\\s*\\)?`,
      'gi',
    );
    for (const match of source.code.matchAll(sampleComparison)) {
      const conditionEnd = (match.index ?? 0) + match[0].length;
      const returnIndex = branchReturnIndex(source.code, conditionEnd);
      if (
        returnIndex === undefined ||
        (!source.hasAddedCode(match.index ?? 0, conditionEnd) &&
          !source.hasAddedCode(returnIndex, returnIndex + 'return'.length))
      ) {
        continue;
      }
      const sampleValue = stringValues.get(match[2] || match[3]);
      const condition =
        source.firstAddedRecord(match.index ?? 0, conditionEnd) ||
        source.firstAddedRecord(returnIndex, returnIndex + 'return'.length);
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
  let baseLines: string[] | undefined;
  let baseLineCursor = 0;
  let lexerState: DiffLexerState = {
    inBlockComment: false,
    stringValue: '',
    stringAddedFlags: [],
    stringSourceLines: [],
    stringIsFString: false,
    nextToken: 1,
  };

  const resetLexerState = () => {
    const nextToken = lexerState.nextToken;
    lexerState = {
      inBlockComment: false,
      stringValue: '',
      stringAddedFlags: [],
      stringSourceLines: [],
      stringIsFString: false,
      nextToken,
    };
  };

  const finishFile = () => {
    analyzeFileChanges(currentFile, records, stringValues, options, violations);
  };
  const resetFile = (filePath: string) => {
    currentFile = filePath;
    records = [];
    stringValues = new Map<string, string>();
    const normalizedPath = filePath.replace(/\\/g, '/');
    const baseContents = options.baseFileContents?.get(normalizedPath);
    baseLines = baseContents === undefined ? undefined : baseContents.split(/\r?\n/);
    baseLineCursor = 0;
    lexerState = {
      inBlockComment: false,
      stringValue: '',
      stringAddedFlags: [],
      stringSourceLines: [],
      stringIsFString: false,
      nextToken: 1,
    };
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
      const range = parseHunkOldRange(rawLine);
      if (!range || !baseLines) {
        if (isSourceCodeFile(currentFile) && !isTestOrDocFile(currentFile)) {
          resetLexerState();
        }
      }
      if (range && baseLines && isSourceCodeFile(currentFile) && !isTestOrDocFile(currentFile)) {
        const unchangedUntil = Math.max(baseLineCursor, range.start - 1);
        for (let lineIndex = baseLineCursor; lineIndex < unchangedUntil; lineIndex++) {
          const content = baseLines[lineIndex];
          if (content === undefined) {
            resetLexerState();
            break;
          }
          scanDiffSourceLine(
            content,
            currentFile,
            lexerState,
            stringValues,
            false,
            content,
            records,
            currentHunk,
          );
        }
        baseLineCursor = Math.max(baseLineCursor, range.start - 1 + range.count);
      }
      inHunk = true;
      currentHunk++;
      continue;
    }

    if (!inHunk || !isSourceCodeFile(currentFile) || isTestOrDocFile(currentFile)) {
      continue;
    }

    const added = rawLine.startsWith('+');
    const context = rawLine.startsWith(' ');
    if (!added && !context) continue;

    const content = rawLine.slice(1);
    const code = scanDiffSourceLine(
      content,
      currentFile,
      lexerState,
      stringValues,
      added,
      content,
      records,
      currentHunk,
    );
    records.push({ added, hunk: currentHunk, content, code });
  }

  finishFile();

  const isClean = violations.length === 0;
  const summary = isClean
    ? 'Anti-hardcode and generalization gate passed cleanly.'
    : `Anti-hardcode gate FAILED: detected ${violations.length} hardcoded shortcut(s) in production logic.`;

  return { isClean, violations, summary };
}
