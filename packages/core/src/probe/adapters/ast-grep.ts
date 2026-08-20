export interface ASTGrepPatternRule {
  id: string;
  language: string;
  category: string;
  message: string;
  pattern: string;
  severity: 'high' | 'medium' | 'low';
}

export const DEEP_WATER_AST_RULES: ASTGrepPatternRule[] = [
  // 1. Protocol Drift: unhandled Promise rejection
  {
    id: 'ts-unhandled-promise-catch',
    language: 'typescript',
    category: 'protocol_drift',
    message: 'Promise call chain missing .catch() handler or try-catch wrapper',
    pattern: '$PROMISE.then($$$ARGS)',
    severity: 'medium',
  },
  // 2. Resource Leak: Go HTTP body unclosed
  {
    id: 'go-resp-body-close',
    language: 'go',
    category: 'lifecycle_leak',
    message: 'http.Get or client.Do response body should be closed with defer resp.Body.Close()',
    pattern: '$RESP, $ERR := http.Get($URL)',
    severity: 'high',
  },
  // 3. Concurrency: Go context.Background in HTTP handler
  {
    id: 'go-orphan-context',
    language: 'go',
    category: 'lifecycle_leak',
    message: 'Using context.Background() inside request handler breaks cancellation propagation',
    pattern: 'context.Background()',
    severity: 'medium',
  },
  // 4. Security CWE: Path traversal via path.join with user input
  {
    id: 'path-traversal-join',
    language: 'typescript',
    category: 'security_cwe',
    message: 'Unvalidated path.join may allow directory traversal vulnerability',
    pattern: 'path.join($BASE, $INPUT)',
    severity: 'high',
  },
  // 5. Numerical bounds: floating point direct equality check
  {
    id: 'float-exact-equality',
    language: 'typescript',
    category: 'numerical_bounds',
    message: 'Direct equality comparison on float may fail due to IEEE 754 precision drift',
    pattern: '$A === $B',
    severity: 'low',
  },
];

export function getASTGrepRulesForLanguage(language: string): ASTGrepPatternRule[] {
  const langLower = language.toLowerCase();
  return DEEP_WATER_AST_RULES.filter(
    (r) => r.language.toLowerCase() === langLower || r.language === '*',
  );
}
