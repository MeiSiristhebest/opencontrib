import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createOpenContribMcpServer } from '../src/server.js';
import { SmartPointerStore } from '@opencontrib/core';

describe('MCP Tools Comprehensive Handler Coverage', () => {
  const server = createOpenContribMcpServer();
  const tools = (server as any)._registeredTools;
  const resources = (server as any)._registeredResources;
  const prompts = (server as any)._registeredPrompts;

  it('executes discovery & opportunity tools handlers', async () => {
    const qualRes = await tools['contrib_qualify_issue'].handler({
      issue: {
        title: 'Fix path issue',
        body: 'Description',
        state: 'open',
        authorAssociation: 'NONE',
        hasPullRequest: false,
        assigneeCount: 0,
      },
    });
    expect(qualRes).toBeDefined();

    const feasRes = await tools['contrib_assess_feasibility'].handler({
      issue: { title: 'Bug', body: 'fix', state: 'open' },
      techStack: ['typescript'],
    });
    expect(feasRes).toBeDefined();

    const diagRes = await tools['contrib_diagnose_manifests'].handler({
      manifestFiles: ['package.json', 'tsconfig.json'],
    });
    expect(diagRes).toBeDefined();
  });

  it('executes governance, markdown, and CI tools handlers', async () => {
    const mdRes = await tools['contrib_lint_markdown'].handler({
      content: '# Title\n\nValid body text.\n',
    });
    expect(mdRes).toBeDefined();

    const claimRes = await tools['contrib_render_issue_claim'].handler({
      issueNumber: 42,
      issueTitle: 'Security NPE Bug',
      findingSummary: 'Null dereference in auth.go',
    });
    expect(claimRes).toBeDefined();

    const ciRes = await tools['contrib_diagnose_ci'].handler({
      rawLogs: '--- FAIL: TestAuth (0.01s)\n    auth_test.go:42: unexpected error\nFAIL',
    });
    expect(ciRes).toBeDefined();
  });

  it('executes pointer & probe tools handlers', async () => {
    const pointerDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'opencontrib-mcp-pointers-'),
    );
    try {
      const writer = new SmartPointerStore({
        storageDir: pointerDir,
        scope: process.cwd(),
      });
      const pointer = writer.create({
        namespace: 'findings',
        id: 'mcp-cross-process',
        title: 'MCP hydration',
        category: 'security_cwe',
        severity: 'medium',
        file: 'src/index.ts',
        line: 7,
      });

      const ptrList = await tools['contrib_list_pointers'].handler({
        storageDir: pointerDir,
      });
      expect(ptrList).toBeDefined();
      expect(JSON.parse(ptrList.content[0].text).count).toBe(1);

      const ptrRes = await tools['contrib_resolve_pointer'].handler({
        uri: pointer.uri,
        view: 'stub',
        storageDir: pointerDir,
      });
      expect(ptrRes).toBeDefined();
      expect(JSON.parse(ptrRes.content[0].text).data.id).toBe(pointer.id);

      const probePlan = await tools['contrib_probe_plan'].handler({
        target: '.',
        maxCost: 'fast',
      });
      expect(probePlan).toBeDefined();

      const capPlan = await tools['contrib_plan_capabilities'].handler({
        target: '.',
        intent: 'general_defect',
      });
      expect(capPlan).toBeDefined();

      const plugList = await tools['contrib_list_plugins'].handler({});
      expect(plugList).toBeDefined();
    } finally {
      fs.rmSync(pointerDir, { recursive: true, force: true });
    }
  });

  it('executes eval tools handlers with temporary transcript', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrib-mcp-eval-'));
    const transcriptFile = path.join(tempDir, 'transcript.jsonl');
    fs.writeFileSync(
      transcriptFile,
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', content: 'test' }) + '\n',
      'utf8',
    );

    try {
      const prepRes = await tools['contrib_eval_prepare_judge'].handler({
        transcriptPath: transcriptFile,
      });
      expect(prepRes).toBeDefined();

      const parseRes = await tools['contrib_eval_parse_judgment'].handler({
        rawResponse: JSON.stringify({
          scoringRunId: 'eval_1',
          dimensions: {
            empiricalReproduction: { score: 95, confidence: 90, rationale: 'Good' },
            surgicalScope: { score: 90, confidence: 85, rationale: 'Scoped' },
            crossPlatformPortability: { score: 90, confidence: 85, rationale: 'Cross platform' },
            governanceRFCCompliance: { score: 95, confidence: 90, rationale: 'Compliant' },
            zeroShotExecution: { score: 90, confidence: 85, rationale: 'Zero shot' },
          },
          overallVerdict: {
            verdict: 'MERGE_READY',
            compositeScore: 92,
            criticalFlaws: [],
            mergeConfidencePercentage: 92,
            maintainerSummary: 'Excellent fix',
          },
        }),
      });
      expect(parseRes).toBeDefined();
    } finally {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('verifies resources and prompts registration', () => {
    expect(resources['opencontrib://doctor']).toBeDefined();
    expect(resources['opencontrib://memory']).toBeDefined();
    expect(resources['opencontrib://runs']).toBeDefined();
    expect(prompts['opencontrib_workflow_guide']).toBeDefined();
  });
});
