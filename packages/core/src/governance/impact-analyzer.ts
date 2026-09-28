import { PatchDraftSchema } from "../contracts/llm-schemas.js";

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

interface PatchAnalysisScope {
  filePath: string;
  addedCode: string;
  contextCode: string;
}

function collectPatchAnalysisScopes(patchContent: string): PatchAnalysisScope[] {
  const scopes: PatchAnalysisScope[] = [];
  const lines = patchContent.split(/\r?\n/);
  let filePath = "<patch>";
  let hunkLines: string[] | undefined;
  let sawUnifiedDiff = false;

  const finishHunk = () => {
    if (!hunkLines) return;
    const addedLines: string[] = [];
    const contextLines: string[] = [];
    for (const line of hunkLines) {
      if (line.startsWith("+")) {
        addedLines.push(line.slice(1));
        contextLines.push(line.slice(1));
      } else if (line.startsWith(" ")) {
        contextLines.push(line.slice(1));
      }
    }
    scopes.push({
      filePath,
      addedCode: addedLines.join("\n"),
      contextCode: contextLines.join("\n"),
    });
    hunkLines = undefined;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      finishHunk();
      const pathMatch = line.match(/^diff --git a\/.+ b\/(.+)$/);
      filePath = pathMatch?.[1] ?? "<patch>";
      continue;
    }
    if (line.startsWith("+++ b/")) {
      filePath = line.slice(6);
      continue;
    }
    if (line.startsWith("@@")) {
      finishHunk();
      hunkLines = [];
      sawUnifiedDiff = true;
      continue;
    }
    hunkLines?.push(line);
  }
  finishHunk();

  if (sawUnifiedDiff) {
    return scopes.filter((scope) => scope.addedCode.length > 0);
  }

  try {
    const parsedPatch = PatchDraftSchema.safeParse(JSON.parse(patchContent));
    if (parsedPatch.success) {
      return parsedPatch.data.files.map((file) => ({
        filePath: file.path,
        addedCode: file.content,
        contextCode: file.content,
      }));
    }
  } catch {
    // Plain unified snippets are handled below when the input is not JSON.
  }

  const addedLines = lines.flatMap((line) =>
    line.startsWith("+") && !line.startsWith("+++") ? [line.slice(1)] : [],
  );
  const code = addedLines.length > 0 ? addedLines.join("\n") : patchContent;
  return [{ filePath: "<patch>", addedCode: code, contextCode: code }];
}

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

  // D. Windows EBUSY / file lock cleanup hazard
  if (
    (patchContent.includes('fs.unlinkSync') || patchContent.includes('fs.rmSync')) &&
    !patchContent.includes('retry') &&
    !patchContent.includes('catch')
  ) {
    crossPlatformHazards.push(
      `POTENTIAL EBUSY FILE LOCK HAZARD: Synchronous unlinking without retry or catch block. On Windows CI, spawned child processes or antivirus scanners hold asynchronous file handles, causing EBUSY/EPERM errors during cleanup. Use retry logic (e.g. maxRetries/retryDelay).`
    );
  }

  // 3. Defensive checks (try-catch, error handling, namespace collision)
  if (
    (patchContent.includes('.ts') || patchContent.includes('.js')) &&
    patchContent.includes('JSON.parse(') &&
    !patchContent.includes('try')
  ) {
    defensiveRecommendations.push(
      `Add try-catch block around 'JSON.parse' to gracefully handle malformed JSON without crashing.`
    );
  }

  // D. Check each changed reset_index call and its local collision handling.
  const patchScopes = collectPatchAnalysisScopes(patchContent);
  let hasUnsafeIndexPromotion = false;
  const resetIndexPattern = /\b([A-Za-z_]\w*)\.reset_index\s*\(([^)]*)\)/g;
  for (const scope of patchScopes) {
    for (const match of scope.addedCode.matchAll(resetIndexPattern)) {
      if (/\bdrop\s*=\s*True\b/i.test(match[2])) continue;
      const receiver = match[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const hasRelevantCollisionGuard = new RegExp(
        `(?:while|if)\\s+[^\\n]*\\b${receiver}\\.columns\\b[\\s\\S]{0,200}?\\b${receiver}\\.reset_index\\s*\\(`,
        "i",
      ).test(scope.contextCode);
      if (!hasRelevantCollisionGuard) hasUnsafeIndexPromotion = true;
    }
  }
  if (hasUnsafeIndexPromotion) {
    defensiveRecommendations.push(
      `CRITICAL DEFENSIVE COLLISION HAZARD: '.reset_index()' detected without explicit uniqueness verification or collision resolution against existing columns. Verify that promoted index name cannot collide with existing DataFrame columns (e.g. while col in df: col += '_').`,
    );
  }

  // E. Warn when changed training intake has no corresponding changed/verified inference normalization.
  const addedCodeByFile = new Map<string, string[]>();
  for (const scope of patchScopes) {
    const fileCode = addedCodeByFile.get(scope.filePath) ?? [];
    fileCode.push(scope.addedCode);
    addedCodeByFile.set(scope.filePath, fileCode);
  }
  const hasAsymmetricTrainingChange = Array.from(addedCodeByFile.values()).some(
    (chunks) => {
      const addedCode = chunks.join("\n");
      if (!/\bvalidate_data\b|\bfit\s*\(/i.test(addedCode)) return false;
      const hasInferenceNormalization =
        /(?:\b(?:_normalize|validate_data)\s*\([^)]*\)[\s\S]{0,300}\bpredict\s*\(|\bpredict\s*\([^)]*\)[\s\S]{0,300}\b(?:_normalize|validate_data)\s*\()/i.test(
          addedCode,
        );
      return !hasInferenceNormalization;
    },
  );
  if (hasAsymmetricTrainingChange) {
    consistencyWarnings.push(
      `CRITICAL SYMMETRIC LIFECYCLE WARNING: Patch alters data validation/ingestion in training path. Verify whether identical input shapes (e.g. indexed Series/DataFrames) must also be supported in validation (X_val) or inference (predict) paths.`,
    );
  }

  // F. Symmetric Transformation Lifecycle
  if (
    (patchContent.includes('.transform(') || patchContent.includes('def transform(')) &&
    !patchContent.includes('inverse_transform') &&
    (patchContent.includes('fit_transform') || patchContent.includes('StandardScaler') || patchContent.includes('Encoder'))
  ) {
    consistencyWarnings.push(
      `SYMMETRIC LIFECYCLE WARNING: Data transformation modified without considering 'inverse_transform' symmetry.`
    );
  }

  const hasCriticalHazard =
    crossPlatformHazards.some((h) => h.includes('CRITICAL')) ||
    defensiveRecommendations.some((r) => r.includes('CRITICAL')) ||
    consistencyWarnings.some((w) => w.includes('CRITICAL'));

  let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  if (hasCriticalHazard) {
    riskLevel = 'HIGH';
  } else if (
    crossPlatformHazards.length > 0 ||
    consistencyWarnings.length > 2 ||
    defensiveRecommendations.length > 0
  ) {
    riskLevel = 'MEDIUM';
  } else {
    riskLevel = 'LOW';
  }

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
