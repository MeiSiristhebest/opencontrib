import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import type {
  ProbeNegotiationPlan,
  ProbeRunResult,
  NormalizedFinding,
  ProbeManifest,
  DefectCategory,
} from './types.js';

const execAsync = promisify(exec);

export interface RunOptions {
  timeoutMs?: number;
  concurrency?: number;
  minScore?: number;
}

export async function runProbes(
  plan: ProbeNegotiationPlan,
  options: RunOptions = {},
): Promise<ProbeRunResult> {
  const executedProbes: string[] = [];
  const failedProbes: Array<{ name: string; error: string }> = [];
  const findings: NormalizedFinding[] = [];

  const targetPath = plan.target;
  const timeoutMs = options.timeoutMs || 30000;

  for (const probe of plan.selectedProbes) {
    executedProbes.push(probe.name);
    try {
      if (probe.execution.transformer === 'builtin:workflow' || probe.name === 'workflow-linter') {
        const wfFindings = await runBuiltinWorkflowLinter(targetPath);
        findings.push(...wfFindings);
      } else if (probe.execution.command) {
        // Execute external probe command
        const formattedCmd = probe.execution.command
          .replace('{target}', `"${targetPath}"`)
          .replace('{outputJson}', '');

        try {
          const { stdout } = await execAsync(formattedCmd, {
            cwd: targetPath,
            timeout: probe.execution.timeoutMs || timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
          });

          const parsed = parseProbeOutput(probe, stdout, targetPath);
          findings.push(...parsed);
        } catch (err: any) {
          // Many linters exit with code 1/2 when issues are found, but still output valid JSON
          if (err.stdout) {
            const parsed = parseProbeOutput(probe, err.stdout, targetPath);
            if (parsed.length > 0) {
              findings.push(...parsed);
              continue;
            }
          }
          failedProbes.push({
            name: probe.name,
            error: err.message || String(err),
          });
        }
      }
    } catch (err: any) {
      failedProbes.push({
        name: probe.name,
        error: err.message || String(err),
      });
    }
  }

  // Filter by minScore if provided
  const minScore = options.minScore || 0;
  const filteredFindings = findings.filter((f) => f.prPotentialScore >= minScore);

  // Group summary by category
  const summaryByCategory: Record<string, number> = {};
  for (const f of filteredFindings) {
    summaryByCategory[f.category] = (summaryByCategory[f.category] || 0) + 1;
  }

  return {
    target: targetPath,
    timestamp: new Date().toISOString(),
    fingerprint: plan.fingerprint,
    executedProbes,
    failedProbes,
    findingsCount: filteredFindings.length,
    findings: filteredFindings.sort((a, b) => b.prPotentialScore - a.prPotentialScore),
    summaryByCategory,
  };
}

async function runBuiltinWorkflowLinter(targetPath: string): Promise<NormalizedFinding[]> {
  const findings: NormalizedFinding[] = [];
  const workflowsDir = path.join(targetPath, '.github', 'workflows');

  if (!fs.existsSync(workflowsDir)) return findings;

  try {
    const files = fs.readdirSync(workflowsDir);
    for (const file of files) {
      if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
      const relPath = path.join('.github', 'workflows', file);
      const fullPath = path.join(workflowsDir, file);
      const content = fs.readFileSync(fullPath, 'utf8');

      // Check actions/checkout@v2 or v3
      if (content.includes('actions/checkout@v2') || content.includes('actions/checkout@v3')) {
        const line = findLineNumber(content, 'actions/checkout@v');
        findings.push({
          id: `ci-checkout-${file.replace(/[^a-zA-Z0-9]/g, '_')}`,
          probeName: 'workflow-linter',
          category: 'ci_workflow',
          title: `Upgrade deprecated actions/checkout in ${file}`,
          description: 'Workflow uses outdated actions/checkout@v2 or v3 which may fail on modern Node runtimes.',
          file: relPath,
          line,
          severity: 'medium',
          remediation: 'Upgrade to actions/checkout@v4',
          pocSnippet: 'Verify workflow triggers with v4 checkout',
          prPotentialScore: 92,
        });
      }

      // Check actions/setup-node@v1 or v2
      if (content.includes('actions/setup-node@v1') || content.includes('actions/setup-node@v2') || content.includes('actions/setup-node@v3')) {
        const line = findLineNumber(content, 'actions/setup-node@v');
        findings.push({
          id: `ci-setup-node-${file.replace(/[^a-zA-Z0-9]/g, '_')}`,
          probeName: 'workflow-linter',
          category: 'ci_workflow',
          title: `Upgrade deprecated actions/setup-node in ${file}`,
          description: 'Workflow uses deprecated setup-node version.',
          file: relPath,
          line,
          severity: 'low',
          remediation: 'Upgrade to actions/setup-node@v4',
          prPotentialScore: 88,
        });
      }
    }
  } catch {
    // Ignore read errors
  }

  return findings;
}

function parseProbeOutput(probe: ProbeManifest, stdout: string, targetPath: string): NormalizedFinding[] {
  const findings: NormalizedFinding[] = [];
  if (!stdout || stdout.trim() === '') return findings;

  try {
    const data = JSON.parse(stdout);

    // 1. Semgrep transformer
    if (probe.name === 'semgrep' && Array.isArray(data.results)) {
      for (const res of data.results) {
        findings.push({
          id: `semgrep-${res.check_id}-${res.start?.line || 1}`,
          probeName: 'semgrep',
          category: mapToDefectCategory(res.extra?.metadata?.category || 'security'),
          title: res.extra?.message || `Semgrep finding: ${res.check_id}`,
          description: res.extra?.metadata?.summary || res.extra?.message || '',
          file: path.relative(targetPath, res.path || ''),
          line: res.start?.line || 1,
          column: res.start?.col,
          endLine: res.end?.line,
          severity: mapSeverity(res.extra?.severity),
          cwe: res.extra?.metadata?.cwe?.[0],
          ruleId: res.check_id,
          prPotentialScore: res.extra?.severity === 'ERROR' ? 95 : 85,
        });
      }
    }

    // 2. OSV-Scanner transformer
    else if (probe.name === 'osv-scanner' && Array.isArray(data.results)) {
      for (const res of data.results) {
        for (const pkg of res.packages || []) {
          for (const vuln of pkg.vulnerabilities || []) {
            findings.push({
              id: `osv-${vuln.id}`,
              probeName: 'osv-scanner',
              category: 'security_cwe',
              title: `Vulnerable dependency: ${pkg.package?.name}@${pkg.package?.version} (${vuln.id})`,
              description: vuln.summary || vuln.details || 'Known vulnerability reported in OSV database.',
              file: path.relative(targetPath, res.source?.path || 'package.json'),
              line: 1,
              severity: 'high',
              cwe: vuln.aliases?.[0],
              ruleId: vuln.id,
              remediation: `Upgrade ${pkg.package?.name} to fixed version`,
              prPotentialScore: 90,
            });
          }
        }
      }
    }

    // 3. Generic JSON with findings array
    else if (Array.isArray(data.findings)) {
      for (const f of data.findings) {
        findings.push({
          id: f.id || `${probe.name}-${Math.random().toString(36).slice(2, 8)}`,
          probeName: probe.name,
          category: f.category || probe.category,
          title: f.title || f.message || 'Probe finding',
          description: f.description || '',
          file: f.file || '',
          line: f.line || 1,
          severity: f.severity || 'medium',
          prPotentialScore: f.prPotentialScore || 85,
        });
      }
    }
  } catch {
    // Non-JSON stdout - try line by line matching
    const lines = stdout.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.includes(': error:') || line.includes(': warning:')) {
        findings.push({
          id: `${probe.name}-line-${i + 1}`,
          probeName: probe.name,
          category: probe.category,
          title: line,
          description: line,
          file: line.split(':')[0] || '',
          line: parseInt(line.split(':')[1], 10) || 1,
          severity: line.includes('error') ? 'high' : 'medium',
          prPotentialScore: 80,
        });
      }
    }
  }

  return findings;
}

function mapToDefectCategory(cat: string): DefectCategory {
  const lower = cat.toLowerCase();
  if (lower.includes('leak') || lower.includes('resource')) return 'lifecycle_leak';
  if (lower.includes('race') || lower.includes('concurrency')) return 'lifecycle_leak';
  if (lower.includes('cache')) return 'distributed_cache';
  if (lower.includes('abi') || lower.includes('memory')) return 'memory_abi';
  if (lower.includes('performance') || lower.includes('dos')) return 'performance_backpressure';
  if (lower.includes('time') || lower.includes('clock')) return 'time_monotonicity';
  if (lower.includes('escape') || lower.includes('gc')) return 'escape_analysis';
  if (lower.includes('bound') || lower.includes('overflow') || lower.includes('nan')) return 'numerical_bounds';
  return 'security_cwe';
}

function mapSeverity(sev?: string): 'low' | 'medium' | 'high' | 'critical' {
  if (!sev) return 'medium';
  const s = sev.toUpperCase();
  if (s === 'ERROR' || s === 'CRITICAL') return 'high';
  if (s === 'WARNING') return 'medium';
  return 'low';
}

function findLineNumber(content: string, substring: string): number {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(substring)) {
      return i + 1;
    }
  }
  return 1;
}
