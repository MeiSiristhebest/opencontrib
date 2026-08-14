import { RepoMemoryLedger } from '../memory/repo-memory.js';
import { runDoctorAudit } from './doctor.js';

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
    } = input;

    // 1. Extract memory context
    const repoRecord = this.memory.getMemory(repoFullName);
    const pastFailures = repoRecord?.pastFailures.map((f) => `[${f.date}] ${f.reason}`) || [];
    const successfulPatterns = repoRecord?.successfulContributions.map((s) => s.title) || [];
    const preferredPaths = (repoRecord?.conventions as any)?.preferredPaths || [];

    // 2. Extract environment context
    const doctor = runDoctorAudit();

    // 3. Infer test command hint from manifest
    let testCommandHint: string | undefined;
    if (packageManifest) {
      if (packageManifest.includes('"test":')) testCommandHint = 'npm test (or bun test / vitest)';
      else if (packageManifest.includes('rush.json')) testCommandHint = 'rush test:cov';
      else if (packageManifest.includes('pnpm')) testCommandHint = 'pnpm test';
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
    return `# Assembled OSS Contribution Context

## 1. Problem Space
- **Repository**: ${ctx.problemContext.repoFullName}
- **Issue**: #${ctx.problemContext.issueNumber || 'N/A'} - ${ctx.problemContext.issueTitle}
- **Description**:
${ctx.problemContext.issueBody}

## 2. Repository Infrastructure
- **Primary Language**: ${ctx.repoContext.primaryLanguage}
- **Recommended Test Command**: ${ctx.repoContext.testCommandHint || 'Standard ecosystem test runner'}
${ctx.repoContext.ciWorkflowSnippet ? `\n### CI Workflow Context:\n\`\`\`yaml\n${ctx.repoContext.ciWorkflowSnippet}\n\`\`\`` : ''}

## 3. Historical Cognitive Memory
${
  ctx.memoryContext.pastFailures.length > 0
    ? `- ⚠️ Past Known Pitfalls:\n${ctx.memoryContext.pastFailures.map((f) => `  * ${f}`).join('\n')}`
    : '- Past Failures: None recorded'
}
${
  ctx.memoryContext.successfulPatterns.length > 0
    ? `- 🌟 Known Successful Strategies:\n${ctx.memoryContext.successfulPatterns.map((s) => `  * ${s}`).join('\n')}`
    : ''
}

## 4. Local Execution Environment
- **Host OS**: ${ctx.environmentContext.os}
- **Node**: ${ctx.environmentContext.nodeVersion}
- **Docker Available**: ${ctx.environmentContext.hasDocker ? 'Yes' : 'No'}
- **WSL Available**: ${ctx.environmentContext.hasWsl ? 'Yes' : 'No'}
`;
  }
}
