import * as fs from 'fs';
import * as path from 'path';
import type { RepoFingerprint, RepoLanguageInfo } from './types.js';

const EXTENSION_MAP: Record<string, string> = {
  '.go': 'Go',
  '.rs': 'Rust',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.pyw': 'Python',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.c': 'C',
  '.cpp': 'C++',
  '.cc': 'C++',
  '.cxx': 'C++',
  '.h': 'C/C++ Header',
  '.hpp': 'C/C++ Header',
  '.cs': 'C#',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.sol': 'Solidity',
  '.swift': 'Swift',
  '.dart': 'Dart',
};

const MANIFEST_FILES = [
  'go.mod',
  'Cargo.toml',
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'CMakeLists.txt',
  'Makefile',
  'Gemfile',
  'composer.json',
  'foundry.toml',
  'hardhat.config.js',
  'hardhat.config.ts',
];

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '.next',
  '.nuxt',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.opencontrib',
]);

export async function extractRepoFingerprint(repoPath: string): Promise<RepoFingerprint> {
  const resolvedPath = path.resolve(repoPath);

  const langCountMap: Record<string, number> = {};
  const manifestsFound: string[] = [];
  const frameworksFound = new Set<string>();
  let hasTests = false;
  let hasWorkflows = false;
  let totalFiles = 0;

  if (!fs.existsSync(resolvedPath)) {
    return {
      repoPath: resolvedPath,
      primaryLanguage: 'unknown',
      languages: [],
      manifests: [],
      frameworks: [],
      hasTests: false,
      hasWorkflows: false,
      totalFiles: 0,
    };
  }

  // 1. Direct check for root manifests
  for (const manifest of MANIFEST_FILES) {
    if (fs.existsSync(path.join(resolvedPath, manifest))) {
      manifestsFound.push(manifest);
    }
  }

  // 2. Check for CI workflows
  const workflowsDir = path.join(resolvedPath, '.github', 'workflows');
  if (fs.existsSync(workflowsDir)) {
    try {
      const files = fs.readdirSync(workflowsDir);
      if (files.some((f) => f.endsWith('.yml') || f.endsWith('.yaml'))) {
        hasWorkflows = true;
        manifestsFound.push('.github/workflows');
      }
    } catch {
      // Ignore directory read errors
    }
  }

  // 3. Inspect package.json for frameworks if present
  const packageJsonPath = path.join(resolvedPath, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps['react']) frameworksFound.add('React');
      if (deps['vue']) frameworksFound.add('Vue');
      if (deps['next']) frameworksFound.add('Next.js');
      if (deps['express']) frameworksFound.add('Express');
      if (deps['@nestjs/core']) frameworksFound.add('NestJS');
      if (deps['jest'] || deps['vitest'] || deps['mocha']) hasTests = true;
    } catch {
      // Ignore JSON parse errors
    }
  }

  // 4. Inspect go.mod for frameworks if present
  const goModPath = path.join(resolvedPath, 'go.mod');
  if (fs.existsSync(goModPath)) {
    try {
      const content = fs.readFileSync(goModPath, 'utf8');
      if (content.includes('github.com/gin-gonic/gin')) frameworksFound.add('Gin');
      if (content.includes('google.golang.org/grpc')) frameworksFound.add('gRPC');
      if (content.includes('github.com/stretchr/testify')) hasTests = true;
    } catch {
      // Ignore
    }
  }

  // 5. Inspect Cargo.toml for frameworks if present
  const cargoPath = path.join(resolvedPath, 'Cargo.toml');
  if (fs.existsSync(cargoPath)) {
    try {
      const content = fs.readFileSync(cargoPath, 'utf8');
      if (content.includes('tokio')) frameworksFound.add('Tokio');
      if (content.includes('axum')) frameworksFound.add('Axum');
      if (content.includes('actix-web')) frameworksFound.add('Actix');
    } catch {
      // Ignore
    }
  }

  // 6. Fast recursive scan for file extension distribution (max depth 6, max 3000 files)
  let filesScanned = 0;
  const maxFiles = 3000;

  function scanDir(currentDir: string, depth: number) {
    if (depth > 6 || filesScanned >= maxFiles) return;

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (filesScanned >= maxFiles) break;

      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          if (entry.name === 'test' || entry.name === 'tests' || entry.name === '__tests__') {
            hasTests = true;
          }
          scanDir(path.join(currentDir, entry.name), depth + 1);
        }
      } else if (entry.isFile()) {
        filesScanned++;
        totalFiles++;
        const ext = path.extname(entry.name).toLowerCase();
        const lang = EXTENSION_MAP[ext];
        if (lang) {
          langCountMap[lang] = (langCountMap[lang] || 0) + 1;
        }

        if (
          entry.name.includes('test') ||
          entry.name.includes('spec') ||
          entry.name.endsWith('_test.go') ||
          entry.name.endsWith('.test.ts') ||
          entry.name.endsWith('.spec.ts') ||
          entry.name.endsWith('_test.py')
        ) {
          hasTests = true;
        }
      }
    }
  }

  scanDir(resolvedPath, 0);

  // 7. Calculate percentages
  const recognizedTotal = Object.values(langCountMap).reduce((a, b) => a + b, 0);
  const languages: RepoLanguageInfo[] = Object.entries(langCountMap)
    .map(([language, count]) => ({
      language,
      filesCount: count,
      percentage: recognizedTotal > 0 ? Math.round((count / recognizedTotal) * 100) : 0,
    }))
    .sort((a, b) => b.filesCount - a.filesCount);

  // Deduce primary language
  let primaryLanguage = 'unknown';
  if (languages.length > 0) {
    primaryLanguage = languages[0].language;
  } else if (manifestsFound.includes('go.mod')) {
    primaryLanguage = 'Go';
  } else if (manifestsFound.includes('Cargo.toml')) {
    primaryLanguage = 'Rust';
  } else if (manifestsFound.includes('package.json')) {
    primaryLanguage = 'TypeScript';
  } else if (manifestsFound.includes('pyproject.toml') || manifestsFound.includes('requirements.txt')) {
    primaryLanguage = 'Python';
  }

  return {
    repoPath: resolvedPath,
    primaryLanguage,
    languages,
    manifests: manifestsFound,
    frameworks: Array.from(frameworksFound),
    hasTests,
    hasWorkflows,
    totalFiles,
  };
}
