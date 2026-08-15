import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { RepoMemoryLedger } from '../memory/repo-memory.js';
import { runDoctorAudit } from './doctor.js';

export interface RunnableCommands {
  testCommand?: string;
  buildCommand?: string;
  lintCommand?: string;
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
  assembledAt: string;
}

/**
 * Detects runnable commands directly from repository files.
 */
export function detectRunnableCommandsFromDir(dirPath: string): RunnableCommands {
  const commands: RunnableCommands = {};

  if (!existsSync(dirPath)) return commands;

  try {
    const files = readdirSync(dirPath);

    // Node.js / Bun / JS
    if (files.includes('package.json')) {
      try {
        const pkg = JSON.parse(readFileSync(join(dirPath, 'package.json'), 'utf-8'));
        const scripts = pkg.scripts || {};
        if (scripts.test) commands.testCommand = 'bun test';
        if (scripts.build) commands.buildCommand = 'bun run build';
        if (scripts.lint) commands.lintCommand = 'bun run lint';
      } catch {}
    }

    // Rust
    if (files.includes('Cargo.toml')) {
      commands.testCommand = 'cargo test';
      commands.buildCommand = 'cargo build';
      commands.lintCommand = 'cargo clippy';
    }

    // Go
    if (files.includes('go.mod')) {
      commands.testCommand = 'go test ./...';
      commands.buildCommand = 'go build ./...';
      commands.lintCommand = 'golangci-lint run';
    }

    // Python
    if (files.includes('pyproject.toml') || files.includes('requirements.txt')) {
      commands.testCommand = 'pytest';
      commands.lintCommand = 'ruff check .';
    }

    // CMake / C++
    if (files.includes('CMakeLists.txt')) {
      commands.buildCommand = 'cmake --build build';
      commands.testCommand = 'ctest --test-dir build';
    }
  } catch {}

  return commands;
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
      if (packageManifest.includes('"test":')) testCommandHint = 'bun test';
      else if (packageManifest.includes('Cargo.toml')) testCommandHint = 'cargo test';
      else if (packageManifest.includes('go.mod')) testCommandHint = 'go test ./...';
    }

    // 4. Detect skeleton files
    const detectedSkeletonFiles: string[] = [];
    if (workspacePath && existsSync(workspacePath)) {
      try {
        const entries = readdirSync(workspacePath);
        for (const e of entries.slice(0, 15)) {
          if (!e.startsWith('.') && e !== 'node_modules' && e !== 'target' && e !== 'dist') {
            detectedSkeletonFiles.push(e);
          }
        }
      } catch {}
    }

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
    if (ctx.repoContext.runnableCommands.testCommand) {
      sections.push(`- **Test Command**: \`${ctx.repoContext.runnableCommands.testCommand}\``);
    }
    if (ctx.repoContext.detectedSkeletonFiles.length > 0) {
      sections.push(`- **Top-level Structure**: ${ctx.repoContext.detectedSkeletonFiles.join(', ')}`);
    }
    if (ctx.repoContext.packageManifestSnippet) {
      sections.push(`- **Package Manifest**:\n\`\`\`\n${ctx.repoContext.packageManifestSnippet}\n\`\`\``);
    }

    if (ctx.memoryContext.pastFailures.length > 0 || ctx.memoryContext.successfulPatterns.length > 0) {
      sections.push(`\n### 3. Historical Repository Memory & Pitfalls`);
      if (ctx.memoryContext.pastFailures.length > 0) {
        sections.push(`- **Avoid These Past Mistakes**:\n  - ${ctx.memoryContext.pastFailures.join('\n  - ')}`);
      }
      if (ctx.memoryContext.successfulPatterns.length > 0) {
        sections.push(`- **Preferred Successful Patterns**:\n  - ${ctx.memoryContext.successfulPatterns.join('\n  - ')}`);
      }
    }

    sections.push(`\n### 4. Local Execution Environment`);
    sections.push(`- **Host OS**: ${ctx.environmentContext.os}`);
    sections.push(`- **Docker Available**: ${ctx.environmentContext.hasDocker}`);
    sections.push(`- **WSL Available**: ${ctx.environmentContext.hasWsl}`);
    sections.push(`- **Node/Bun Runtime**: ${ctx.environmentContext.nodeVersion}`);

    return sections.join('\n');
  }
}
