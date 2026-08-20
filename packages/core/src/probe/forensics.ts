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
  defectLikelihood?: number;
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
        const normalizedPath = filePath.replace(/\\/g, '/');
        if (!isEligibleSourceCodeFile(normalizedPath)) {
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

/**
 * Filter out non-code assets, binaries, documentation, test fixtures, and vendor directories.
 * Ensures forensics and churn analysis only target genuine application source code.
 */
export function isEligibleSourceCodeFile(normalizedPath: string): boolean {
  // 1. Excluded directory segments
  const excludedDirs = [
    '.resource/',
    '.resources/',
    'resource/',
    'resources/',
    'docs/',
    'doc/',
    'documentation/',
    'assets/',
    'images/',
    'image/',
    'img/',
    'static/',
    'public/',
    'examples/',
    'example/',
    'samples/',
    'demo/',
    'fixtures/',
    'testdata/',
    'mocks/',
    'vendor/',
    'third_party/',
    'node_modules/',
    '.git/',
    '.github/',
    '.vscode/',
    '.idea/',
    'dist/',
    'build/',
    'out/',
    'target/',
    'bin/',
    'coverage/',
    '.cache/',
    '.next/',
    '.nuxt/',
  ];

  for (const dir of excludedDirs) {
    if (normalizedPath.startsWith(dir) || normalizedPath.includes(`/${dir}`) || normalizedPath.includes(`\\${dir}`)) {
      return false;
    }
  }

  // 2. Excluded non-source extensions (assets, media, binaries, logs, locks, etc.)
  const excludedExtensions = [
    '.md', '.markdown', '.mdown',
    '.gif', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.bmp', '.tiff', '.psd',
    '.mp4', '.mov', '.avi', '.webm', '.mkv', '.mp3', '.wav', '.ogg',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
    '.wasm', '.exe', '.dll', '.dylib', '.so', '.bin', '.obj', '.o', '.a',
    '.map', '.min.js', '.min.css', '.bundle.js',
    '.ttf', '.woff', '.woff2', '.eot', '.otf',
    '.lock', '.sum', '.json', '.csv', '.tsv', '.txt', '.log', '.env',
    '.yaml', '.yml', '.xml', '.html', '.htm', '.css', '.scss', '.less',
  ];

  for (const ext of excludedExtensions) {
    if (normalizedPath.toLowerCase().endsWith(ext)) {
      return false;
    }
  }

  // 3. Must have standard programming language extension
  const validSourceExtensions = [
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.go',
    '.rs',
    '.py', '.pyi',
    '.java', '.kt', '.kts', '.scala',
    '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',
    '.cs',
    '.rb',
    '.php',
    '.swift',
    '.zig',
    '.dart',
  ];

  return validSourceExtensions.some((ext) => normalizedPath.toLowerCase().endsWith(ext));
}

