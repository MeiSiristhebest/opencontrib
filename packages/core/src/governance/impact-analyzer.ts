export interface ImpactAnalysisResult {
  isCompliant: boolean;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  modifiedFiles: string[];
  suggestedSisterFiles: string[];
  crossPlatformHazards: string[];
  consistencyWarnings: string[];
  defensiveRecommendations: string[];
}

export interface ImpactAnalysisInput {
  modifiedFiles: string[];
  patchContent: string;
  repoContextFiles?: string[];
}

const KNOWN_SISTER_PATTERNS: Array<{ pattern: RegExp; siblings: string[]; reason: string }> = [
  {
    pattern: /parser\.(go|ts|py|rs)$/i,
    siblings: ['hunk', 'types', 'ast', 'lexer', 'tokenizer'],
    reason: 'Modifying a parser typically impacts AST/Hunk types and tokenizers.',
  },
  {
    pattern: /fileread(er)?\.(go|ts|py|rs)$/i,
    siblings: ['file_read', 'workspace_file', 'pathutil', 'gitcmd'],
    reason: 'File reader changes often require synchronization with path utility and workspace reader.',
  },
  {
    pattern: /schema\.(json|ts|go)$/i,
    siblings: ['types', 'validator', 'README.md', 'contract'],
    reason: 'Schema modifications require updating type definitions, validation logic, and documentation.',
  },
  {
    pattern: /auth(entication)?\.(go|ts|py|rs)$/i,
    siblings: ['session', 'token', 'credentials', 'security'],
    reason: 'Auth logic changes usually necessitate corresponding token/session updates.',
  },
];

export function analyzePatchImpactAndConsistency(input: ImpactAnalysisInput): ImpactAnalysisResult {
  const { modifiedFiles, patchContent, repoContextFiles = [] } = input;
  const suggestedSisterFiles: string[] = [];
  const crossPlatformHazards: string[] = [];
  const consistencyWarnings: string[] = [];
  const defensiveRecommendations: string[] = [];

  // 1. Sister / Sibling file detection
  for (const file of modifiedFiles) {
    for (const rule of KNOWN_SISTER_PATTERNS) {
      if (rule.pattern.test(file)) {
        for (const sibling of rule.siblings) {
          // Look for matching files in repo context if available
          const found = repoContextFiles.find((rf) => rf.toLowerCase().includes(sibling) && !modifiedFiles.includes(rf));
          if (found && !suggestedSisterFiles.includes(found)) {
            suggestedSisterFiles.push(found);
            consistencyWarnings.push(
              `Modified '${file}': consider checking sibling module '${found}' (${rule.reason})`
            );
          }
        }
      }
    }
  }

  // 2. Cross-platform anti-pattern static checks
  // A. filepath.ToSlash Linux No-Op Trap
  if (patchContent.includes('filepath.ToSlash(')) {
    crossPlatformHazards.push(
      `CRITICAL: 'filepath.ToSlash' detected in patch. In Go on Linux, filepath.ToSlash is a no-op (leaves '\\' intact), which causes security traversal bypasses and CI failures. Use 'strings.ReplaceAll(path, "\\\\", "/")' for cross-platform normalization.`
    );
  }

  // B. CRLF regex / split trap without \\r stripping
  if (
    (patchContent.includes('strings.Split(') || patchContent.includes('.split(')) &&
    patchContent.includes('"\\n"') &&
    !patchContent.includes('TrimSuffix') &&
    !patchContent.includes('replace')
  ) {
    crossPlatformHazards.push(
      `POTENTIAL CRLF HAZARD: Splitting lines on '\\n' without stripping trailing '\\r'. In Windows or CRLF checkouts, lines will retain dirty '\\r' characters, corrupting file paths and metadata matching.`
    );
  }

  // C. Hardcoded path separators ('/' or '\\') in OS file operations
  if (patchContent.includes('os.Open(') && (patchContent.includes('"/"') || patchContent.includes('"\\\\"'))) {
    crossPlatformHazards.push(
      `POTENTIAL PATH SEPARATOR HAZARD: Hardcoded slash in filesystem call. Prefer 'filepath.Join' for OS filesystem access.`
    );
  }

  // 3. Defensive checks (try-catch, error handling)
  if (
    (patchContent.includes('.ts') || patchContent.includes('.js')) &&
    patchContent.includes('JSON.parse(') &&
    !patchContent.includes('try')
  ) {
    defensiveRecommendations.push(
      `Add try-catch block around 'JSON.parse' to gracefully handle malformed JSON without crashing.`
    );
  }

  const hasCriticalHazard = crossPlatformHazards.some((h) => h.includes('CRITICAL'));
  const riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' = hasCriticalHazard
    ? 'HIGH'
    : crossPlatformHazards.length > 0 || consistencyWarnings.length > 2
    ? 'MEDIUM'
    : 'LOW';

  const isCompliant = !hasCriticalHazard;

  return {
    isCompliant,
    riskLevel,
    modifiedFiles,
    suggestedSisterFiles,
    crossPlatformHazards,
    consistencyWarnings,
    defensiveRecommendations,
  };
}
