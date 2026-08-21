/**
 * Pure domain service for diagnosing repository manifests, CI workflows, and tooling configs
 * to produce <=100 line high-value surgical PR suggestions.
 */

export interface ManifestDiagnosticInput {
  workflows?: Array<{ path: string; content: string }>;
  readmeContent?: string;
  packageJsonContent?: string;
  pyprojectContent?: string;
  cargoContent?: string;
  gitignoreContent?: string;
  dependabotContent?: string;
}

export interface ManifestSuggestion {
  id: string;
  title: string;
  category: 'ci_workflow' | 'code_hygiene' | 'security' | 'tooling';
  summary: string;
  rationale: string;
  targetFiles: Array<{ path: string; reason: string }>;
  proposedChanges: string[];
  estimatedDiffLines: number;
  prPotentialScore: number;
}

export interface ManifestDiagnosticResult {
  status: 'success';
  suggestionsCount: number;
  suggestions: ManifestSuggestion[];
}

export function diagnoseManifests(input: ManifestDiagnosticInput): ManifestDiagnosticResult {
  const suggestions: ManifestSuggestion[] = [];
  const workflows = input.workflows || [];

  // 1. Scan CI Workflows
  for (const wf of workflows) {
    if (wf.content.includes('actions/checkout@v1') || wf.content.includes('actions/checkout@v2') || wf.content.includes('actions/checkout@v3')) {
      suggestions.push({
        id: `ci-upgrade-checkout-${wf.path.replace(/[^a-zA-Z0-9]/g, '_')}`,
        title: `Upgrade deprecated actions/checkout to v4 in ${wf.path}`,
        category: 'ci_workflow',
        summary: 'Repository uses deprecated actions/checkout version in CI workflows.',
        rationale: 'Upgrading to v4 ensures compatibility with modern GitHub Actions runners and improves security.',
        targetFiles: [{ path: wf.path, reason: 'Target CI workflow file' }],
        proposedChanges: ['Replace actions/checkout@v1, @v2, or @v3 with actions/checkout@v4'],
        estimatedDiffLines: 4,
        prPotentialScore: 92,
      });
    }

    if (wf.content.includes('actions/setup-node@v1') || wf.content.includes('actions/setup-node@v2') || wf.content.includes('actions/setup-node@v3')) {
      suggestions.push({
        id: `ci-upgrade-setup-node-${wf.path.replace(/[^a-zA-Z0-9]/g, '_')}`,
        title: `Upgrade deprecated actions/setup-node to v4 in ${wf.path}`,
        category: 'ci_workflow',
        summary: 'Repository uses deprecated actions/setup-node version in CI workflows.',
        rationale: 'Upgrading to v4 provides built-in caching support for npm/yarn/pnpm and modern Node runtime support.',
        targetFiles: [{ path: wf.path, reason: 'Target CI workflow file' }],
        proposedChanges: ['Replace actions/setup-node@v1, @v2, or @v3 with actions/setup-node@v4'],
        estimatedDiffLines: 4,
        prPotentialScore: 90,
      });
    }

    if (wf.content.includes('actions/setup-python@v1') || wf.content.includes('actions/setup-python@v2') || wf.content.includes('actions/setup-python@v3')) {
      suggestions.push({
        id: `ci-upgrade-setup-python-${wf.path.replace(/[^a-zA-Z0-9]/g, '_')}`,
        title: `Upgrade deprecated actions/setup-python to v5 in ${wf.path}`,
        category: 'ci_workflow',
        summary: 'Repository uses deprecated actions/setup-python version in CI workflows.',
        rationale: 'Upgrading to v5 adds dependency caching and Python 3.12+ compatibility.',
        targetFiles: [{ path: wf.path, reason: 'Target CI workflow file' }],
        proposedChanges: ['Replace actions/setup-python@v1..v3 with actions/setup-python@v5'],
        estimatedDiffLines: 4,
        prPotentialScore: 89,
      });
    }

    // Check missing concurrency cancel-in-progress on PR workflows
    if (wf.content.includes('pull_request:') && !wf.content.includes('cancel-in-progress') && !wf.content.includes('concurrency:')) {
      suggestions.push({
        id: `ci-add-concurrency-${wf.path.replace(/[^a-zA-Z0-9]/g, '_')}`,
        title: `Add concurrency group with cancel-in-progress to ${wf.path}`,
        category: 'ci_workflow',
        summary: 'CI workflow does not cancel superseded runs on new pull request pushes.',
        rationale: 'Adding cancel-in-progress prevents redundant CI runner contention and reduces waiting queues.',
        targetFiles: [{ path: wf.path, reason: 'Target CI workflow file' }],
        proposedChanges: ['Add concurrency: group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true'],
        estimatedDiffLines: 5,
        prPotentialScore: 87,
      });
    }
  }

  // 2. Scan Python pyproject.toml
  if (input.pyprojectContent) {
    if (!input.pyprojectContent.includes('[tool.ruff]')) {
      suggestions.push({
        id: 'python-add-modern-linter',
        title: 'Configure Ruff linter in pyproject.toml',
        category: 'code_hygiene',
        summary: 'Python project is missing modern unified linter/formatter configurations.',
        rationale: 'Ruff provides 10-100x faster linting for open source contributors.',
        targetFiles: [{ path: 'pyproject.toml', reason: 'Python project manifest' }],
        proposedChanges: ['Add standard [tool.ruff] configuration with target-version and line-length'],
        estimatedDiffLines: 12,
        prPotentialScore: 85,
      });
    }
    if (!input.pyprojectContent.includes('[tool.pytest.ini_options]') && !input.pyprojectContent.includes('[tool.pytest]')) {
      suggestions.push({
        id: 'python-add-pytest-config',
        title: 'Add standard pytest configuration in pyproject.toml',
        category: 'tooling',
        summary: 'Python project lacks declarative pytest options in pyproject.toml.',
        rationale: 'Declaring test paths and filterwarnings in pyproject.toml avoids CLI flag boilerplate.',
        targetFiles: [{ path: 'pyproject.toml', reason: 'Python project manifest' }],
        proposedChanges: ['Add [tool.pytest.ini_options] with testpaths = ["tests"]'],
        estimatedDiffLines: 8,
        prPotentialScore: 82,
      });
    }
  }

  // 3. Scan Node package.json
  if (input.packageJsonContent) {
    try {
      const pkg = JSON.parse(input.packageJsonContent);
      if (!pkg.scripts || !pkg.scripts.test || pkg.scripts.test.includes('no test specified')) {
        suggestions.push({
          id: 'node-add-test-script',
          title: 'Add configured test script to package.json',
          category: 'tooling',
          summary: 'package.json is missing a runnable test script command.',
          rationale: 'Standard "npm test" command enables CI runners and contributors to verify patches.',
          targetFiles: [{ path: 'package.json', reason: 'Node package manifest' }],
          proposedChanges: ['Add standard "test" script entry to "scripts" block'],
          estimatedDiffLines: 4,
          prPotentialScore: 88,
        });
      }
      if (!pkg.engines || !pkg.engines.node) {
        suggestions.push({
          id: 'node-add-engines-field',
          title: 'Specify minimum Node.js version in package.json engines field',
          category: 'code_hygiene',
          summary: 'package.json does not specify supported Node runtime versions.',
          rationale: 'Defining engines.node (e.g. ">=18.0.0") prevents runtime mismatch bugs across environments.',
          targetFiles: [{ path: 'package.json', reason: 'Node package manifest' }],
          proposedChanges: ['Add "engines": { "node": ">=18.0.0" } to package.json'],
          estimatedDiffLines: 5,
          prPotentialScore: 83,
        });
      }
    } catch {}
  }

  // 4. Scan Rust Cargo.toml
  if (input.cargoContent) {
    if (!input.cargoContent.includes('[profile.release]') || !input.cargoContent.includes('lto')) {
      suggestions.push({
        id: 'rust-add-release-profile-lto',
        title: 'Add Link-Time Optimization (LTO) to release profile in Cargo.toml',
        category: 'tooling',
        summary: 'Rust workspace lacks LTO and binary strip flags for release builds.',
        rationale: 'Enabling lto = true and strip = true reduces release binary size by 30-50% with zero code changes.',
        targetFiles: [{ path: 'Cargo.toml', reason: 'Rust manifest' }],
        proposedChanges: ['Add [profile.release] with lto = true, opt-level = 3, strip = true'],
        estimatedDiffLines: 6,
        prPotentialScore: 86,
      });
    }
  }

  // 5. Scan .gitignore
  if (input.gitignoreContent) {
    const gitignore = input.gitignoreContent;
    const missingRules: string[] = [];
    if (!gitignore.includes('.DS_Store')) missingRules.push('.DS_Store');
    if (!gitignore.includes('*.log')) missingRules.push('*.log');
    if (!gitignore.includes('.env*') && !gitignore.includes('.env')) missingRules.push('.env*.local');

    if (missingRules.length > 0) {
      suggestions.push({
        id: 'hygiene-add-gitignore-rules',
        title: `Add essential ignores (${missingRules.join(', ')}) to .gitignore`,
        category: 'code_hygiene',
        summary: 'Repository .gitignore is missing common OS or secret artifact ignore patterns.',
        rationale: 'Adding standard ignores prevents accidental commits of local OS metadata and secrets.',
        targetFiles: [{ path: '.gitignore', reason: 'Git ignore file' }],
        proposedChanges: missingRules.map((r) => `Add ${r} to .gitignore`),
        estimatedDiffLines: missingRules.length + 2,
        prPotentialScore: 84,
      });
    }
  }

  // 6. Scan Dependabot
  if (!input.dependabotContent) {
    suggestions.push({
      id: 'security-enable-dependabot',
      title: 'Add automated Dependabot config for GitHub Actions & packages',
      category: 'security',
      summary: 'Repository is missing automated weekly dependency security maintenance.',
      rationale: 'Dependabot ensures GitHub Actions and project dependencies stay up-to-date with security patches.',
      targetFiles: [{ path: '.github/dependabot.yml', reason: 'Security maintenance workflow' }],
      proposedChanges: ['Add standard .github/dependabot.yml with weekly interval and package-ecosystem: "github-actions"'],
      estimatedDiffLines: 14,
      prPotentialScore: 91,
    });
  }

  return {
    status: 'success',
    suggestionsCount: suggestions.length,
    suggestions: suggestions.sort((a, b) => b.prPotentialScore - a.prPotentialScore),
  };
}
