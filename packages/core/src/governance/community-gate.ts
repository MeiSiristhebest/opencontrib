import * as fs from 'fs';
import * as path from 'path';

export interface CommunityGatePolicy {
  hasGatingRules: boolean;
  requiresIssueApprovalBeforePr: boolean;
  autoClosesNewIssues: boolean;
  hasLgtmApprovalProtocol: boolean;
  restrictedTriageHours: boolean;
  maxDiffCeiling?: number;
  reasons: string[];
  suggestedContributorAction: string;
  matchedKeywords: string[];
}

const ISSUE_APPROVAL_PATTERNS = [
  /auto-closed by default/i,
  /auto-close/i,
  /reopen worthwhile ones/i,
  /\blgtmi\b/i,
  /\blgtm\b.*issue/i,
  /approval happens through maintainer/i,
  /wait for (?:maintainer|author|triager) (?:approval|response|review|reopen)/i,
  /do not (?:open|submit|create) a pr until/i,
  /discuss in (?:an )?issue before (?:opening|submitting) (?:a )?pr/i,
  /issues? first/i,
  /must be approved before/i,
];

const AUTO_CLOSE_PATTERNS = [
  /auto-closed by default/i,
  /new issues.*auto-closed/i,
  /bot.*automatically close/i,
  /will be closed automatically/i,
];

const LGTM_PROTOCOL_PATTERNS = [
  /\blgtmi\b/i,
  /\blgtm\b.*approved/i,
  /approved-contributors/i,
];

const RESTRICTED_HOURS_PATTERNS = [
  /friday through sunday/i,
  /weekend.*not guaranteed/i,
  /working hours/i,
  /review queue.*monday/i,
];

/**
 * Scan repository root and .github directory for contribution guidelines and gate policies.
 */
export async function detectCommunityGate(repoPath: string): Promise<CommunityGatePolicy> {
  const resolved = path.resolve(repoPath);
  const reasons: string[] = [];
  const matchedKeywords: string[] = [];

  let requiresIssueApprovalBeforePr = false;
  let autoClosesNewIssues = false;
  let hasLgtmApprovalProtocol = false;
  let restrictedTriageHours = false;
  let maxDiffCeiling: number | undefined = undefined;

  const candidateFiles = [
    'CONTRIBUTING.md',
    'CONTRIBUTING',
    'contributing.md',
    '.github/CONTRIBUTING.md',
    '.github/contributing.md',
    'AGENTS.md',
    '.github/AGENTS.md',
    'SECURITY.md',
    '.github/SECURITY.md',
    '.github/ISSUE_TEMPLATE/bug.yml',
    '.github/ISSUE_TEMPLATE/bug.yaml',
    '.github/ISSUE_TEMPLATE/bug_report.md',
  ];

  let combinedContent = '';

  for (const relPath of candidateFiles) {
    const fullPath = path.join(resolved, relPath);
    if (fs.existsSync(fullPath)) {
      try {
        const text = fs.readFileSync(fullPath, 'utf8');
        combinedContent += `\n--- ${relPath} ---\n` + text;
      } catch {
        // Ignore read errors
      }
    }
  }

  if (!combinedContent.trim()) {
    return {
      hasGatingRules: false,
      requiresIssueApprovalBeforePr: false,
      autoClosesNewIssues: false,
      hasLgtmApprovalProtocol: false,
      restrictedTriageHours: false,
      reasons: ['No CONTRIBUTING.md or community governance files detected.'],
      suggestedContributorAction: 'Follow standard Issue-First workflow and create PR with linked issue.',
      matchedKeywords: [],
    };
  }

  // 1. Check for Issue Approval Requirements
  for (const pattern of ISSUE_APPROVAL_PATTERNS) {
    const match = combinedContent.match(pattern);
    if (match) {
      requiresIssueApprovalBeforePr = true;
      matchedKeywords.push(match[0]);
    }
  }

  // 2. Check for Auto-Close
  for (const pattern of AUTO_CLOSE_PATTERNS) {
    const match = combinedContent.match(pattern);
    if (match) {
      autoClosesNewIssues = true;
      matchedKeywords.push(match[0]);
    }
  }

  // 3. Check for LGTM / Whitelist protocol
  for (const pattern of LGTM_PROTOCOL_PATTERNS) {
    const match = combinedContent.match(pattern);
    if (match) {
      hasLgtmApprovalProtocol = true;
      matchedKeywords.push(match[0]);
    }
  }

  // 4. Check for Weekend / Restricted triage hours
  for (const pattern of RESTRICTED_HOURS_PATTERNS) {
    const match = combinedContent.match(pattern);
    if (match) {
      restrictedTriageHours = true;
      matchedKeywords.push(match[0]);
    }
  }

  // 5. Check for explicit line diff ceilings (e.g., "PRs over 100 lines")
  const diffMatch = combinedContent.match(/(\d+)\s*(?:lines|loc)\s*(?:limit|ceiling|max)/i);
  if (diffMatch) {
    maxDiffCeiling = parseInt(diffMatch[1], 10);
  }

  // Assemble reasons and recommendations
  if (autoClosesNewIssues) {
    reasons.push('Repository automatically closes new contributor issues until maintainer reviews daily triage.');
  }
  if (hasLgtmApprovalProtocol) {
    reasons.push('Repository uses an explicit lgtmi / lgtm contributor gating protocol.');
  }
  if (requiresIssueApprovalBeforePr) {
    reasons.push('Maintainer approval (reopen / lgtmi reply) is strictly required BEFORE creating a Pull Request.');
  }
  if (restrictedTriageHours) {
    reasons.push('Weekend or non-working-hour triage delays apply; issues may queue until regular working hours.');
  }

  const hasGatingRules = requiresIssueApprovalBeforePr || autoClosesNewIssues || hasLgtmApprovalProtocol;

  let suggestedContributorAction = 'Proceed with standard Issue creation and PR submission.';
  if (requiresIssueApprovalBeforePr || autoClosesNewIssues) {
    suggestedContributorAction =
      'Create GitHub Issue first. PAUSE pipeline and wait for maintainer to reopen or comment "lgtmi" before submitting PR.';
  }

  return {
    hasGatingRules,
    requiresIssueApprovalBeforePr,
    autoClosesNewIssues,
    hasLgtmApprovalProtocol,
    restrictedTriageHours,
    maxDiffCeiling,
    reasons,
    suggestedContributorAction,
    matchedKeywords: Array.from(new Set(matchedKeywords)),
  };
}
