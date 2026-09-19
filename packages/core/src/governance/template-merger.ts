import type { PrTemplateEvidence } from "./governance-auditor.js";
import { renderMasterPrTemplate } from "./governance-auditor.js";

export interface PrData {
  issueNumber: number;
  problemSummary: string;
  rootCause: string;
  keyChanges: string[];
  verificationCommand?: string;
  stressLoopCount?: number;
  dcoAuthorName?: string;
  dcoAuthorEmail?: string;
  conditionalAiRequired?: boolean;
  evidence?: PrTemplateEvidence;
}

export function buildPrDescription(
  data: PrData,
  nativeTemplateContent?: string,
): string {
  // Keep native and fallback rendering on the same evidence-backed path.
  return renderMasterPrTemplate({
    ...data,
    nativeTemplateContent,
  });
}
