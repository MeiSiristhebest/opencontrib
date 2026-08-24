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
 * Standard Production-Grade Deep AST Relational Rules.
 *
 * Only the 5 rules that are NOT already covered by Semgrep `p/security-audit` +
 * `p/cwe-top-25` or CodeQL query suites are kept here. All other patterns
 * (float equality, bare except, mutex leak, unclosed body, unwrap, SSRF,
 * async void, sprintf, php hash compare, etc.) are available upstream and
 * should be loaded via Semgrep rule packs rather than maintained in-house.
 */
export const STANDARD_AST_RELATIONAL_RULES: ASTGrepYamlRule[] = [
  {
    id: 'go-unclosed-http-body',
    language: 'go',
    severity: 'error',
    message: 'HTTP response body must be closed to prevent socket resource leaks',
    rule: {
      pattern: '$RESP, $ERR := http.Get($URL)',
    },
    fix: '$RESP, $ERR := http.Get($URL)\nif $ERR == nil { defer $RESP.Body.Close() }',
    metadata: {
      cwe: 'CWE-400',
      category: 'lifecycle_leak',
      impact: 'Unclosed response body leaks TCP socket file descriptors',
    },
  },
  {
    id: 'go-mutex-defer-in-loop',
    language: 'go',
    severity: 'warning',
    message: 'defer mu.Unlock() inside for-loop delays unlock until outer function returns',
    rule: {
      pattern: 'for $COND { $MU.Lock(); defer $MU.Unlock(); $$$BODY }',
    },
    fix: 'for $COND { func() { $MU.Lock(); defer $MU.Unlock(); $$$BODY }() }',
    metadata: {
      cwe: 'CWE-667',
      category: 'concurrency_deadlock',
      impact: 'Mutex lock held for entire loop duration blocking concurrent goroutines',
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
