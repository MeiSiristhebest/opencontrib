import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { RepoMemoryLedger } from '../memory/repo-memory.js';
import { runDoctorAudit } from './doctor.js';

export interface RunnableCommands {
  testCommand?: string;
  buildCommand?: string;
  lintCommand?: string;
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun' | 'cargo' | 'go' | 'pytest' | 'cmake';
}

export interface ContributionGuidance {
  suggestedReadingOrder: string[];
  targetTestFiles: string[];
  riskSurface: {
    level: 'LOW' | 'MEDIUM' | 'HIGH';
    rationale: string;
    sensitivePaths: string[];
  };
}

export interface AssembledContributionContext {
  problemContext: {
    repoFullName: string;
    issueNumber?: number;
    issueTitle: string;
    issueBody: string;
    linkedComments?: string[];
  };
  repoContext: {
    primaryLanguage: string;
    packageManifestSnippet?: string;
    ciWorkflowSnippet?: string;
    testCommandHint?: string;
    runnableCommands: RunnableCommands;
    detectedSkeletonFiles: string[];
    contributingGuidelinesSnippet?: string;
  };
  memoryContext: {
    pastFailures: string[];
    successfulPatterns: string[];
    preferredPaths: string[];
  };
  environmentContext: {
    os: string;
    hasDocker: boolean;
    hasWsl: boolean;
    nodeVersion: string;
  };
  guidance: ContributionGuidance;
  assembledAt: string;
}


/**
 * Detects actual runnable commands by inspecting manifest files, package managers, and lockfiles.
 */
export function detectRunnableCommandsFromDir(dirPath: string): RunnableCommands {
  const commands: RunnableCommands = {};

  if (!existsSync(dirPath)) return commands;

  try {
    const files = readdirSync(dirPath);

    // 1. Node.js / TypeScript Ecosystem
    if (files.includes('package.json')) {
      try {
        const pkg = JSON.parse(readFileSync(join(dirPath, 'package.json'), 'utf-8'));
        const scripts = pkg.scripts || {};

        // Detect package manager
        let pm: 'npm' | 'pnpm' | 'yarn' | 'bun' = 'npm';
        if (pkg.packageManager) {
          if (pkg.packageManager.startsWith('pnpm')) pm = 'pnpm';
          else if (pkg.packageManager.startsWith('yarn')) pm = 'yarn';
          else if (pkg.packageManager.startsWith('bun')) pm = 'bun';
        } else if (files.includes('pnpm-lock.yaml')) {
          pm = 'pnpm';
        } else if (files.includes('yarn.lock')) {
          pm = 'yarn';
        } else if (files.includes('bun.lock') || files.includes('bun.lockb')) {
          pm = 'bun';
        } else if (files.includes('package-lock.json')) {
          pm = 'npm';
        }

        commands.packageManager = pm;

        if (scripts.test) {
          commands.testCommand = pm === 'npm' ? 'npm test' : `${pm} test`;
        }
        if (scripts.build) {
          commands.buildCommand = pm === 'npm' ? 'npm run build' : `${pm} run build`;
        }
        if (scripts.lint) {
          commands.lintCommand = pm === 'npm' ? 'npm run lint' : `${pm} run lint`;
        }
      } catch {}
    }

    // 2. Rust Ecosystem
    if (files.includes('Cargo.toml')) {
      commands.packageManager = 'cargo';
      commands.testCommand = 'cargo test';
      commands.buildCommand = 'cargo build';
      commands.lintCommand = 'cargo clippy';
    }

    // 3. Go Ecosystem
    if (files.includes('go.mod')) {
      commands.packageManager = 'go';
      commands.testCommand = 'go test ./...';
      commands.buildCommand = 'go build ./...';
      commands.lintCommand = 'golangci-lint run';
    }

    // 4. Python Ecosystem
    if (files.includes('pyproject.toml') || files.includes('requirements.txt')) {
      commands.packageManager = 'pytest';
      commands.testCommand = 'pytest';
      commands.lintCommand = 'ruff check .';
    }

    // 5. C/C++ CMake Ecosystem
    if (files.includes('CMakeLists.txt')) {
      commands.packageManager = 'cmake';
      commands.buildCommand = 'cmake -B build && cmake --build build';
      commands.testCommand = 'ctest --test-dir build';
    }
  } catch {}

  return commands;
}

/**
 * Extracts key guidelines from CONTRIBUTING.md, CLAUDE.md, or AGENTS.md
 */
export function extractContributingGuidelines(dirPath: string): string | undefined {
  if (!existsSync(dirPath)) return undefined;

  const candidateFiles = [
    'CONTRIBUTING.md',
    '.github/CONTRIBUTING.md',
    'AGENTS.md',
    '.github/AGENTS.md',
    'CLAUDE.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
  ];

  for (const rel of candidateFiles) {
    const full = join(dirPath, rel);
    if (existsSync(full)) {
      try {
        const content = readFileSync(full, 'utf-8');
        return `[From ${rel}]\n${content.slice(0, 1000)}`;
      } catch {}
    }
  }

  return undefined;
}

export class ContextAssembler {
  private memory: RepoMemoryLedger;

  constructor(memory?: RepoMemoryLedger) {
    this.memory = memory || new RepoMemoryLedger();
  }

  assemble(input: {
    repoFullName: string;
    issueTitle: string;
    issueBody: string;
    issueNumber?: number;
    linkedComments?: string[];
    packageManifest?: string;
    ciWorkflow?: string;
    primaryLanguage?: string;
    workspacePath?: string;
  }): AssembledContributionContext {
    const {
      repoFullName,
      issueTitle,
      issueBody,
      issueNumber,
      linkedComments = [],
      packageManifest,
      ciWorkflow,
      primaryLanguage = 'TypeScript',
      workspacePath,
    } = input;

    // 1. Extract memory context
    const repoRecord = this.memory.getMemory(repoFullName);
    const pastFailures = repoRecord?.pastFailures.map((f) => `[${f.date}] ${f.reason}`) || [];
    const successfulPatterns = repoRecord?.successfulContributions.map((s) => s.title) || [];
    const preferredPaths = (repoRecord?.conventions as any)?.preferredPaths || [];

    // 2. Extract environment context
    const doctor = runDoctorAudit();

    // 3. Infer runnable commands
    const runnableCommands = workspacePath
      ? detectRunnableCommandsFromDir(workspacePath)
      : {};

    let testCommandHint = runnableCommands.testCommand;
    if (!testCommandHint && packageManifest) {
      if (packageManifest.includes('"test":')) {
        testCommandHint = packageManifest.includes('pnpm') ? 'pnpm test' : 'npm test';
      } else if (packageManifest.includes('Cargo.toml')) {
        testCommandHint = 'cargo test';
      } else if (packageManifest.includes('go.mod')) {
        testCommandHint = 'go test ./...';
      }
    }

    // 4. Detect skeleton files & architecture
    const detectedSkeletonFiles: string[] = [];
    let contributingGuidelinesSnippet: string | undefined;

    if (workspacePath && existsSync(workspacePath)) {
      try {
        const entries = readdirSync(workspacePath);
        for (const e of entries.slice(0, 20)) {
          if (!e.startsWith('.') && e !== 'node_modules' && e !== 'target' && e !== 'dist') {
            detectedSkeletonFiles.push(e);
          }
        }
        contributingGuidelinesSnippet = extractContributingGuidelines(workspacePath);
      } catch {}
    }

    // 5. Generate Exploration Guidance (suggested reading order, target tests, risk surface)
    const suggestedReadingOrder: string[] = [];
    const targetTestFiles: string[] = [];
    const sensitivePaths: string[] = [];

    if (packageManifest) {
      if (packageManifest.includes('package.json')) suggestedReadingOrder.push('package.json');
      if (packageManifest.includes('Cargo.toml')) suggestedReadingOrder.push('Cargo.toml');
      if (packageManifest.includes('go.mod')) suggestedReadingOrder.push('go.mod');
    }
    if (contributingGuidelinesSnippet) {
      suggestedReadingOrder.push('CONTRIBUTING.md');
    }

    for (const file of detectedSkeletonFiles) {
      if (file.toLowerCase().includes('readme')) {
        suggestedReadingOrder.push(file);
      } else if (file === 'src' || file === 'lib' || file === 'packages') {
        suggestedReadingOrder.push(file);
      } else if (file.toLowerCase().includes('test') || file.toLowerCase().includes('spec')) {
        targetTestFiles.push(file);
      } else if (file.startsWith('.github') || file === 'scripts') {
        sensitivePaths.push(file);
      }
    }

    for (const pref of preferredPaths) {
      if (pref.includes('test') || pref.includes('spec')) {
        targetTestFiles.push(pref);
      } else {
        suggestedReadingOrder.push(pref);
      }
    }

    const isHighRisk =
      issueTitle.toLowerCase().includes('breaking') ||
      issueTitle.toLowerCase().includes('security') ||
      sensitivePaths.length > 2;

    const guidance: ContributionGuidance = {
      suggestedReadingOrder: Array.from(new Set(suggestedReadingOrder)).slice(0, 5),
      targetTestFiles: Array.from(new Set(targetTestFiles)),
      riskSurface: {
        level: isHighRisk ? 'HIGH' : sensitivePaths.length > 0 ? 'MEDIUM' : 'LOW',
        rationale: isHighRisk
          ? 'Potentially high blast radius or security/breaking boundary'
          : sensitivePaths.length > 0
            ? 'Touches build or workflow infrastructure files'
            : 'Standard scoped module improvement',
        sensitivePaths: Array.from(new Set(sensitivePaths)),
      },
    };

    return {
      problemContext: {
        repoFullName,
        issueNumber,
        issueTitle,
        issueBody,
        linkedComments,
      },
      repoContext: {
        primaryLanguage,
        packageManifestSnippet: packageManifest ? packageManifest.slice(0, 1500) : undefined,
        ciWorkflowSnippet: ciWorkflow ? ciWorkflow.slice(0, 1500) : undefined,
        testCommandHint,
        runnableCommands,
        detectedSkeletonFiles,
        contributingGuidelinesSnippet,
      },
      memoryContext: {
        pastFailures,
        successfulPatterns,
        preferredPaths,
      },
      environmentContext: {
        os: doctor.environment.os,
        hasDocker: doctor.environment.dockerAvailable,
        hasWsl: doctor.environment.wslAvailable,
        nodeVersion: doctor.environment.nodeVersion,
      },
      guidance,
      assembledAt: new Date().toISOString(),
    };
  }

  formatContextPrompt(ctx: AssembledContributionContext): string {
    const sections: string[] = [];

    sections.push(`### 1. Problem Specification`);
    sections.push(`- **Repository**: ${ctx.problemContext.repoFullName}`);
    if (ctx.problemContext.issueNumber) {
      sections.push(`- **Issue Number**: #${ctx.problemContext.issueNumber}`);
    }
    sections.push(`- **Title**: ${ctx.problemContext.issueTitle}`);
    sections.push(`- **Description**:\n${ctx.problemContext.issueBody}`);

    if (ctx.problemContext.linkedComments && ctx.problemContext.linkedComments.length > 0) {
      sections.push(`- **Discussion Insights**:\n${ctx.problemContext.linkedComments.join('\n')}`);
    }

    sections.push(`\n### 2. Repository Infrastructure & Commands`);
    sections.push(`- **Primary Language**: ${ctx.repoContext.primaryLanguage}`);
    if (ctx.repoContext.runnableCommands.packageManager) {
      sections.push(`- **Package Manager**: ${ctx.repoContext.runnableCommands.packageManager}`);
    }
    if (ctx.repoContext.runnableCommands.testCommand) {
      sections.push(`- **Test Command**: \`${ctx.repoContext.runnableCommands.testCommand}\``);
    }
    if (ctx.repoContext.detectedSkeletonFiles.length > 0) {
      sections.push(`- **Top-level Structure**: ${ctx.repoContext.detectedSkeletonFiles.join(', ')}`);
    }
    if (ctx.repoContext.contributingGuidelinesSnippet) {
      sections.push(`- **Contributing Guidelines**:\n${ctx.repoContext.contributingGuidelinesSnippet}`);
    }
    if (ctx.repoContext.packageManifestSnippet) {
      sections.push(`- **Package Manifest**:\n\`\`\`\n${ctx.repoContext.packageManifestSnippet}\n\`\`\``);
    }

    if (ctx.guidance.suggestedReadingOrder.length > 0 || ctx.guidance.targetTestFiles.length > 0) {
      sections.push(`\n### 3. Contribution Exploration Guidance`);
      if (ctx.guidance.suggestedReadingOrder.length > 0) {
        sections.push(`- **Suggested Reading Order**: ${ctx.guidance.suggestedReadingOrder.join(' -> ')}`);
      }
      if (ctx.guidance.targetTestFiles.length > 0) {
        sections.push(`- **Target Test Files**: ${ctx.guidance.targetTestFiles.join(', ')}`);
      }
      sections.push(`- **Risk Surface**: [${ctx.guidance.riskSurface.level}] ${ctx.guidance.riskSurface.rationale}`);
    }

    if (ctx.memoryContext.pastFailures.length > 0 || ctx.memoryContext.successfulPatterns.length > 0) {
      sections.push(`\n### 4. Historical Repository Memory & Pitfalls`);
      if (ctx.memoryContext.pastFailures.length > 0) {
        sections.push(`- **Avoid These Past Mistakes**:\n  - ${ctx.memoryContext.pastFailures.join('\n  - ')}`);
      }
      if (ctx.memoryContext.successfulPatterns.length > 0) {
        sections.push(`- **Preferred Successful Patterns**:\n  - ${ctx.memoryContext.successfulPatterns.join('\n  - ')}`);
      }
    }

    sections.push(`\n### 5. Local Execution Environment`);
    sections.push(`- **Host OS**: ${ctx.environmentContext.os}`);
    sections.push(`- **Docker Available**: ${ctx.environmentContext.hasDocker}`);
    sections.push(`- **WSL Available**: ${ctx.environmentContext.hasWsl}`);
    sections.push(`- **Node/Bun Runtime**: ${ctx.environmentContext.nodeVersion}`);

    return sections.join('\n');
  }
}

