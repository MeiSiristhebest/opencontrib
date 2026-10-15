/**
 * Pure Domain Intent & Discourse Evaluator
 *
 * Replaces rigid, monolithic hardcoded regex lists with a declarative,
 * multi-signal scoring engine that detects contributor intent, author
 * first-right, PR announcements, and maintainer approval waits across
 * languages without hardcoding single-purpose strings.
 *
 * Domain layer: Zero I/O, zero global non-determinism.
 */

export type IntentCategory =
  | 'pr_announcement'
  | 'work_claim'
  | 'approval_wait'
  | 'author_intent';

export interface IntentRule {
  /** Which kind of contributor intent this rule detects */
  category: IntentCategory;
  /** Regex pattern to match against comment body */
  pattern: RegExp;
  /** How strongly this signal indicates intent */
  strength: 'strong' | 'moderate' | 'weak';
  /** Human-readable description */
  description: string;
}

export interface IntentSignalScore {
  category: IntentCategory;
  score: number; // 0 to 100
  isMatch: boolean;
  rationale: string;
}

export interface IntentEvaluationContext {
  isAuthor?: boolean;
  customRules?: IntentRule[];
}

// ---------------------------------------------------------------------------
// Declarative Signal Matrix: Multi-Lingual & Structural Indicators
// ---------------------------------------------------------------------------

const FIRST_PERSON_INDICATORS = [
  /\b(?:i|i'm|i am|i've|i have|i'll|i will|we|we're|my)\b/i,
  /(?:我|我们|本人|俺)/,
];

const BYSTANDER_QUESTION_INDICATORS = [
  /\b(?:can\s*(?:someone|anyone|you|we)|could\s*(?:someone|anyone|you)|is\s*anyone|has\s*anyone|who\s*can|are\s*you)\b/i,
  /(?:有没有人|谁能|谁来|大家能|请问谁)/,
];

const HELP_REQUEST_INDICATORS = [
  /\b(?:i\s*need\s*help|need\s*assistance|anyone\s*help|can\s*help\s*me)\b/i,
  /(?:需要帮助|求助|谁帮我)/,
];

const PR_NOUNS = [
  /\b(?:pr|pull\s*request|patch|diff|fix)\b/i,
  /(?:pr|pull\s*request|合并请求|补丁)/i,
];

const ANNOUNCEMENT_VERBS = [
  /\b(?:opened|submitted|created|pushed|put\s*up|ready|is\s*up)\b/i,
  /(?:已提|已提交|已创建|提了|提交了|开了)/,
];

const CLAIM_VERBS = [
  /\b(?:work\s*on|working\s*on|take\s*this|taking\s*this|handle\s*this|turn\s*it\s*around|prepared\s*a\s*fix|look\s*into)\b/i,
  /(?:修复|解决|处理|认领|我来做|我来修|准备修)/,
];

const AUTHOR_OFFER_VERBS = [
  /\b(?:happy\s*to\s*(?:open|submit|send|provide|work\s*on)|willing\s*to|would\s*like\s*to\s*(?:implement|fix|work\s*on)|plan\s*to\s*(?:submit|open)|can\s*fix\s*this|will\s*open\s*a\s*pr)\b/i,
  /(?:乐意(?:提|交|修复)|可以提|准备提|想(?:修|提|解决)|打算提)/,
];

const APPROVAL_WAIT_INDICATORS = [
  /\bwaiting\s*(?:on|for)\s*(?:a\s+|the\s+|maintainer\s+|author\s+|triager\s+)?(?:`?lgtm`?|approval|review|greenlight|sign-?off)\b/i,
  /\b(?:could|can)\s*(?:a\s+)?maintainer\s*(?:please\s*)?(?:approve|review|lgtm)\b/i,
  /\b(?:need|seeking)\s*(?:maintainer\s+)?(?:approval|consensus|decision|lgtm)\b/i,
  /(?:等\s*(?:maintainer|维护者)?\s*(?:lgtm|review|批准|确认|同意))/i,
];

const BOT_CLAIM_COMMANDS = [
  /\b(?:\/claim|\/assign)\b/i,
];

const PR_LINK_PATTERNS = [
  /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i,
  /\bfix(?:es)?\s*(?:in|via|at|by)\s*(?:pr|#\d+|pull)/i,
  /(?:fixed|resolved|addressed|closed)\s*(?:by|in|via)\s*(?:pr|pull\s*request|#\d+)/i,
  /(?:修复|解决)\s*(?:在|见|于|对应)\s*(?:pr|pull\s*request|#\d+)/i,
];

// ---------------------------------------------------------------------------
// Built-in Declarative Rules (Preserved for compatibility and custom extension)
// ---------------------------------------------------------------------------

export const DEFAULT_INTENT_RULES: IntentRule[] = [
  // PR Announcements
  { category: 'pr_announcement', pattern: /(?:\bi(?:\s*have|'ve|\s*just)?\s*|\b)(?:opened|submitted|created|pushed)\s*(?:a\s*)?(?:pr|pull\s*request)/i, strength: 'strong', description: 'Developer announces opened PR' },
  { category: 'pr_announcement', pattern: /fix(?:es)?\s*(?:in|via|at|by)\s*(?:pr|#\d+|pull)/i, strength: 'strong', description: 'Developer references fix in PR' },
  { category: 'pr_announcement', pattern: /(?:fixed|resolved|addressed|closed)\s*(?:by|in|via)\s*(?:pr|pull\s*request|#\d+|https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+)/i, strength: 'strong', description: 'Referenced fix in PR' },
  { category: 'pr_announcement', pattern: /(?:here(?:'s| is)|check out|submitted)\s*(?:the\s*)?(?:pr|fix)?:?\s*https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i, strength: 'strong', description: 'Developer links to fix PR' },
  { category: 'pr_announcement', pattern: /\b(?:pr|pull\s*request)\s+(?:is\s+)?(?:up|open|opened|ready|submitted)\b/i, strength: 'strong', description: 'Developer notes PR is up' },
  { category: 'pr_announcement', pattern: /(?:已提|已创建|已提交|提了|提交了|开了)\s*(?:一个\s*)?(?:pr|pull\s*request|合并请求)/i, strength: 'strong', description: 'Chinese: Developer announces PR' },
  { category: 'pr_announcement', pattern: /(?:修复|解决)\s*(?:在|见|于|对应)\s*(?:pr|pull\s*request|#\d+)/i, strength: 'strong', description: 'Chinese: References fix in PR' },
  { category: 'pr_announcement', pattern: /(?:pr|pull\s*request)\s*(?:已提|已提交|已开|已创建)/i, strength: 'strong', description: 'Chinese: PR already created' },

  // Work Claims
  { category: 'work_claim', pattern: /(?:我来解决|我来修复|我来处理|我来提pr|我来认领|认领这个|我想解决|我想修复)/i, strength: 'strong', description: 'Chinese: Contributor claims issue' },
  { category: 'work_claim', pattern: /\b(?:i am working on this|i'm working on this)\b/i, strength: 'strong', description: 'Explicit "working on this"' },
  { category: 'work_claim', pattern: /\b(?:can i work on this|please assign)\b/i, strength: 'strong', description: 'Request for assignment' },
  { category: 'work_claim', pattern: /\bi(?:'m| am) working on a fix\b/i, strength: 'strong', description: 'Working on a fix' },
  { category: 'work_claim', pattern: /\b(?:i(?:'m| am) taking this|i(?:'ll| will) take this)\b/i, strength: 'strong', description: 'Taking ownership' },
  { category: 'work_claim', pattern: /\bi(?:'m| am) looking into this\b/i, strength: 'moderate', description: 'Looking into the issue' },
  { category: 'work_claim', pattern: /\b(?:i(?:'m| am) opening a pr|i(?:'ll| will) submit a pr|my wip pr|i have (?:a )?wip pr)\b/i, strength: 'strong', description: 'PR submission intent' },
  { category: 'work_claim', pattern: /\b(?:\/claim|\/assign)\b/i, strength: 'strong', description: 'Bot claim/assign command' },
  { category: 'work_claim', pattern: /\b(?:i'd like to work on this|i would like to work on this)\b/i, strength: 'strong', description: 'Polite work request' },
  { category: 'work_claim', pattern: /\b(?:i'd like to implement|i would like to implement)\b/i, strength: 'strong', description: 'Implementation intent' },
  { category: 'work_claim', pattern: /\b(?:i'd like to contribute)\b/i, strength: 'moderate', description: 'Contribution intent' },
  { category: 'work_claim', pattern: /\bi(?:'m| am) happy to (?:send|open) (?:the )?pr\b/i, strength: 'strong', description: 'Eager PR offer' },
  { category: 'work_claim', pattern: /\bi can (?:send|open) (?:the )?pr\b/i, strength: 'moderate', description: 'PR offer' },
  { category: 'work_claim', pattern: /\bi(?:'ve| have)? prepared (?:a fix|a diff)\b/i, strength: 'strong', description: 'Fix already prepared' },
  { category: 'work_claim', pattern: /\bmy fix and regression tests are ready\b/i, strength: 'strong', description: 'Fix and tests ready' },
  { category: 'work_claim', pattern: /\bmy pr (?:is )?coming shortly\b/i, strength: 'strong', description: 'PR imminent' },
  { category: 'work_claim', pattern: /\b(?:i have the fix|have the fix (?:shape )?ready|fix is ready)\b/i, strength: 'strong', description: 'Fix shape is ready' },
  { category: 'work_claim', pattern: /\b(?:turn it around|turn it around quickly)\b/i, strength: 'strong', description: 'Turnaround commitment' },
  { category: 'work_claim', pattern: /\b(?:i(?:'m| am) preparing a fix|preparing a pr)\b/i, strength: 'strong', description: 'Preparing fix or PR' },

  // Approval Wait
  { category: 'approval_wait', pattern: /\b(?:waiting on `?lgtm`?|waiting for `?lgtm`?)\b/i, strength: 'strong', description: 'Waiting for LGTM approval' },
  { category: 'approval_wait', pattern: /\b(?:could a maintainer approve|could you approve)\b/i, strength: 'moderate', description: 'Requesting maintainer approval' },

  // Author Intent
  { category: 'author_intent', pattern: /\bi(?:'m| am) happy to (?:open|submit|send|create|provide|work on) (?:a |the )?(?:pr|pull\s*request|patch|fix)\b/i, strength: 'strong', description: 'Author offers PR/fix' },
  { category: 'author_intent', pattern: /\bi(?:'m| am) happy to submit a pr for that\b/i, strength: 'strong', description: 'Author offers PR for that' },
  { category: 'author_intent', pattern: /\bi(?:'ll| will| can) (?:submit|open|send|create) a (?:pr|fix|patch)\b/i, strength: 'strong', description: 'Author will submit fix' },
  { category: 'author_intent', pattern: /\bi(?:'m| am) (?:working on|preparing|drafting) a (?:pr|fix|patch)\b/i, strength: 'strong', description: 'Author working on PR' },
  { category: 'author_intent', pattern: /\bi can fix this\b/i, strength: 'strong', description: 'Author can fix' },
  { category: 'author_intent', pattern: /\bi(?:'d| would) like to (?:implement|work on|fix) this\b/i, strength: 'strong', description: 'Author would like to implement' },
  { category: 'author_intent', pattern: /\bi(?:'m| am) willing to (?:send|open|submit) a pr\b/i, strength: 'strong', description: 'Author willing to submit PR' },
  { category: 'author_intent', pattern: /\bi plan to (?:submit|open) a pr\b/i, strength: 'strong', description: 'Author plans PR' },
  { category: 'author_intent', pattern: /\b(?:i'll take care of this|i will take care of this)\b/i, strength: 'strong', description: 'Author taking ownership' },
];

export function matchesIntentRule(rule: IntentRule, text: string): boolean {
  const pattern = new RegExp(
    rule.pattern.source,
    rule.pattern.flags.replace(/[gy]/g, ''),
  );
  return pattern.test(text);
}

/**
 * Evaluates semantic signals in contributor discourse using multi-dimensional analysis:
 * 1. Actor perspective (first-person vs bystander)
 * 2. Commitment level (assertive vs tentative vs question)
 * 3. Artifact focus (PR/patch vs mere observation)
 * 4. Rule registry matching
 */
export function evaluateIntentSignals(
  text: string,
  category: IntentCategory,
  context: IntentEvaluationContext = {},
): IntentSignalScore {
  const trimmed = text.trim();
  if (!trimmed) {
    return { category, score: 0, isMatch: false, rationale: 'Empty text' };
  }

  // 1. Check custom & built-in rules
  const allRules = [...DEFAULT_INTENT_RULES, ...(context.customRules || [])];
  const matchingRules = allRules.filter(
    (r) => r.category === category && matchesIntentRule(r, trimmed),
  );
  if (matchingRules.length > 0) {
    const topRule = matchingRules.find((r) => r.strength === 'strong') || matchingRules[0];
    return {
      category,
      score: topRule.strength === 'strong' ? 95 : 75,
      isMatch: true,
      rationale: `Matched rule: ${topRule.description}`,
    };
  }

  // 2. Reject bystander questions or help requests for work claims/author intent
  const isBystanderQuestion = BYSTANDER_QUESTION_INDICATORS.some((p) => p.test(trimmed));
  const isHelpRequest = HELP_REQUEST_INDICATORS.some((p) => p.test(trimmed));

  if (category === 'work_claim' || category === 'author_intent') {
    if (isBystanderQuestion && !FIRST_PERSON_INDICATORS.some((p) => p.test(trimmed))) {
      return {
        category,
        score: 0,
        isMatch: false,
        rationale: 'Bystander question without first-person commitment',
      };
    }
    if (isHelpRequest) {
      return {
        category,
        score: 0,
        isMatch: false,
        rationale: 'User is requesting assistance, not offering to implement or claim',
      };
    }
  }

  // 3. Multi-Signal Semantic Composition
  const hasFirstPerson = FIRST_PERSON_INDICATORS.some((p) => p.test(trimmed));
  const hasPrNoun = PR_NOUNS.some((p) => p.test(trimmed));

  if (category === 'pr_announcement') {
    const hasPrLink = PR_LINK_PATTERNS.some((p) => p.test(trimmed));
    const hasAnnouncementVerb = ANNOUNCEMENT_VERBS.some((p) => p.test(trimmed));
    if (hasPrLink || (hasAnnouncementVerb && hasPrNoun)) {
      return {
        category,
        score: 90,
        isMatch: true,
        rationale: 'Semantic composition: PR link or announcement verb + PR noun',
      };
    }
  }

  if (category === 'approval_wait') {
    const hasWait = APPROVAL_WAIT_INDICATORS.some((p) => p.test(trimmed));
    if (hasWait) {
      return {
        category,
        score: 85,
        isMatch: true,
        rationale: 'Contributor indicates waiting on maintainer approval or LGTM protocol',
      };
    }
  }

  if (category === 'work_claim') {
    const hasBotCommand = BOT_CLAIM_COMMANDS.some((p) => p.test(trimmed));
    const hasClaimVerb = CLAIM_VERBS.some((p) => p.test(trimmed));
    if (hasBotCommand) {
      return {
        category,
        score: 100,
        isMatch: true,
        rationale: 'Explicit bot claim command (/claim or /assign)',
      };
    }
    if (hasFirstPerson && hasClaimVerb) {
      return {
        category,
        score: 85,
        isMatch: true,
        rationale: 'First-person commitment to work on or fix the issue',
      };
    }
  }

  if (category === 'author_intent') {
    const hasOfferVerb = AUTHOR_OFFER_VERBS.some((p) => p.test(trimmed));
    if ((hasFirstPerson || context.isAuthor) && (hasOfferVerb || (hasOfferVerb && hasPrNoun))) {
      return {
        category,
        score: 85,
        isMatch: true,
        rationale: 'Author expressed prospective intent or offer to resolve the issue',
      };
    }
  }

  return {
    category,
    score: 0,
    isMatch: false,
    rationale: 'No matching intent signals found',
  };
}
