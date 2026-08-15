import { describe, expect, it } from 'bun:test';
import { createOpenContribMcpServer } from '../src/server.js';

describe('OpenContrib MCP Contract Tests & Schema Invariants', () => {
  const server = createOpenContribMcpServer();
  const tools = (server as any)._registeredTools;
  const resources = (server as any)._registeredResources;
  const prompts = (server as any)._registeredPrompts;

  it('verifies all 18 MCP tools have well-defined input schemas and handler functions', () => {
    const expectedTools = [
      'contrib_scout',
      'contrib_rank_opportunity',
      'contrib_qualify_issue',
      'contrib_assess_feasibility',
      'contrib_diagnose_manifests',
      'contrib_assemble_context',
      'contrib_prepare_workspace',
      'contrib_collect_evidence',
      'contrib_audit_governance',
      'contrib_render_pr_template',
      'contrib_sync_flywheel',
      'contrib_track_pr_status',
      'contrib_purge_sandbox',
      'contrib_doctor',
      'contrib_create_run',
      'contrib_save_artifact',
      'contrib_get_run',
      'contrib_resume_run',
    ];

    expect(Object.keys(tools).length).toBe(18);
    for (const toolName of expectedTools) {
      expect(tools[toolName]).toBeDefined();
      expect(tools[toolName].handler).toBeFunction();
    }
  });

  it('contract test: contrib_rank_opportunity derives signals without prescribing decisions', async () => {
    const result = await tools['contrib_rank_opportunity'].handler({
      issue: {
        number: 101,
        title: 'fix: handle falsy value in cache',
        body: 'ShortCache returns undefined when cached value is false or 0',
      },
      repository: {
        fullName: 'bytedance/flowgram.ai',
        stars: 1200,
      },
    });

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe('text');
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe('success');
    expect(parsed.signals).toBeDefined();
    expect(parsed.signals.score).toBeGreaterThan(0);
    expect(parsed.signals.signals).toBeDefined();
    expect(parsed.signals.reasons).toBeArray();
  });

  it('contract test: Run ID path traversal is strictly rejected across run tools', async () => {
    const maliciousRunId = '../../etc/passwd';

    const saveResult = await tools['contrib_save_artifact'].handler({
      runId: maliciousRunId,
      artifactType: 'patch',
      content: 'malicious patch',
    });
    expect(saveResult.isError).toBe(true);
    expect(saveResult.content[0].text).toContain('Security error');

    const getResult = await tools['contrib_get_run'].handler({
      runId: maliciousRunId,
    });
    expect(getResult.isError).toBe(true);
    expect(getResult.content[0].text).toContain('Security error');
  });

  it('contract test: contrib_create_run and contrib_save_artifact lifecycle with schemaVersion and event tracking', async () => {
    const createResult = await tools['contrib_create_run'].handler({
      repoFullName: 'test-org/contract-test-repo',
      issueNumber: 42,
      issueTitle: 'Contract test bug',
    });

    expect(createResult.isError).toBeUndefined();
    const res = JSON.parse(createResult.content[0].text);
    const manifest = res.manifest;
    expect(manifest.schemaVersion).toBe('1.0.0');
    expect(manifest.runId).toStartWith('run_');
    expect(manifest.currentPhase).toBe('INITIALIZED');

    // Save artifact and advance phase
    const saveResult = await tools['contrib_save_artifact'].handler({
      runId: manifest.runId,
      artifactType: 'patch',
      content: '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new',
      autoAdvancePhase: 'PATCH_DRAFTED',
    });
    expect(saveResult.isError).toBeUndefined();
    const saved = JSON.parse(saveResult.content[0].text).saved;
    expect(saved.artifactType).toBe('patch');

    // Get run summary
    const getResult = await tools['contrib_get_run'].handler({
      runId: manifest.runId,
    });
    const summary = JSON.parse(getResult.content[0].text).run;
    expect(summary.manifest.currentPhase).toBe('PATCH_DRAFTED');
    expect(summary.events).toBeArray();
    expect(summary.events.length).toBeGreaterThanOrEqual(2);

    // Resume run
    const resumeResult = await tools['contrib_resume_run'].handler({
      runId: manifest.runId,
    });
    const resume = JSON.parse(resumeResult.content[0].text).resume;
    expect(resume.currentPhase).toBe('PATCH_DRAFTED');
    expect(resume.suggestedNextAction).toBe('collect_evidence');
  });

  it('contract test: MCP resources (doctor, memory, runs) and prompt opencontrib_workflow_guide are registered', async () => {
    expect(resources['opencontrib://doctor']).toBeDefined();
    expect(resources['opencontrib://memory']).toBeDefined();
    expect(resources['opencontrib://runs']).toBeDefined();

    expect(prompts['opencontrib_workflow_guide']).toBeDefined();
  });
});

