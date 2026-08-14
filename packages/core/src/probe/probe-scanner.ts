import type { ProbeSuggestion, RepoProbeResult } from '../contracts/schemas.js';
import { GitHubClient } from '../discovery/github-client.js';

export async function probeRepository(
  repoFullName: string,
  githubToken?: string,
): Promise<RepoProbeResult> {
  const client = new GitHubClient({ token: githubToken });
  const [owner, repo] = repoFullName.split('/');

  const scannedFiles: string[] = [];
  const suggestions: ProbeSuggestion[] = [];

  // 1. Scan Workflows
  const workflows = await client.listWorkflowFiles(owner, repo);
  const identifiedWorkflows = workflows.map((w) => w.path);
  scannedFiles.push(...identifiedWorkflows);

  for (const wf of workflows) {
    // Check for deprecated actions/checkout@v2 or v3
    if (wf.content.includes('actions/checkout@v2') || wf.content.includes('actions/checkout@v3')) {
      suggestions.push({
        id: `ci-upgrade-checkout-${wf.path.replace(/[^a-zA-Z0-9]/g, '_')}`,
        title: `Upgrade deprecated actions/checkout to v4 in ${wf.path}`,
        category: 'ci_workflow',
        summary: 'Repository uses deprecated actions/checkout version in CI workflows.',
        rationale: 'Upgrading to v4 ensures compatibility with modern GitHub Actions runners and improves security.',
        targetFiles: [{ path: wf.path, reason: 'Target CI workflow file' }],
        proposedChanges: ['Replace actions/checkout@v2 or @v3 with actions/checkout@v4'],
        validationPlan: ['Verify workflow syntax with action-validator or trigger local pre-flight'],
        estimatedDiffLines: 6,
        prPotentialScore: 92,
      });
    }

    // Check for deprecated actions/setup-node@v2 or v3
    if (wf.content.includes('actions/setup-node@v2') || wf.content.includes('actions/setup-node@v3')) {
      suggestions.push({
        id: `ci-upgrade-setup-node-${wf.path.replace(/[^a-zA-Z0-9]/g, '_')}`,
        title: `Upgrade setup-node action to v4 in ${wf.path}`,
        category: 'ci_workflow',
        summary: 'Repository uses deprecated actions/setup-node version in CI.',
        rationale: 'setup-node@v4 includes better caching stability and support for recent Node releases.',
        targetFiles: [{ path: wf.path, reason: 'Target CI workflow file' }],
        proposedChanges: ['Replace actions/setup-node@v2 or @v3 with actions/setup-node@v4'],
        validationPlan: ['Test workflow execution'],
        estimatedDiffLines: 4,
        prPotentialScore: 88,
      });
    }
  }

  // 2. Scan README.md
  const readmeContent = await client.getRepoTextFile(owner, repo, 'README.md');
  if (readmeContent) {
    scannedFiles.push('README.md');

    // Check for broken badges or outdated URLs
    if (readmeContent.includes('travis-ci.org') || readmeContent.includes('travis-ci.com')) {
      suggestions.push({
        id: 'docs-remove-dead-travis-badge',
        title: 'Remove defunct Travis CI badge from README',
        category: 'dx_docs',
        summary: 'README still contains defunct Travis CI badge link.',
        rationale: 'Travis CI is decommissioned for most open-source projects; removing dead badges cleans up project presentation.',
        targetFiles: [{ path: 'README.md', reason: 'Project entry documentation' }],
        proposedChanges: ['Remove dead Travis CI badge or replace with GitHub Actions workflow status badge'],
        validationPlan: ['Preview rendered README in Markdown viewer'],
        estimatedDiffLines: 5,
        prPotentialScore: 90,
      });
    }
  }

  // 3. Scan package.json
  const packageJsonContent = await client.getRepoTextFile(owner, repo, 'package.json');
  if (packageJsonContent) {
    scannedFiles.push('package.json');
    try {
      const pkg = JSON.parse(packageJsonContent);
      // Check for missing repository or bugs field
      if (!pkg.repository && !pkg.bugs) {
        suggestions.push({
          id: 'pkg-add-metadata-links',
          title: 'Add repository and bugs metadata to package.json',
          category: 'dx_docs',
          summary: 'package.json is missing repository and issue tracker metadata links.',
          rationale: 'Adding standard metadata fields improves npm package discovery and links users to issues directly.',
          targetFiles: [{ path: 'package.json', reason: 'Package manifest' }],
          proposedChanges: [
            `Add "repository": "github:${owner}/${repo}" and "bugs" URLs to package.json`,
          ],
          validationPlan: ['Validate package.json with npm pkg fix or json parser'],
          estimatedDiffLines: 8,
          prPotentialScore: 85,
        });
      }
    } catch {
      // Ignore JSON parse errors
    }
  }

  // 4. Scan .gitignore
  const gitignoreContent = await client.getRepoTextFile(owner, repo, '.gitignore');
  if (gitignoreContent) {
    scannedFiles.push('.gitignore');
    if (!gitignoreContent.includes('.DS_Store') || !gitignoreContent.includes('.env.local')) {
      suggestions.push({
        id: 'hygiene-add-common-gitignores',
        title: 'Add standard OS and environment ignores to .gitignore',
        category: 'code_hygiene',
        summary: '.gitignore is missing common editor/OS temporary file patterns.',
        rationale: 'Prevents contributors from accidentally committing .DS_Store, Thumbs.db, or local env files.',
        targetFiles: [{ path: '.gitignore', reason: 'Git ignore specifications' }],
        proposedChanges: ['Append .DS_Store, Thumbs.db, and *.local to .gitignore'],
        validationPlan: ['Inspect git status cleanliness'],
        estimatedDiffLines: 6,
        prPotentialScore: 82,
      });
    }
  }

  // 5. Scan Python (pyproject.toml)
  const pyprojectContent = await client.getRepoTextFile(owner, repo, 'pyproject.toml');
  if (pyprojectContent) {
    scannedFiles.push('pyproject.toml');
    if (!pyprojectContent.includes('[tool.ruff]') && !pyprojectContent.includes('[tool.black]')) {
      suggestions.push({
        id: 'python-add-modern-linter-config',
        title: 'Configure Ruff linter in pyproject.toml',
        category: 'code_hygiene',
        summary: 'Python project is missing modern unified linter/formatter configurations.',
        rationale: 'Ruff provides 10-100x faster linting and consistent formatting for open source contributors.',
        targetFiles: [{ path: 'pyproject.toml', reason: 'Python project manifest' }],
        proposedChanges: ['Add standard [tool.ruff] configuration with target-version and line-length'],
        validationPlan: ['Run ruff check .'],
        estimatedDiffLines: 12,
        prPotentialScore: 84,
      });
    }
  }

  // 6. Scan Rust (Cargo.toml)
  const cargoContent = await client.getRepoTextFile(owner, repo, 'Cargo.toml');
  if (cargoContent) {
    scannedFiles.push('Cargo.toml');
    if (!cargoContent.includes('repository =') || !cargoContent.includes('license =')) {
      suggestions.push({
        id: 'rust-add-crate-metadata',
        title: 'Add repository and license fields to Cargo.toml',
        category: 'dx_docs',
        summary: 'Cargo.toml package table is missing repository and license metadata.',
        rationale: 'Improves crates.io metadata completeness and docs.rs linking.',
        targetFiles: [{ path: 'Cargo.toml', reason: 'Rust crate manifest' }],
        proposedChanges: ['Add license = "MIT OR Apache-2.0" and repository URL to [package]'],
        validationPlan: ['Run cargo check'],
        estimatedDiffLines: 4,
        prPotentialScore: 86,
      });
    }
  }

  // 7. Scan Dependabot (.github/dependabot.yml)
  const dependabotContent = await client.getRepoTextFile(owner, repo, '.github/dependabot.yml');
  if (!dependabotContent) {
    suggestions.push({
      id: 'security-enable-dependabot',
      title: 'Add automated Dependabot config for GitHub Actions & packages',
      category: 'security',
      summary: 'Repository is missing automated weekly dependency security maintenance.',
      rationale: 'Dependabot ensures GitHub Actions and project dependencies stay up-to-date with security patches.',
      targetFiles: [{ path: '.github/dependabot.yml', reason: 'Security maintenance workflow' }],
      proposedChanges: ['Add standard .github/dependabot.yml with weekly interval for github-actions and package-ecosystem'],
      validationPlan: ['Verify GitHub Dependabot syntax'],
      estimatedDiffLines: 14,
      prPotentialScore: 91,
    });
  }

  return {
    repoFullName,
    scannedFiles,
    identifiedWorkflows,
    suggestions: suggestions.sort((a, b) => b.prPotentialScore - a.prPotentialScore),
    timestamp: new Date().toISOString(),
  };
}
