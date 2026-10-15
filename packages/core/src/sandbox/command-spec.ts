export interface CommandSpec {
  executable: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Safely parse a raw command string into structured CommandSpec,
 * handling single and double quoted arguments, escaped spaces, and flags.
 */
export function parseCommandSpec(rawCommand: string, options: Partial<CommandSpec> = {}): CommandSpec {
  const trimmed = rawCommand.trim();
  if (!trimmed) {
    return {
      executable: '',
      args: [],
      ...options,
    };
  }

  const tokens: string[] = [];
  let currentToken = '';
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let isEscaped = false;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (isEscaped) {
      currentToken += char;
      isEscaped = false;
      continue;
    }

    if (char === '\\') {
      const nextChar = i + 1 < trimmed.length ? trimmed[i + 1] : undefined;

      // In single quotes, backslash is always literal
      if (inSingleQuote) {
        currentToken += char;
        continue;
      }

      // In double quotes, backslash only escapes quotes ("), backslashes (\), dollars ($), or backticks (`)
      if (inDoubleQuote) {
        if (nextChar === '"' || nextChar === '\\' || nextChar === '$' || nextChar === '`') {
          isEscaped = true;
          continue;
        }
        currentToken += char;
        continue;
      }

      // Outside quotes:
      // An escape is only intended if followed by a quote (", '), backslash (\), or whitespace (' ', '\t').
      // When followed by path characters or letters (e.g. C:\Users\repo\test.ts or \foo\bar),
      // the backslash is a path separator and must NOT be swallowed!
      if (
        nextChar === '"' ||
        nextChar === "'" ||
        nextChar === '\\' ||
        nextChar === ' ' ||
        nextChar === '\t'
      ) {
        isEscaped = true;
        continue;
      }

      currentToken += char;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if ((char === ' ' || char === '\t') && !inDoubleQuote && !inSingleQuote) {
      if (currentToken.length > 0) {
        tokens.push(currentToken);
        currentToken = '';
      }
      continue;
    }

    currentToken += char;
  }

  if (currentToken.length > 0) {
    tokens.push(currentToken);
  }

  const executable = tokens[0] || '';
  const args = tokens.slice(1);

  return {
    executable,
    args,
    env: options.env,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
  };
}

/**
 * Serialize a CommandSpec into a displayable command string.
 */
export function serializeCommandSpec(spec: CommandSpec): string {
  const quotedArgs = spec.args.map((arg) => {
    if (arg.includes(' ') || arg.includes('\t') || arg.includes('"')) {
      return `"${arg.replace(/"/g, '\\"')}"`;
    }
    return arg;
  });

  return `${spec.executable} ${quotedArgs.join(' ')}`.trim();
}
