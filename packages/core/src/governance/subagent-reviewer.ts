import type { ConfidenceBreakdown, GovernanceAuditResult } from '../contracts/schemas.js';
import { buildDynamicReviewPrompt } from '../llm/prompt-engine.js';

export type SubagentReviewStatus = 'SUCCESS' | 'UNAVAILABLE' | 'FAILED';

export interface SubagentReviewEvaluation {
  status: SubagentReviewStatus;
  maintainerPerspective?: {
    acceptanceLikelihood: 'HIGH' | 'MEDIUM' | 'LOW';
    styleConformance: string;
    concerns: string[];
  };
  securityPerspective?: {
    vulnerabilitiesDetected: boolean;
    findings: string[];
  };
  qaPerspective?: {
    testAdequacy: string;
    flakyRisk: string;
  };
  confidenceBreakdown?: ConfidenceBreakdown;
  failureReason?: string;
}

export function generateSubagentReviewPrompt(data: {
  repoFullName: string;
  issueTitle: string;
  issueBody: string;
  diffText: string;
  testEvidence: string;
  language?: string;
  defectDomain?: string;
}): string {
  return buildDynamicReviewPrompt(data);
}
