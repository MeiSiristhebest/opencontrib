export interface ASTGrepYamlRule {
  id: string;
  language: 'typescript' | 'javascript' | 'go' | 'rust' | 'python';
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  rule: {
    pattern: string;
    inside?: {
      pattern?: string;
      kind?: string;
      stopBy?: string;
    };
    has?: {
      pattern?: string;
      kind?: string;
    };
    not?: {
      pattern?: string;
      inside?: { pattern?: string };
      has?: { pattern?: string };
    };
  };
  fix?: string;
  metadata?: {
    cwe?: string;
    category?: string;
    impact?: string;
  };
}

/**
 * Standard Production-Grade Deep AST Relational Rules
 * Uses ast-grep's relational AST operators (inside, has, not) and atomic AST fix templates.
 */
export const STANDARD_AST_RELATIONAL_RULES: ASTGrepYamlRule[] = [
  // 1. Go: HTTP Response Body Leak without defer Close
  {
    id: 'go-unclosed-http-body',
    language: 'go',
    severity: 'error',
    message: 'HTTP response body must be closed with defer resp.Body.Close() after error check',
    rule: {
      pattern: '$RESP, $ERR := http.Get($URL)',
      not: {
        inside: {
          pattern: 'defer $RESP.Body.Close()',
        },
      },
    },
    fix: '$RESP, $ERR := http.Get($URL)\nif $ERR != nil {\n\treturn $ERR\n}\ndefer $RESP.Body.Close()',
    metadata: {
      cwe: 'CWE-400',
      category: 'lifecycle_leak',
      impact: 'Socket descriptor and memory buffer exhaustion under heavy load',
    },
  },
  // 2. Go: Mutex Lock without defer Unlock
  {
    id: 'go-mutex-unlock-leak',
    language: 'go',
    severity: 'error',
    message: 'Mutex.Lock() called without guaranteed defer Mutex.Unlock() in function scope',
    rule: {
      pattern: '$MU.Lock()',
      not: {
        inside: {
          pattern: 'defer $MU.Unlock()',
        },
      },
    },
    fix: '$MU.Lock()\ndefer $MU.Unlock()',
    metadata: {
      cwe: 'CWE-667',
      category: 'concurrency_race',
      impact: 'Permanent deadlock if function panics or returns via early error branch',
    },
  },
  // 3. Go: Redis ZRange Ascending Order Pagination Trap
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
  // 4. Go: Mutex defer Unlock in loop body
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
  // 5. Go: Goroutine channel leak without context check
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
  // 6. Go: Typed Nil Interface Trap
  {
    id: 'go-typed-nil-error-trap',
    language: 'go',
    severity: 'error',
    message: 'Returning a typed nil pointer as error interface evaluates to non-nil (err != nil is true)',
    rule: {
      pattern: 'var $ERR *$TYPE = nil; return $ERR',
    },
    fix: 'return nil',
    metadata: {
      cwe: 'CWE-252',
      category: 'protocol_drift',
      impact: 'Callers receive non-nil error interface holding nil concrete pointer',
    },
  },
  // 7. TypeScript: Floating Point Direct Equality Comparison
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
  // 8. TypeScript: Promise without catch or error handling
  {
    id: 'ts-unhandled-promise-catch',
    language: 'typescript',
    severity: 'warning',
    message: 'Promise invocation missing .catch() rejection handler',
    rule: {
      pattern: '$PROMISE.then($FN)',
      not: {
        inside: {
          pattern: '$ANY.catch($HANDLER)',
        },
      },
    },
    fix: '$PROMISE.then($FN).catch(err => { console.error("Unhandled rejection:", err); })',
    metadata: {
      cwe: 'CWE-391',
      category: 'protocol_drift',
      impact: 'Unhandled promise rejection in asynchronous event loop',
    },
  },
  // 9. TypeScript: Silent Error Swallowing in Catch Block
  {
    id: 'ts-empty-catch-swallow',
    language: 'typescript',
    severity: 'warning',
    message: 'Empty catch block completely swallows exceptions and masks fatal runtime defects',
    rule: {
      pattern: 'catch ($ERR) {}',
    },
    fix: 'catch ($ERR) { console.warn("Caught error:", $ERR); }',
    metadata: {
      cwe: 'CWE-391',
      category: 'protocol_drift',
      impact: 'Silent failures leaving system in corrupted or non-recoverable state',
    },
  },
  // 10. Python: Unclosed File Handle without Context Manager
  {
    id: 'py-unclosed-file-handle',
    language: 'python',
    severity: 'warning',
    message: 'File opened with open() without using with context manager causes file descriptor leaks',
    rule: {
      pattern: '$F = open($PATH, $MODE)',
      not: {
        inside: {
          pattern: 'with open($$$) as $$$:',
        },
      },
    },
    metadata: {
      cwe: 'CWE-400',
      category: 'lifecycle_leak',
      impact: 'OS file descriptor exhaustion on long-running worker processes',
    },
  },
  // 11. Python: Mutable Default Argument
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
  // 12. Python: Bare Except Block
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
  // 13. Rust: Unchecked unwrap() on Fallible Results
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
  // 14. Go: SQL Rows Leak without Close
  {
    id: 'go-unclosed-sql-rows',
    language: 'go',
    severity: 'error',
    message: 'Database query rows must be closed with defer rows.Close() to return connection to pool',
    rule: {
      pattern: '$ROWS, $ERR := $DB.Query($QUERY)',
      not: {
        inside: {
          pattern: 'defer $ROWS.Close()',
        },
      },
    },
    metadata: {
      cwe: 'CWE-400',
      category: 'lifecycle_leak',
      impact: 'Database connection pool starvation blocking all subsequent queries',
    },
  },
  // 15. Go: time.After Memory Leak inside Select Loop
  {
    id: 'go-time-after-in-select-loop',
    language: 'go',
    severity: 'error',
    message: 'time.After inside for-select loop allocates a new timer per iteration until duration fires',
    rule: {
      pattern: 'case <-time.After($D):',
      inside: {
        pattern: 'for { select { $$$ } }',
      },
    },
    metadata: {
      cwe: 'CWE-400',
      category: 'lifecycle_leak',
      impact: 'Rapid heap memory accumulation and GC pressure under high event rates',
    },
  },
  // 16. TypeScript/JavaScript: SSRF IP Regex bypass on Bracketed IPv6 Hostnames
  {
    id: 'ts-ssrf-bracketed-ipv6-bypass',
    language: 'typescript',
    severity: 'error',
    message: 'WHATWG URL parser preserves brackets on IPv6 hostnames (e.g. "[::1]"). Regex testing against hostname without stripping brackets allows SSRF bypass.',
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
  // 17. Go: SSRF Validation Bypass on Bracketed IPv6 URL Host
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
  // 18. Python: SSRF Regex Bypass on URL Netloc Bracketed IPv6
  {
    id: 'py-ssrf-bracketed-ipv6-bypass',
    language: 'python',
    severity: 'error',
    message: 'urllib.parse.urlparse hostname for IPv6 includes square brackets; ipaddress.ip_address() or regex requires stripping brackets.',
    rule: {
      pattern: 'ipaddress.ip_address($PARSED.hostname)',
    },
  },
  // 19. Java: Unclosed InputStream / AutoCloseable in raw try block without try-with-resources
  {
    id: 'java-unclosed-stream',
    language: 'java' as any,
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
  // 20. C/C++: Dangerous sprintf without buffer boundary check
  {
    id: 'cpp-sprintf-overflow',
    language: 'c' as any,
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
  // 21. C#: async void event handler anti-pattern
  {
    id: 'csharp-async-void',
    language: 'csharp' as any,
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
  // 22. PHP: md5/sha1 loose hash equality comparison
  {
    id: 'php-loose-hash-compare',
    language: 'php' as any,
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

/**
 * Serializes standard rules to standalone YAML rule strings for ast-grep execution
 */
export function serializeRuleToYaml(rule: ASTGrepYamlRule): string {
  return `id: ${rule.id}
language: ${rule.language}
severity: ${rule.severity}
message: "${rule.message.replace(/"/g, '\\"')}"
rule:
  pattern: "${rule.rule.pattern.replace(/"/g, '\\"')}"
${rule.fix ? `fix: "${rule.fix.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"` : ''}
`;
}
