import { exec } from 'child_process';
import { promisify } from 'util';
import type { NormalizedFinding } from '../types.js';

const execAsync = promisify(exec);

export interface OCRDelegateRule {
  file: string;
  matchedRules: string[];
  suggestedChecks: string[];
}

export async function runOCRScan(targetPath: string): Promise<NormalizedFinding[]> {
  const findings: NormalizedFinding[] = [];
  try {
    const { stdout } = await execAsync(`ocr scan --path "${targetPath}" --json`, {
      cwd: targetPath,
      maxBuffer: 10 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed.comments)) {
      for (const comment of parsed.comments) {
        findings.push({
          id: `ocr-${comment.file}-${comment.line}`,
          probeName: 'ocr',
          category: comment.ruleType?.includes('concurrency') ? 'lifecycle_leak' : 'protocol_drift',
          title: comment.title || comment.ruleName || 'OCR Defect Alert',
          description: comment.content || comment.suggestion || '',
          file: comment.file,
          line: comment.line || 1,
          severity: comment.severity === 'critical' ? 'critical' : 'high',
          ruleId: comment.ruleId,
          remediation: comment.suggestion,
          prPotentialScore: 92,
        });
      }
    }
  } catch {
    // Return empty if ocr is not installed or fails
  }
  return findings;
}

export async function runOCRDelegateRules(targetPath: string, files: string[]): Promise<OCRDelegateRule[]> {
  const rules: OCRDelegateRule[] = [];
  if (files.length === 0) return rules;

  try {
    const fileArgs = files.map((f) => `"${f}"`).join(' ');
    const { stdout } = await execAsync(`ocr delegate rule ${fileArgs}`, {
      cwd: targetPath,
    });
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed.rules)) {
      return parsed.rules;
    }
  } catch {
    // Fallback: heuristic rules
    for (const f of files) {
      if (f.endsWith('.go')) {
        rules.push({
          file: f,
          matchedRules: ['npe_check', 'goroutine_leak', 'context_cancellation'],
          suggestedChecks: ['Verify nil pointer checks', 'Ensure context is propagated'],
        });
      } else if (f.endsWith('.ts') || f.endsWith('.js')) {
        rules.push({
          file: f,
          matchedRules: ['async_unhandled_rejection', 'nullish_coalescing_drift'],
          suggestedChecks: ['Verify promise catch handlers', 'Check falsy values in cache'],
        });
      }
    }
  }
  return rules;
}
