import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type {
  ProbeNegotiationPlan,
  ProbeRunResult,
  NormalizedFinding,
  ProbeManifest,
  DefectCategory,
} from './types.js';
import { analyzeGitHotspots } from './forensics.js';
import { generatePropertyTest } from './fuzz-generator.js';

function execWithSpawn(cmd: string, opts: { cwd?: string; timeout?: number; maxBuffer?: number }): Promise<{ stdout: string; stderr: string }> {
  const cwd = opts.cwd || process.cwd();
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : 'sh';
    const shellArgs = isWindows ? ['/c', cmd] : ['-c', cmd];
    const child = spawn(shell, shellArgs, {
      cwd,
      timeout: opts.timeout || 30000,
      encoding: 'utf-8',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code: number | null) => {
      if (code !== 0) reject(new Error(stderr || `Command exited with code ${code}: ${cmd}`));
      else resolve({ stdout, stderr });
    });
  });
}

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
      if (probe.name === 'workflow-linter' || probe.execution.transformer === 'builtin:workflow') {
        const wfFindings = await runBuiltinWorkflowLinter(targetPath);
        findings.push(...wfFindings);
      } else if (probe.name === 'git-hotspot' || probe.execution.transformer === 'builtin:hotspot') {
        const hotspotResult = analyzeGitHotspots(targetPath, { limit: 5 });
        for (const h of hotspotResult.topHotspots) {
          if (h.riskLevel === 'critical' || h.riskLevel === 'high') {
            findings.push({
              id: `hotspot-${h.file.replace(/[^a-zA-Z0-9]/g, '_')}`,
              probeName: 'git-hotspot',
              category: 'lifecycle_leak',
              title: `High-Risk Defect Hotspot: ${h.file} (Score: ${h.hotspotScore})`,
              description: `File has ${h.commitsCount} recent commits and cyclomatic complexity ${h.cyclomaticComplexity}. High likelihood (${h.defectLikelihood}%) of concurrency/boundary bugs.`,
              file: h.file,
              line: 1,
              severity: h.riskLevel === 'critical' ? 'high' : 'medium',
              remediation: `Focus exploration on '${h.file}', inspect recent diffs by ${h.topContributors.join(', ')}.`,
              prPotentialScore: Math.min(80 + Math.round(h.hotspotScore / 10), 98),
            });
          }
        }
      } else if (probe.name === 'property-fuzz' || probe.execution.transformer === 'builtin:fuzz') {
        const lang = (plan.fingerprint.primaryLanguage.toLowerCase() || 'typescript') as any;
        const fuzzSpec = generatePropertyTest('numerical_bounds', ['typescript', 'javascript', 'python', 'rust', 'go'].includes(lang) ? lang : 'typescript');
        findings.push({
          id: `fuzz-numerical-bounds`,
          probeName: 'property-fuzz',
          category: 'numerical_bounds',
          title: `Property-Based Invariant Verification: ${fuzzSpec.framework}`,
          description: `Generated property fuzzing harness targeting NaN/-0.0/Inf boundary attacks.`,
          file: 'tests/property_bounds.test',
          line: 1,
          severity: 'medium',
          pocSnippet: fuzzSpec.codeSnippet,
          prPotentialScore: 90,
        });
      } else if (probe.execution.command) {
        // Execute external probe command
        const formattedCmd = probe.execution.command
          .replace('{target}', `"${targetPath}"`)
          .replace('{outputJson}', '');

        try {
          const { stdout } = await execWithSpawn(formattedCmd, {
            cwd: targetPath,
            timeout: probe.execution.timeoutMs || timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
          });

          const parsed = parseProbeOutput(probe, stdout, targetPath);
          findings.push(...parsed);
        } catch (err: any) {
          if (err.stdout) {
            const parsed = parseProbeOutput(probe, err.stdout, targetPath);
            findings.push(...parsed);
            // Record partial failure even when some output was recovered
            if (parsed.length > 0) {
              failedProbes.push({
                name: probe.name,
                error: `Partial failure (recovered ${parsed.length} finding(s)): ${err.message || String(err)}`,
              });
            } else {
              failedProbes.push({
                name: probe.name,
                error: err.message || String(err),
              });
            }
            continue;
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

      // Check actions/setup-node@v1, v2 or v3
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

    // 3. Knip transformer
    else if (probe.name === 'knip' && (data.files || data.unused)) {
      const unusedFiles = data.files || [];
      for (const uf of unusedFiles) {
        findings.push({
          id: `knip-unused-${uf.replace(/[^a-zA-Z0-9]/g, '_')}`,
          probeName: 'knip',
          category: 'dead_code',
          title: `Dead Code / Unused File: ${uf}`,
          description: 'File is not imported by any entry point or module in project.',
          file: uf,
          line: 1,
          severity: 'low',
          remediation: `Remove dead file ${uf}`,
          prPotentialScore: 82,
        });
      }
    }

    // 4. Ruff transformer
    else if (probe.name === 'ruff' && Array.isArray(data)) {
      for (const item of data) {
        findings.push({
          id: `ruff-${item.code}-${item.filename}-${item.location?.row || 1}`,
          probeName: 'ruff',
          category: mapToDefectCategory(item.code || 'protocol_drift'),
          title: `[${item.code}] ${item.message}`,
          description: item.message || '',
          file: path.relative(targetPath, item.filename || ''),
          line: item.location?.row || 1,
          column: item.location?.column,
          severity: 'medium',
          ruleId: item.code,
          remediation: item.fix?.message,
          prPotentialScore: item.code.startsWith('B') || item.code.startsWith('ASYNC') ? 90 : 80,
        });
      }
    }

    // 5. Generic JSON with findings array
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
  if (lower.includes('leak') || lower.includes('resource') || lower.includes('goroutine')) return 'lifecycle_leak';
  if (lower.includes('race') || lower.includes('concurrency') || lower.includes('thread')) return 'lifecycle_leak';
  if (lower.includes('cache') || lower.includes('stampede')) return 'distributed_cache';
  if (lower.includes('abi') || lower.includes('memory') || lower.includes('unsafe') || lower.includes('ffi')) return 'memory_abi';
  if (lower.includes('performance') || lower.includes('dos') || lower.includes('backpressure') || lower.includes('redos')) return 'performance_backpressure';
  if (lower.includes('time') || lower.includes('clock') || lower.includes('dst')) return 'time_monotonicity';
  if (lower.includes('escape') || lower.includes('gc')) return 'escape_analysis';
  if (lower.includes('bound') || lower.includes('overflow') || lower.includes('nan') || lower.includes('crlf')) return 'numerical_bounds';
  if (lower.includes('dead') || lower.includes('unused')) return 'dead_code';
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
