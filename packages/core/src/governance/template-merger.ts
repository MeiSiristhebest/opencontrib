import { renderMasterPrTemplate } from './governance-auditor.js';

export interface PrData {
  issueNumber: number;
  problemSummary: string;
  rootCause: string;
  keyChanges: string[];
  reproductionCommand: string;
  verificationCommand: string;
  testCount: number;
  stressLoopCount?: number;
  dcoAuthorName?: string;
  dcoAuthorEmail?: string;
  conditionalAiRequired?: boolean;
}

export function buildPrDescription(data: PrData, nativeTemplateContent?: string): string {
  // If target repository provides a native template, merge into it
  if (nativeTemplateContent && nativeTemplateContent.trim().length > 10) {
    let result = nativeTemplateContent;

    // Replace common placeholder comments or sections
    result = result.replace(/<!--[\s\S]*?-->/g, ''); // strip comments

    // Inject Issue reference if found
    if (/fixes #|closes #|resolves #/i.test(result)) {
      result = result.replace(/(fixes|closes|resolves)\s+#\d*/i, `$1 #${data.issueNumber}`);
    } else {
      result = `Fixes #${data.issueNumber}\n\n` + result;
    }

    // Inject Description / Motivation
    if (/## description|## summary|## motivation|### description/i.test(result)) {
      result = result.replace(
        /(##\s*(?:description|summary|motivation)[\s\S]*?)(?=##|$)/i,
        `$1\n${data.problemSummary}\n\n**Root Cause**: ${data.rootCause}\n\n**Key Changes**:\n${data.keyChanges.map((c) => `- ${c}`).join('\n')}\n\n`,
      );
    }

    // Inject Verification / Test Plan
    if (/## test plan|## verification|## how has this been tested|### test plan/i.test(result)) {
      result = result.replace(
        /(##\s*(?:test plan|verification|how has this been tested)[\s\S]*?)(?=##|$)/i,
        `$1\n- Reproduction: \`${data.reproductionCommand}\`\n- Verification: \`${data.verificationCommand}\`\n- Test Suite: ${data.testCount} tests passed\n\n`,
      );
    }

    return result.trim();
  }

  // Fallback to our clean Master PR Template
  return renderMasterPrTemplate(data);
}
