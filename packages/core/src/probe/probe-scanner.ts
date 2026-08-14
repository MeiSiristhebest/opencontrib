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

  // 5. Scan Python Ecosystem (pyproject.toml / setup.cfg / requirements.txt)
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

  // 6. Scan Rust Ecosystem (Cargo.toml / clippy.toml)
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

    if (cargoContent.includes('edition = "2015"') || cargoContent.includes('edition = "2018"')) {
      suggestions.push({
        id: 'rust-upgrade-edition-2021',
        title: 'Upgrade Rust edition to 2021 in Cargo.toml',
        category: 'code_hygiene',
        summary: 'Crate uses legacy Rust edition (2015/2018).',
        rationale: 'Rust 2021 edition provides disjoint closure capture, standard array IntoIterator, and modern macro resolver.',
        targetFiles: [{ path: 'Cargo.toml', reason: 'Rust crate manifest' }],
        proposedChanges: ['Update edition = "2021" in [package] or [workspace.package]'],
        validationPlan: ['Run cargo check --all-targets'],
        estimatedDiffLines: 2,
        prPotentialScore: 88,
      });
    }
  }

  // 7. Scan Go Ecosystem (go.mod / .golangci.yml)
  const goModContent = await client.getRepoTextFile(owner, repo, 'go.mod');
  if (goModContent) {
    scannedFiles.push('go.mod');
    const goVerMatch = goModContent.match(/^go\s+(\d+\.\d+)/m);
    if (goVerMatch && (goVerMatch[1] === '1.16' || goVerMatch[1] === '1.17' || goVerMatch[1] === '1.18')) {
      suggestions.push({
        id: 'go-upgrade-mod-version',
        title: `Upgrade deprecated Go version (${goVerMatch[1]}) in go.mod`,
        category: 'code_hygiene',
        summary: `go.mod specifies Go ${goVerMatch[1]}, which has reached official End-of-Life.`,
        rationale: 'Upgrading go.mod to Go 1.21+ enables modern toolchain directives, structured logging (slog), and loopvar semantics.',
        targetFiles: [{ path: 'go.mod', reason: 'Go module definition' }],
        proposedChanges: ['Update go directive to go 1.21 or go 1.22 in go.mod'],
        validationPlan: ['Run go test ./...'],
        estimatedDiffLines: 2,
        prPotentialScore: 89,
      });
    }
  }

  const golangCiContent =
    (await client.getRepoTextFile(owner, repo, '.golangci.yml')) ||
    (await client.getRepoTextFile(owner, repo, '.golangci.yaml'));
  if (golangCiContent) {
    scannedFiles.push('.golangci.yml');
    const deprecatedLinters = ['deadcode', 'varcheck', 'structcheck', 'golint', 'scopelint', 'nosnakecase'];
    const foundDeprecated = deprecatedLinters.filter((l) => golangCiContent.includes(l));
    if (foundDeprecated.length > 0) {
      suggestions.push({
        id: 'go-remove-deprecated-golangci-linters',
        title: `Remove deprecated linters (${foundDeprecated.join(', ')}) from .golangci.yml`,
        category: 'code_hygiene',
        summary: `.golangci.yml contains linters removed in recent golangci-lint releases: ${foundDeprecated.join(', ')}.`,
        rationale: 'Running removed linters triggers fatal errors on modern golangci-lint v1.50+ runners.',
        targetFiles: [{ path: '.golangci.yml', reason: 'Go linter configuration' }],
        proposedChanges: [`Remove deprecated linters: ${foundDeprecated.join(', ')} from enable/disable lists`],
        validationPlan: ['Run golangci-lint run'],
        estimatedDiffLines: foundDeprecated.length * 2,
        prPotentialScore: 94,
      });
    }
  }

  // 8. Scan Java / JVM Ecosystem (pom.xml / build.gradle / build.gradle.kts)
  const pomContent = await client.getRepoTextFile(owner, repo, 'pom.xml');
  const gradleContent =
    (await client.getRepoTextFile(owner, repo, 'build.gradle')) ||
    (await client.getRepoTextFile(owner, repo, 'build.gradle.kts'));
  if (pomContent || gradleContent) {
    if (pomContent) scannedFiles.push('pom.xml');
    if (gradleContent) scannedFiles.push('build.gradle');

    // Check Java setup in workflows
    for (const wf of workflows) {
      if (wf.content.includes('actions/setup-java@v1') || wf.content.includes('actions/setup-java@v2')) {
        suggestions.push({
          id: `java-upgrade-setup-java-${wf.path.replace(/[^a-zA-Z0-9]/g, '_')}`,
          title: `Upgrade setup-java to v4 with Temurin distribution in ${wf.path}`,
          category: 'ci_workflow',
          summary: 'Workflow uses outdated setup-java action version.',
          rationale: 'setup-java@v4 provides built-in dependency caching for Maven/Gradle and supports modern LTS JDKs.',
          targetFiles: [{ path: wf.path, reason: 'Java CI workflow' }],
          proposedChanges: [
            "Upgrade to uses: actions/setup-java@v4 with distribution: 'temurin' and cache: 'maven'/'gradle'",
          ],
          validationPlan: ['Verify workflow syntax'],
          estimatedDiffLines: 6,
          prPotentialScore: 90,
        });
      }
    }
  }

  // 9. Scan C / C++ Ecosystem (CMakeLists.txt / .clang-format)
  const cmakeContent = await client.getRepoTextFile(owner, repo, 'CMakeLists.txt');
  if (cmakeContent) {
    scannedFiles.push('CMakeLists.txt');
    const legacyCmakeMatch = cmakeContent.match(/cmake_minimum_required\s*\(\s*VERSION\s*([0-9.]+)/i);
    if (legacyCmakeMatch && parseFloat(legacyCmakeMatch[1]) < 3.12) {
      suggestions.push({
        id: 'cmake-bump-minimum-version',
        title: `Modernize legacy CMake minimum version (${legacyCmakeMatch[1]} -> 3.15) in CMakeLists.txt`,
        category: 'code_hygiene',
        summary: `CMakeLists.txt specifies legacy CMake ${legacyCmakeMatch[1]}.`,
        rationale: 'Modern CMake (>= 3.15) enables target-based compile options and modern toolchain integration without policy warnings.',
        targetFiles: [{ path: 'CMakeLists.txt', reason: 'CMake build script' }],
        proposedChanges: ['Update cmake_minimum_required(VERSION 3.15)'],
        validationPlan: ['Run cmake -B build'],
        estimatedDiffLines: 2,
        prPotentialScore: 85,
      });
    }
  }

  // 10. Scan Security & Community Health (Dependabot, SECURITY.md)
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

  const securityContent = await client.getRepoTextFile(owner, repo, 'SECURITY.md');
  if (!securityContent) {
    const rootSecurity = await client.getRepoTextFile(owner, repo, '.github/SECURITY.md');
    if (!rootSecurity) {
      suggestions.push({
        id: 'security-add-disclosure-policy',
        title: 'Add SECURITY.md vulnerability disclosure policy',
        category: 'security',
        summary: 'Repository is missing a coordinated vulnerability reporting policy.',
        rationale: 'A clear SECURITY.md policy provides ethical security researchers with a private channel to report vulnerabilities before public disclosure.',
        targetFiles: [{ path: 'SECURITY.md', reason: 'Security advisory policy' }],
        proposedChanges: ['Add standard GitHub SECURITY.md with contact details and response SLAs'],
        validationPlan: ['Verify Markdown formatting'],
        estimatedDiffLines: 18,
        prPotentialScore: 87,
      });
    }
  }

  return {
    repoFullName,
    scannedFiles,
    identifiedWorkflows,
    suggestions: suggestions.sort((a, b) => b.prPotentialScore - a.prPotentialScore),
    timestamp: new Date().toISOString(),
  };
}

