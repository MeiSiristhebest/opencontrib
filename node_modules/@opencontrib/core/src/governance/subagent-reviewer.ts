import type { ConfidenceBreakdown, GovernanceAuditResult } from '../contracts/schemas.js';

export interface SubagentReviewEvaluation {
  maintainerPerspective: {
    acceptanceLikelihood: 'HIGH' | 'MEDIUM' | 'LOW';
    styleConformance: string;
    concerns: string[];
  };
  securityPerspective: {
    vulnerabilitiesDetected: boolean;
    findings: string[];
  };
  qaPerspective: {
    testAdequacy: string;
    flakyRisk: string;
  };
  confidenceBreakdown: ConfidenceBreakdown;
}

export function generateSubagentReviewPrompt(data: {
  repoFullName: string;
  issueTitle: string;
  issueBody: string;
  diffText: string;
  testEvidence: string;
}): string {
  return `You are acting as an independent Maintainer Reviewer for the repository ${data.repoFullName}.
Please critically evaluate the proposed Pull Request from 3 independent angles:

### 1. Maintainer Persona (Code Hygiene & Minimal Scope)
- Does this PR solve the root cause surgically (under 100 lines)?
- Does it follow the target repository's established style and conventions?
- Is the tone natural, humble, and devoid of robotic AI fluff?

### 2. Security Reviewer Persona
- Are there any injection, resource leak, or memory leak risks?
- Are edge cases and bounds protected?

### 3. QA / Test Engineer Persona
- Is the empirical evidence adequate (stress loops, baseline comparisons)?
- Are regression tests included?

### Target Context:
- **Issue**: ${data.issueTitle}
- **Issue Body**: ${data.issueBody}
- **Proposed Diff**:
\`\`\`diff
${data.diffText}
\`\`\`
- **Test Evidence**:
${data.testEvidence}

### Scoring Output:
Evaluate and return the 7-dimension confidence breakdown (0-100 for each):
- rootCause (25% weight)
- implementation (25% weight)
- regression (20% weight)
- defensiveCoverage (10% weight)
- testCoverage (10% weight)
- styleMatch (5% weight)
- securityAudit (5% weight)
`;
}
