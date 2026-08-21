/**
 * 7-Domain Defect Pattern Taxonomy & Federated Rule Catalog
 *
 * Provides a structured, extensible taxonomy of software defects across 7 core domains:
 * 1. Protocol Normalization & Security Sandbox Bypasses (CWE-918, CWE-22, CWE-1321)
 * 2. Concurrency, Race Conditions & Synchronization (CWE-667, CWE-662, CWE-833)
 * 3. Lifecycle, Resource Starvation & Descriptor Leaks (CWE-400, CWE-775)
 * 4. Async Control Flow, Exception Swallowing & Unhandled Errors (CWE-754, CWE-391, CWE-476)
 * 5. State Inconsistency, Data Integrity & Idempotency Flaws (CWE-670)
 * 6. Language-Specific Traps & Panic Surface (CWE-754, CWE-670)
 * 7. AI Agent Infrastructure & Knowledge Store Flaws (CWE-1021, CWE-78, CWE-400)
 */

export type DefectDomain =
  | 'PROTOCOL_NORMALIZATION'
  | 'CONCURRENCY_RACE'
  | 'LIFECYCLE_LEAK'
  | 'ASYNC_FLOW'
  | 'DATA_INTEGRITY'
  | 'LANGUAGE_TRAPS'
  | 'AGENT_INFRASTRUCTURE';

export interface DefectTaxonomyPattern {
  id: string;
  domain: DefectDomain;
  language: 'typescript' | 'javascript' | 'go' | 'rust' | 'python' | 'polyglot';
  severity: 'error' | 'warning' | 'info';
  categoryMultiplier: number; // Used for Top-K Smart Pointer composite ranking
  name: string;
  description: string;
  cwe: string;
  owasp?: string;
  impact: string;
  rule: {
    pattern: string;
    inside?: {
      pattern?: string;
      kind?: string;
    };
    not?: {
      pattern?: string;
      inside?: { pattern?: string };
    };
  };
  fixTemplate?: string;
  remediationGuide: string;
}

export const DEFECT_TAXONOMY_CATALOG: DefectTaxonomyPattern[] = [
  // =========================================================================
  // Domain 1: Protocol Normalization & Security Sandbox Bypasses
  // =========================================================================
  {
    id: 'ts-ssrf-bracketed-ipv6-bypass',
    domain: 'PROTOCOL_NORMALIZATION',
    language: 'typescript',
    severity: 'error',
    categoryMultiplier: 2.0,
    name: 'WHATWG URL Bracketed IPv6 SSRF Filter Bypass',
    description: 'WHATWG URL parser retains enclosing brackets on IPv6 hostnames (e.g. "[::1]"). Anchored regex checks on host without bracket stripping allow complete SSRF bypass.',
    cwe: 'CWE-918',
    owasp: 'A10:2021-Server-Side Request Forgery',
    impact: 'Enables unauthorized SSRF requests to loopback [::1] or cloud metadata endpoints [fe80::1]',
    rule: {
      pattern: '$RE.test($HOST)',
      inside: {
        pattern: 'function $FN($$$) { $$$ }',
      },
    },
    fixTemplate: 'const normalizedHost = $HOST.replace(/^\\[|\\]$/g, "");\n$RE.test(normalizedHost)',
    remediationGuide: 'Strip leading and trailing brackets and normalize IPv4-mapped IPv6 addresses before testing against private IP blocklists.',
  },
  {
    id: 'go-ssrf-url-hostname-bracket',
    domain: 'PROTOCOL_NORMALIZATION',
    language: 'go',
    severity: 'error',
    categoryMultiplier: 2.0,
    name: 'Go net/url Hostname Bracketed IPv6 Bypass',
    description: 'URL Hostname with IPv6 retains brackets; net.ParseIP or regex matching without strings.Trim(host, "[]") allows SSRF filter bypass.',
    cwe: 'CWE-918',
    owasp: 'A10:2021-Server-Side Request Forgery',
    impact: 'SSRF filter bypass to private internal VPC network endpoints',
    rule: {
      pattern: 'net.ParseIP($U.Host)',
    },
    fixTemplate: 'net.ParseIP(strings.Trim($U.Host, "[]"))',
    remediationGuide: 'Use strings.Trim(u.Hostname(), "[]") before IP parsing or CIDR subnet membership checks.',
  },
  {
    id: 'py-ssrf-bracketed-ipv6-bypass',
    domain: 'PROTOCOL_NORMALIZATION',
    language: 'python',
    severity: 'error',
    categoryMultiplier: 2.0,
    name: 'Python urllib.parse Netloc Bracketed IPv6 Bypass',
    description: 'urllib.parse.urlparse hostname for IPv6 includes square brackets; ipaddress.ip_address() requires stripping brackets to avoid ValueError or regex bypass.',
    cwe: 'CWE-918',
    owasp: 'A10:2021-Server-Side Request Forgery',
    impact: 'SSRF validation bypass permitting requests to private IPv6 subnets',
    rule: {
      pattern: 'ipaddress.ip_address($PARSED.hostname)',
    },
    fixTemplate: 'ipaddress.ip_address($PARSED.hostname.strip("[]"))',
    remediationGuide: 'Strip square brackets from parsed.hostname before passing to ipaddress.ip_address().',
  },
  {
    id: 'ts-prototype-pollution-assignment',
    domain: 'PROTOCOL_NORMALIZATION',
    language: 'typescript',
    severity: 'error',
    categoryMultiplier: 1.8,
    name: 'Prototype Pollution via Dynamic Key Assignment',
    description: 'Assigning to Object[key] with user-controlled keys without checking for __proto__ or constructor.prototype allows prototype pollution.',
    cwe: 'CWE-1321',
    owasp: 'A08:2021-Software and Data Integrity Failures',
    impact: 'Global object pollution, property injection, and potential RCE',
    rule: {
      pattern: '$TARGET[$KEY] = $VALUE',
      not: {
        inside: {
          pattern: 'if ($KEY !== "__proto__" && $KEY !== "constructor" && $KEY !== "prototype") { $$$ }',
        },
      },
    },
    remediationGuide: 'Validate object keys against __proto__, constructor, and prototype, or use Map / Object.create(null).',
  },

  // =========================================================================
  // Domain 2: Concurrency, Race Conditions & Synchronization
  // =========================================================================
  {
    id: 'go-mutex-unlock-leak',
    domain: 'CONCURRENCY_RACE',
    language: 'go',
    severity: 'error',
    categoryMultiplier: 1.8,
    name: 'Go Mutex Lock without Guaranteed defer Unlock',
    description: 'Mutex.Lock() called without guaranteed defer Mutex.Unlock() in function scope.',
    cwe: 'CWE-667',
    impact: 'Permanent deadlock if function panics or returns via early error branch',
    rule: {
      pattern: '$MU.Lock()',
      not: {
        inside: {
          pattern: 'defer $MU.Unlock()',
        },
      },
    },
    fixTemplate: '$MU.Lock()\ndefer $MU.Unlock()',
    remediationGuide: 'Always pair $MU.Lock() immediately with defer $MU.Unlock() unless fine-grained manual lock handoff is documented.',
  },
  {
    id: 'go-mutex-copy-by-value',
    domain: 'CONCURRENCY_RACE',
    language: 'go',
    severity: 'error',
    categoryMultiplier: 1.8,
    name: 'Go sync.Mutex Copied by Value',
    description: 'Passing struct containing sync.Mutex by value creates a copied lock with independent state, destroying synchronization.',
    cwe: 'CWE-667',
    impact: 'Data races and race detector failures under concurrent invocation',
    rule: {
      pattern: 'func ($RECEIVER $STRUCT) $METHOD($$$) { $$$ }',
    },
    remediationGuide: 'Use pointer receiver func (r *Struct) for all structs embedding sync.Mutex.',
  },

  // =========================================================================
  // Domain 3: Lifecycle, Resource Starvation & Descriptor Leaks
  // =========================================================================
  {
    id: 'go-unclosed-http-body',
    domain: 'LIFECYCLE_LEAK',
    language: 'go',
    severity: 'error',
    categoryMultiplier: 1.5,
    name: 'Go HTTP Response Body Unclosed',
    description: 'HTTP response body must be closed with defer resp.Body.Close() after error check.',
    cwe: 'CWE-400',
    impact: 'Socket descriptor and memory buffer exhaustion under high traffic load',
    rule: {
      pattern: '$RESP, $ERR := http.Get($URL)',
      not: {
        inside: {
          pattern: 'defer $RESP.Body.Close()',
        },
      },
    },
    fixTemplate: '$RESP, $ERR := http.Get($URL)\nif $ERR != nil {\n\treturn $ERR\n}\ndefer $RESP.Body.Close()',
    remediationGuide: 'Ensure defer resp.Body.Close() is called immediately after verifying err == nil.',
  },
  {
    id: 'go-unclosed-sql-rows',
    domain: 'LIFECYCLE_LEAK',
    language: 'go',
    severity: 'error',
    categoryMultiplier: 1.5,
    name: 'Go SQL Query Rows Unclosed',
    description: 'Database query rows must be closed with defer rows.Close() to return connection to pool.',
    cwe: 'CWE-400',
    impact: 'Database connection pool starvation blocking all subsequent queries',
    rule: {
      pattern: '$ROWS, $ERR := $DB.Query($QUERY)',
      not: {
        inside: {
          pattern: 'defer $ROWS.Close()',
        },
      },
    },
    remediationGuide: 'Add defer rows.Close() immediately after checking db.Query error.',
  },
  {
    id: 'go-time-after-in-select-loop',
    domain: 'LIFECYCLE_LEAK',
    language: 'go',
    severity: 'error',
    categoryMultiplier: 1.6,
    name: 'Go time.After Leak in for-select Loop',
    description: 'time.After inside for-select loop allocates a new timer per iteration until duration fires.',
    cwe: 'CWE-400',
    impact: 'Rapid heap memory accumulation and GC pressure under high event rates',
    rule: {
      pattern: 'case <-time.After($D):',
      inside: {
        pattern: 'for { select { $$$ } }',
      },
    },
    remediationGuide: 'Use time.NewTimer() outside loop and call timer.Reset() inside loop instead of time.After().',
  },

  // =========================================================================
  // Domain 4: Async Control Flow, Exception Swallowing & Unhandled Errors
  // =========================================================================
  {
    id: 'ts-floating-promise-unhandled',
    domain: 'ASYNC_FLOW',
    language: 'typescript',
    severity: 'error',
    categoryMultiplier: 1.4,
    name: 'TypeScript Floating Async Promise without Await or Catch',
    description: 'Calling async function without await, void, or .catch() risks unhandled promise rejection.',
    cwe: 'CWE-754',
    impact: 'Silent background failures, unhandled promise rejections, and state desync',
    rule: {
      pattern: '$ASYNC_FUNC($$$)',
      not: {
        inside: {
          pattern: 'await $ASYNC_FUNC($$$)',
        },
      },
    },
    remediationGuide: 'Add await, return the promise, or explicitly chain .catch(errorHandler).',
  },
  {
    id: 'py-swallowed-broad-exception',
    domain: 'ASYNC_FLOW',
    language: 'python',
    severity: 'warning',
    categoryMultiplier: 1.3,
    name: 'Python Broad Exception Swallowing (except Exception: pass)',
    description: 'Catching broad Exception with empty pass block suppresses unexpected failures and hides bugs.',
    cwe: 'CWE-391',
    impact: 'Masks underlying bugs, database timeouts, and system interruptions',
    rule: {
      pattern: 'except Exception:\n    pass',
    },
    remediationGuide: 'Catch specific exception classes and log the error context with logger.exception().',
  },

  // =========================================================================
  // Domain 5: State Inconsistency, Data Integrity & Idempotency Flaws
  // =========================================================================
  {
    id: 'go-redis-zrange-order-trap',
    domain: 'DATA_INTEGRITY',
    language: 'go',
    severity: 'error',
    categoryMultiplier: 1.5,
    name: 'Go Redis ZRange Ascending Order Pagination Trap',
    description: 'Using ZRange instead of ZRevRange when paginating reverse-chronological feeds returns oldest entries first.',
    cwe: 'CWE-670',
    impact: 'Inverted chronological feed ordering and pagination inconsistencies',
    rule: {
      pattern: '$CLIENT.ZRange($CTX, $KEY, $START, $STOP)',
    },
    remediationGuide: 'Verify if business logic requires ZRevRange (descending) or ZRange (ascending).',
  },

  // =========================================================================
  // Domain 6: Language-Specific Traps & Panic Surface
  // =========================================================================
  {
    id: 'rust-unwrap-in-library-code',
    domain: 'LANGUAGE_TRAPS',
    language: 'rust',
    severity: 'warning',
    categoryMultiplier: 1.3,
    name: 'Rust .unwrap() in Production Library Code',
    description: 'Calling .unwrap() on Result/Option can trigger sudden panic in production.',
    cwe: 'CWE-754',
    impact: 'Unrecoverable thread panic bringing down entire service instance',
    rule: {
      pattern: '$EXPR.unwrap()',
    },
    fixTemplate: '$EXPR.unwrap_or_default()',
    remediationGuide: 'Use ? operator, unwrap_or, or match statement to return Result<T, E> gracefully.',
  },
  {
    id: 'py-mutable-default-argument',
    domain: 'LANGUAGE_TRAPS',
    language: 'python',
    severity: 'warning',
    categoryMultiplier: 1.4,
    name: 'Python Mutable Default Argument',
    description: 'Using mutable default argument (list/dict/set) in function definition retains state across calls.',
    cwe: 'CWE-670',
    impact: 'Shared state corruption across multiple independent function invocations',
    rule: {
      pattern: 'def $FN($$$ARG=[]): $$$',
    },
    remediationGuide: 'Use None as default argument and initialize mutable object inside function body.',
  },

  // =========================================================================
  // Domain 7: AI Agent Infrastructure & Knowledge Store Flaws
  // =========================================================================
  {
    id: 'agent-vector-graph-desync',
    domain: 'AGENT_INFRASTRUCTURE',
    language: 'polyglot',
    severity: 'error',
    categoryMultiplier: 1.9,
    name: 'AI Agent Vector-Graph Knowledge Desynchronization',
    description: 'Modifying vector embedding store without transactional synchronization with knowledge graph edges creates orphaned semantic nodes.',
    cwe: 'CWE-1021',
    impact: 'Inconsistent agent memory retrieval, stale document references, and hallucinated answers',
    rule: {
      pattern: '$VECTOR_STORE.upsert($DOC)',
    },
    remediationGuide: 'Wrap vector store updates and knowledge graph relation updates within a unified atomic transaction.',
  },
  {
    id: 'agent-unbounded-context-token-overflow',
    domain: 'AGENT_INFRASTRUCTURE',
    language: 'polyglot',
    severity: 'warning',
    categoryMultiplier: 1.6,
    name: 'AI Agent Unbounded Context Token Window Overflow',
    description: 'Injecting raw user or tool output directly into LLM prompt without token count bounding can exceed model context limits.',
    cwe: 'CWE-400',
    impact: 'Model 400 Bad Request error or silent context truncation breaking reasoning chain',
    rule: {
      pattern: '$PROMPT += $UNBOUNDED_INPUT',
    },
    remediationGuide: 'Calculate token counts using tiktoken or model tokenizer and apply sliding window / top-k compaction.',
  },
];

/**
 * Filter catalog patterns by domain, language, and minimum severity
 */
export function queryTaxonomyCatalog(criteria?: {
  domain?: DefectDomain;
  language?: string;
  minSeverity?: 'error' | 'warning' | 'info';
}): DefectTaxonomyPattern[] {
  let result = [...DEFECT_TAXONOMY_CATALOG];

  if (criteria?.domain) {
    result = result.filter((p) => p.domain === criteria.domain);
  }

  if (criteria?.language) {
    result = result.filter((p) => p.language === 'polyglot' || p.language === criteria.language);
  }

  if (criteria?.minSeverity) {
    const sevRank = { error: 3, warning: 2, info: 1 };
    const minRank = sevRank[criteria.minSeverity] || 1;
    result = result.filter((p) => (sevRank[p.severity] || 1) >= minRank);
  }

  return result;
}
