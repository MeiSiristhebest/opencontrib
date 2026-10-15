/**
 * Dynamic Community Policy & Governance Extractor
 *
 * Inspects repository governance files (CONTRIBUTING.md, AGENTS.md, AI_POLICY.md,
 * issue templates, etc.) and dynamically extracts structured community traits
 * (philosophy, AI policy, dynamic blocking labels, and test rigor) without
 * hardcoding static repository assumptions into business logic.
 */

export interface DynamicExtractedPolicy {
  philosophy?: 'minimal_core' | 'discussion_first' | 'standard' | 'enterprise';
  aiPolicy?: 'prohibited' | 'disclosure_required' | 'allowed';
  dynamicBlockingLabels: string[];
  testRigor?: {
    variantsRequired?: boolean;
    redTestMandatory?: boolean;
  };
  antiPoachingConfig?: {
    authorGracePeriodDays?: number;
    claimExpiryDays?: number;
  };
  extractedKeywords: string[];
}

export function extractDynamicCommunityProfile(
  files: ReadonlyArray<{ path: string; content: string }>,
): DynamicExtractedPolicy {
  const extractedKeywords: string[] = [];
  const dynamicBlockingLabels = new Set<string>();

  const combinedContent = files
    .map(({ path: p, content }) => `\n--- ${p} ---\n${content}`)
    .join('');

  // 1. Philosophy Extraction
  let philosophy: 'minimal_core' | 'discussion_first' | 'standard' | 'enterprise' = 'standard';
  const isMinimalCore =
    /\b(?:minimal\s*core|minimal\s*surface|keep\s*core\s*small|avoid\s*bloat|conservative\s*additions?|zero\s*dependency|small\s*footprint)\b/i.test(
      combinedContent,
    );
  const isDiscussionFirst =
    /\b(?:discuss(?:ion)?\s*(?:first|before\s*(?:opening|submitting)\s*(?:a\s*)?pr)|unsolicited\s*prs?\s*will\s*be\s*closed|proposal\s*required|rfc\s*first)\b/i.test(
      combinedContent,
    );

  if (isMinimalCore) {
    philosophy = 'minimal_core';
    extractedKeywords.push('philosophy:minimal_core');
  } else if (isDiscussionFirst) {
    philosophy = 'discussion_first';
    extractedKeywords.push('philosophy:discussion_first');
  }

  // 2. AI Policy Extraction
  let aiPolicy: 'prohibited' | 'disclosure_required' | 'allowed' = 'allowed';
  const aiPolicyFiles = files.filter((f) =>
    /(?:ai[_-]?policy|\.github\/ai[_-]?policy)/i.test(f.path),
  );
  const hasAiPolicyFile = aiPolicyFiles.length > 0;

  const isAiProhibited =
    hasAiPolicyFile ||
    /\b(?:do\s*not\s*accept\s*(?:ai|llm)[ -]?(?:generated|assisted)\s*pull\s*requests?|no\s*(?:ai|llm|automated)[ -]?generated\s*prs?|autonomous\s*agents?\s*prohibited|strictly\s*forbidden\s*to\s*use\s*ai|ai\s*comments?\s*(?:are\s*)?not\s*permitted)\b/i.test(
      combinedContent,
    );

  const isAiDisclosureRequired =
    !isAiProhibited &&
    /\b(?:must\s*disclose\s*(?:the\s*use\s*of\s*)?ai|ai\s*disclosure\s*is\s*required|disclose\s*(?:all\s*)?ai\s*assistance|requires?\s*ai\s*disclosure)\b/i.test(
      combinedContent,
    );

  if (isAiProhibited) {
    aiPolicy = 'prohibited';
    extractedKeywords.push('aiPolicy:prohibited');
  } else if (isAiDisclosureRequired) {
    aiPolicy = 'disclosure_required';
    extractedKeywords.push('aiPolicy:disclosure_required');
  }

  // 3. Dynamic Blocking Labels Extraction from Templates & Governance files
  // Match YAML frontmatter or configs like labels: [..., ...] or labels: "..."
  const yamlLabelMatches = combinedContent.matchAll(
    /labels:\s*(?:\[([^\]]+)\]|([^\r\n]+))/gi,
  );
  for (const m of yamlLabelMatches) {
    const raw = m[1] || m[2];
    if (raw) {
      const tokens = raw.split(/[,;\n]/).map((t) => t.replace(/['"\[\]]/g, '').trim());
      for (const t of tokens) {
        if (
          t &&
          /\b(?:needs|blocked|rfc|proposal|wontfix|invalid|hold|decision|design|stale)\b/i.test(
            t,
          )
        ) {
          dynamicBlockingLabels.add(t.toLowerCase());
          extractedKeywords.push(`blocking_label:${t.toLowerCase()}`);
        }
      }
    }
  }

  // Also extract custom status label patterns mentioned in policy text
  const statusLabelMentions = combinedContent.matchAll(
    /["'`]?\b((?:status|needs|type)[\/:_-][a-zA-Z0-9_-]+)\b["'`]?/gi,
  );
  for (const match of statusLabelMentions) {
    const label = match[1].toLowerCase();
    if (
      /\b(?:decision|design|blocked|rfc|proposal|investigation|wontfix|hold)\b/i.test(
        label,
      )
    ) {
      dynamicBlockingLabels.add(label);
      extractedKeywords.push(`blocking_label:${label}`);
    }
  }

  // 4. Test Rigor Extraction
  const variantsRequired =
    /\b(?:prove\s*the\s*test\s*fails\s*for\s*(?:the\s*)?right\s*reason|variant\s*matrix|test\s*(?:both\s*)?(?:positive\s*and\s*negative|edge\s*cases)|multi-platform\s*tests?|cross-platform\s*reproduction)\b/i.test(
      combinedContent,
    );
  const redTestMandatory =
    /\b(?:failing\s*test\s*(?:case\s*)?required|reproducible\s*test\s*is\s*mandatory|red\s*test\s*before\s*green|no\s*pr\s*without\s*(?:a\s*)?test)\b/i.test(
      combinedContent,
    );

  const testRigor = {
    variantsRequired: variantsRequired ? true : undefined,
    redTestMandatory: redTestMandatory ? true : undefined,
  };

  // 5. Anti-Poaching Config (detect custom grace periods if specified)
  let authorGracePeriodDays: number | undefined;
  let claimExpiryDays: number | undefined;

  const gracePeriodMatch = combinedContent.match(
    /author\s*(?:grace\s*period|priority|first\s*right)\D{0,15}(\d+)\s*days?/i,
  );
  if (gracePeriodMatch) {
    authorGracePeriodDays = parseInt(gracePeriodMatch[1], 10);
    extractedKeywords.push(`author_grace_period:${authorGracePeriodDays}d`);
  }

  const claimExpiryMatch = combinedContent.match(
    /claim\s*(?:timeout|expiry|validity|window)\D{0,15}(\d+)\s*days?/i,
  );
  if (claimExpiryMatch) {
    claimExpiryDays = parseInt(claimExpiryMatch[1], 10);
    extractedKeywords.push(`claim_expiry:${claimExpiryDays}d`);
  }

  return {
    philosophy,
    aiPolicy,
    dynamicBlockingLabels: Array.from(dynamicBlockingLabels),
    testRigor: Object.keys(testRigor).length > 0 ? testRigor : undefined,
    antiPoachingConfig:
      authorGracePeriodDays || claimExpiryDays
        ? { authorGracePeriodDays, claimExpiryDays }
        : undefined,
    extractedKeywords,
  };
}
