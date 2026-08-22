export interface ASTGrepSubRule {
  pattern?: string;
  kind?: string;
  stopBy?: string;
  has?: ASTGrepSubRule;
  inside?: ASTGrepSubRule;
  not?: ASTGrepSubRule;
  any?: ASTGrepSubRule[];
  all?: ASTGrepSubRule[];
}

export interface ASTGrepYamlRule {
  id: string;
  language: 'typescript' | 'javascript' | 'go' | 'rust' | 'python' | 'java' | 'c' | 'csharp' | 'php';
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  rule: ASTGrepSubRule;
  fix?: string;
  metadata?: {
    cwe?: string;
    category?: string;
    impact?: string;
  };
}

function serializeSubRule(rule: ASTGrepSubRule, indent = 0): string {
  const pad = '  '.repeat(indent);
  const lines: string[] = [];

  if (rule.kind) lines.push(`${pad}kind: ${rule.kind}`);
  if (rule.stopBy) lines.push(`${pad}stopBy: ${rule.stopBy}`);
  if (rule.pattern) lines.push(`${pad}pattern: "${rule.pattern.replace(/"/g, '\\"')}"`);

  if (rule.has) {
    lines.push(`${pad}has:`);
    lines.push(...serializeSubRule(rule.has, indent + 1).split('\n').filter(Boolean));
  }
  if (rule.inside) {
    lines.push(`${pad}inside:`);
    lines.push(...serializeSubRule(rule.inside, indent + 1).split('\n').filter(Boolean));
  }
  if (rule.not) {
    lines.push(`${pad}not:`);
    lines.push(...serializeSubRule(rule.not, indent + 1).split('\n').filter(Boolean));
  }
  if (rule.any && rule.any.length > 0) {
    lines.push(`${pad}any:`);
    for (const r of rule.any) {
      lines.push(...serializeSubRule(r, indent + 1).split('\n').filter(Boolean));
    }
  }
  if (rule.all && rule.all.length > 0) {
    lines.push(`${pad}all:`);
    for (const r of rule.all) {
      lines.push(...serializeSubRule(r, indent + 1).split('\n').filter(Boolean));
    }
  }

  return lines.join('\n');
}

/**
 * Standard Production-Grade Deep AST Relational Rules
 * Uses ast-grep's relational AST operators (inside, has, not) and atomic AST fix templates.
 */
export const STANDARD_AST_RELATIONAL_RULES: ASTGrepYamlRule[] = [
  {
    id: 'go-unclosed-http-body',
    language: 'go',
    severity: 'error',
    message: 'HTTP response body must be closed with defer resp.Body.Close() after error check',
    rule: {
      pattern: '$RESP, $ERR := http.Get($URL)',
    },
    fix: '$RESP, $ERR := http.Get($URL)\nif $ERR != nil {\n\treturn $ERR\n}\ndefer $RESP.Body.Close()',
    metadata: {
      cwe: 'CWE-400',
      category: 'lifecycle_leak',
      impact: 'Socket descriptor and memory buffer exhaustion under heavy load',
    },
  },
  {
    id: 'go-mutex-unlock-leak',
    language: 'go',
    severity: 'error',
    message: 'Mutex.Lock() called without guaranteed defer Mutex.Unlock() in function scope',
    rule: {
      pattern: '$MU.Lock()',
    },
    fix: '$MU.Lock()\ndefer $MU.Unlock()',
    metadata: {
      cwe: 'CWE-667',
      category: 'concurrency_race',
      impact: 'Permanent deadlock if function panics or returns via early error branch',
    },
  },
  {
    id: 'go-redis-zrange-order-trap',
    language: 'go',
    severity: 'warning',
    message: 'ZRangeByScore returns ascending elements. For Before-time pagination, use ZRevRangeByScore / Rev: true to preserve descending order.',
    rule: {
      pattern: '$CLIENT.ZRangeByScore($CTX, $KEY, $OPT)',
    },
    fix: '$CLIENT.ZRevRangeByScore($CTX, $KEY, $OPT)',
    metadata: {
      cwe: 'CWE-682',
      category: 'protocol_drift',
      impact: 'Pagination state order inverted breaking chronological cursor continuation',
    },
  },
  {
    id: 'go-mutex-defer-in-loop',
    language: 'go',
    severity: 'error',
    message: 'defer Mutex.Unlock() inside loop body holds lock until enclosing function returns',
    rule: {
      pattern: 'defer $MU.Unlock()',
      inside: {
        pattern: 'for $COND { $$$ }',
      },
    },
    metadata: {
      cwe: 'CWE-667',
      category: 'concurrency_race',
      impact: 'Delayed mutex release causes severe lock contention or deadlock',
    },
  },
  {
    id: 'go-goroutine-leak-unbuffered-channel',
    language: 'go',
    severity: 'error',
    message: 'Goroutine sending to unbuffered channel without context cancellation causes permanent goroutine leak',
    rule: {
      pattern: 'go func() { $CH <- $VAL }()',
    },
    metadata: {
      cwe: 'CWE-400',
      category: 'lifecycle_leak',
      impact: 'Runaway goroutines accumulate on blocked channel writes',
    },
  },
  {
    id: 'go-typed-nil-error-trap',
    language: 'go',
    severity: 'error',
    message: 'Returning a typed nil pointer as error interface evaluates to non-nil (err != nil is true)',
    rule: {
      kind: 'simple_stmt',
      pattern: 'var $ERR *$TYPE = nil',
    },
    fix: 'return nil',
    metadata: {
      cwe: 'CWE-252',
      category: 'protocol_drift',
      impact: 'Callers receive non-nil error interface holding nil concrete pointer',
    },
  },
  {
    id: 'ts-float-direct-equality',
    language: 'typescript',
    severity: 'warning',
    message: 'Direct equality comparison on floating point calculations causes precision drift',
    rule: {
      pattern: 'parseFloat($A) === $B',
    },
    fix: 'Math.abs(parseFloat($A) - $B) < Number.EPSILON',
    metadata: {
      cwe: 'CWE-682',
      category: 'numerical_bounds',
      impact: 'Subtle boundary condition failures in decimal and timeout calculations',
    },
  },
  {
    id: 'ts-unhandled-promise-catch',
    language: 'typescript',
    severity: 'warning',
    message: 'Promise invocation missing .catch() rejection handler',
    rule: {
      pattern: '$PROMISE.then($FN)',
    },
    fix: '$PROMISE.then($FN).catch(err => { console.error("Unhandled rejection:", err); })',
    metadata: {
      cwe: 'CWE-391',
      category: 'protocol_drift',
      impact: 'Unhandled promise rejection in asynchronous event loop',
    },
  },
  {
    id: 'ts-empty-catch-swallow',
    language: 'typescript',
    severity: 'warning',
    message: 'Empty catch block completely swallows exceptions and masks fatal runtime defects',
    rule: {
      kind: 'catch_clause',
      pattern: 'catch ($ERR) {}',
    },
    fix: 'catch ($ERR) { console.warn("Caught error:", $ERR); }',
    metadata: {
      cwe: 'CWE-391',
      category: 'protocol_drift',
      impact: 'Silent failures leaving system in corrupted or non-recoverable state',
    },
  },
  {
    id: 'py-unclosed-file-handle',
    language: 'python',
    severity: 'warning',
    message: 'File opened with open() without using with context manager causes file descriptor leaks',
    rule: {
      pattern: '$F = open($PATH, $MODE)',
    },
    metadata: {
      cwe: 'CWE-400',
      category: 'lifecycle_leak',
      impact: 'OS file descriptor exhaustion on long-running worker processes',
    },
  },
  {
    id: 'py-mutable-default-argument',
    language: 'python',
    severity: 'error',
    message: 'Mutable default argument (list/dict) retains mutated state across repeated calls',
    rule: {
      pattern: 'def $FUNC($ARG=[]): $$$',
    },
    metadata: {
      cwe: 'CWE-665',
      category: 'protocol_drift',
      impact: 'Shared state accumulation across requests leading to data pollution',
    },
  },
  {
    id: 'py-bare-except',
    language: 'python',
    severity: 'error',
    message: 'Bare except: catches SystemExit and KeyboardInterrupt, preventing graceful shutdown',
    rule: {
      pattern: 'except:',
    },
    fix: 'except Exception:',
    metadata: {
      cwe: 'CWE-391',
      category: 'protocol_drift',
      impact: 'Process cannot be terminated or handled gracefully by orchestrator',
    },
  },
  {
    id: 'rs-unchecked-unwrap',
    language: 'rust',
    severity: 'warning',
    message: 'Calling .unwrap() on Result/Option can trigger sudden panic in production',
    rule: {
      pattern: '$EXPR.unwrap()',
    },
    fix: '$EXPR.unwrap_or_default()',
    metadata: {
      cwe: 'CWE-754',
      category: 'protocol_drift',
      impact: 'Unrecoverable thread panic bringing down entire service instance',
    },
  },
  {
    id: 'go-unclosed-sql-rows',
    language: 'go',
    severity: 'error',
    message: 'Database query rows must be closed with defer rows.Close() to return connection to pool',
    rule: {
      pattern: '$ROWS, $ERR := $DB.Query($QUERY)',
    },
    metadata: {
      cwe: 'CWE-400',
      category: 'lifecycle_leak',
      impact: 'Database connection pool starvation blocking all subsequent queries',
    },
  },
  {
    id: 'go-time-after-in-select-loop',
    language: 'go',
    severity: 'error',
    message: 'time.After inside for-select loop allocates a new timer per iteration until duration fires',
    rule: {
      kind: 'case_statement',
      pattern: 'case <-time.After($D):',
    },
    metadata: {
      cwe: 'CWE-400',
      category: 'lifecycle_leak',
      impact: 'Rapid heap memory accumulation and GC pressure under high event rates',
    },
  },
  {
    id: 'ts-ssrf-bracketed-ipv6-bypass',
    language: 'typescript',
    severity: 'error',
    message: 'WHATWG URL parser preserves brackets on IPv6 hostnames. Regex testing against hostname without stripping brackets allows SSRF bypass.',
    rule: {
      pattern: '$RE.test($HOST)',
      inside: {
        pattern: 'function $FN($$$) { $$$ }',
      },
    },
    metadata: {
      cwe: 'CWE-918',
      category: 'security_sandbox',
      impact: 'SSRF filter bypass allowing requests to internal loopback or metadata endpoints via [::1] or [fe80::1]',
    },
  },
  {
    id: 'go-ssrf-url-hostname-bracket',
    language: 'go',
    severity: 'error',
    message: 'URL Hostname with IPv6 retains brackets; net.ParseIP or regex matching without strings.Trim(host, "[]") allows SSRF filter bypass.',
    rule: {
      pattern: 'net.ParseIP($U.Host)',
    },
    metadata: {
      cwe: 'CWE-918',
      category: 'security_sandbox',
      impact: 'SSRF bypass to internal loopback or cloud metadata services via bracketed IPv6 addresses',
    },
  },
  {
    id: 'py-ssrf-bracketed-ipv6-bypass',
    language: 'python',
    severity: 'error',
    message: 'urllib.parse.urlparse hostname for IPv6 includes square brackets; ipaddress.ip_address() or regex requires stripping brackets.',
    rule: {
      pattern: 'ipaddress.ip_address($PARSED.hostname)',
    },
  },
  {
    id: 'java-unclosed-stream',
    language: 'java',
    severity: 'error',
    message: 'InputStream or AutoCloseable opened without try-with-resources or explicit close in finally block',
    rule: {
      pattern: 'InputStream $IN = new FileInputStream($PATH);',
    },
    metadata: {
      cwe: 'CWE-775',
      category: 'lifecycle_leak',
      impact: 'Operating system file descriptor leak under heavy concurrent I/O',
    },
  },
  {
    id: 'cpp-sprintf-overflow',
    language: 'c',
    severity: 'error',
    message: 'Unbounded sprintf() allows buffer overflow. Use snprintf($BUF, sizeof($BUF), ...) instead.',
    rule: {
      pattern: 'sprintf($BUF, $FMT, $$$ARGS)',
    },
    fix: 'snprintf($BUF, sizeof($BUF), $FMT, $$$ARGS)',
    metadata: {
      cwe: 'CWE-120',
      category: 'security_cwe',
      impact: 'Stack buffer overflow leading to memory corruption or remote code execution',
    },
  },
  {
    id: 'csharp-async-void',
    language: 'csharp',
    severity: 'warning',
    message: 'async void methods cannot be awaited and unhandled exceptions crash the process. Use async Task instead.',
    rule: {
      pattern: 'async void $METHOD($$$ARGS)',
    },
    fix: 'async Task $METHOD($$$ARGS)',
    metadata: {
      cwe: 'CWE-703',
      category: 'protocol_drift',
      impact: 'Unhandled asynchronous exceptions escaping caller context leading to fatal process abort',
    },
  },
  {
    id: 'php-loose-hash-compare',
    language: 'php',
    severity: 'warning',
    message: 'Loose equality (==) on hash digests is vulnerable to type juggling / magic hash collisions. Use hash_equals().',
    rule: {
      pattern: '$HASH == $INPUT',
    },
    metadata: {
      cwe: 'CWE-208',
      category: 'security_cwe',
      impact: 'Authentication bypass via PHP type juggling on 0e... hash digests',
    },
  },
];

export function serializeRuleToYaml(rule: ASTGrepYamlRule): string {
  const escapedMessage = rule.message.replace(/"/g, '\\"').replace(/\n/g, '\\n');
  const fixLine = rule.fix
    ? `fix: "${rule.fix.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
    : '';
  return `id: ${rule.id}
language: ${rule.language}
severity: ${rule.severity}
message: "${escapedMessage}"
rule:
${serializeSubRule(rule.rule, 1)}
${fixLine}
`;
}
