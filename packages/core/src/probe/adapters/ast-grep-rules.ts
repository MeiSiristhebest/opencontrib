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
  // 3. TypeScript: Floating Point Direct Equality Comparison
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
  // 4. TypeScript: Promise without catch or error handling
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
