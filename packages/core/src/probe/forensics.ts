import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface FileHotspotMetric {
  file: string;
  commitsCount: number;
  linesOfCode: number;
  cyclomaticComplexity: number;
  hotspotScore: number; // commitsCount * cyclomaticComplexity
  riskLevel: 'critical' | 'high' | 'medium' | 'low';
  riskScore: number; // 0 - 100 heuristic risk index
  topContributors: string[];
}

export interface HotspotAnalysisResult {
  repoPath: string;
  totalFilesAnalyzed: number;
  topHotspots: FileHotspotMetric[];
  summary: string;
}

export function analyzeGitHotspots(
  repoPath: string,
  options: { limit?: number; sinceMonths?: number } = {},
): HotspotAnalysisResult {
  const resolved = path.resolve(repoPath);
  const limit = options.limit || 10;
  const sinceMonths = options.sinceMonths || 6;

  const sinceDate = new Date();
  sinceDate.setMonth(sinceDate.getMonth() - sinceMonths);
  const sinceStr = sinceDate.toISOString().split('T')[0];

  // 1. Calculate commit churn per file from git log
  const churnMap = new Map<string, { commits: number; authors: Set<string> }>();

  try {
    const gitLog = execSync(
      `git log --since="${sinceStr}" --name-only --format="COMMIT:%an"`,
      { cwd: resolved, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
    );

    let currentAuthor = 'Unknown';
    for (const line of gitLog.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('COMMIT:')) {
        currentAuthor = trimmed.substring(7);
      } else {
        const filePath = trimmed;
        // Ignore assets, tests, markdown, lockfiles, node_modules, build artifacts
        if (
          filePath.endsWith('.md') ||
          filePath.endsWith('.png') ||
          filePath.endsWith('.svg') ||
          filePath.endsWith('.json') ||
          filePath.endsWith('.lock') ||
          filePath.includes('.git') ||
          filePath.includes('node_modules') ||
          filePath.includes('dist/') ||
          filePath.includes('dist\\') ||
          filePath.includes('build/') ||
          filePath.includes('vendor/')
        ) {
          continue;
        }

        const fullPath = path.join(resolved, filePath);
        if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
          if (!churnMap.has(filePath)) {
            churnMap.set(filePath, { commits: 0, authors: new Set() });
          }
          const entry = churnMap.get(filePath)!;
          entry.commits++;
          entry.authors.add(currentAuthor);
        }
      }
    }
  } catch {
    // If not a git repo or git fails, analyze all code files in directory
  }

  // 2. Compute lines of code and estimated cyclomatic complexity
  const metrics: FileHotspotMetric[] = [];

  for (const [file, data] of churnMap.entries()) {
    const fullPath = path.join(resolved, file);
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');
      const loc = lines.length;

      const complexity = estimateCyclomaticComplexity(content);
      const hotspotScore = data.commits * complexity;

      let riskLevel: 'critical' | 'high' | 'medium' | 'low' = 'low';
      let riskScore = Math.min(Math.round((hotspotScore / 250) * 100), 98);

      if (hotspotScore > 400 || (data.commits > 15 && complexity > 25)) {
        riskLevel = 'critical';
        riskScore = Math.max(riskScore, 90);
      } else if (hotspotScore > 150 || data.commits > 8) {
        riskLevel = 'high';
        riskScore = Math.max(riskScore, 75);
      } else if (hotspotScore > 50) {
        riskLevel = 'medium';
        riskScore = Math.max(riskScore, 50);
      }

      metrics.push({
        file,
        commitsCount: data.commits,
        linesOfCode: loc,
        cyclomaticComplexity: complexity,
        hotspotScore,
        riskLevel,
        riskScore,
        topContributors: Array.from(data.authors).slice(0, 3),
      });
    } catch {
      // Ignore unreadable files
    }
  }

  const sorted = metrics.sort((a, b) => b.hotspotScore - a.hotspotScore).slice(0, limit);

  return {
    repoPath: resolved,
    totalFilesAnalyzed: churnMap.size,
    topHotspots: sorted,
    summary:
      sorted.length > 0
        ? `Identified ${sorted.length} high-risk code hotspot(s). Top hotspot is '${sorted[0].file}' (Score: ${sorted[0].hotspotScore}, Risk Score: ${sorted[0].riskScore}/100).`
        : 'No high-churn hotspots detected in the given time window.',
  };
}

function estimateCyclomaticComplexity(content: string): number {
  let complexity = 1;
  const branchingPatterns = [
    /\bif\b/g,
    /\belse\s+if\b/g,
    /\bfor\b/g,
    /\bwhile\b/g,
    /\bcase\b/g,
    /\bcatch\b/g,
    /\b&&/g,
    /\|\|/g,
    /\?/g, // ternary
    /\bguard\b/g,
    /\bmatch\b/g,
  ];

  for (const pattern of branchingPatterns) {
    const matches = content.match(pattern);
    if (matches) {
      complexity += matches.length;
    }
  }

  return complexity;
}
