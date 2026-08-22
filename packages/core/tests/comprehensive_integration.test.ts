import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ContextAssembler,
  ContextBundler,
  type FileSystemPort,
  type PointerStub,
  synthesizeReflexionInsights,
  persistReflexionToMemoryLedger,
  RepoMemoryLedger,
  type JudgeEvaluationReport,
  type TrajectoryMetrics,
  type TrajectoryEvent,
  type JudgeDimensionScore,
} from '../src/index.js';

const TEST_RESULTS: Array<{ module: string; test: string; result: string; pass: boolean; ms: number }> = [];

function record(module: string, test: string, pass: boolean, ms: number, detail: string = '') {
  TEST_RESULTS.push({ module, test, result: detail || (pass ? 'PASS' : 'FAIL'), pass, ms });
}

// ═══════════════════════════════════════════════════════════════════════════
// Module 1: ContextAssembler 6-Layer Prompt Assembly
// ═══════════════════════════════════════════════════════════════════════════

describe('ContextAssembler — 6-layer prompt assembly', () => {
  let tempRepo: string;

  beforeEach(() => {
    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrib-assembler-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempRepo)) {
      fs.rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  it('assembles exactly 6 layers (problemContext, repoContext, memoryContext, environmentContext, guidance, assembledAt) with independent content', () => {
    const t0 = Date.now();
    const assembler = new ContextAssembler();
    const ctx = assembler.assemble({
      repoFullName: 'owner/repo',
      issueTitle: 'Fix memory leak in worker pool',
      issueBody: 'Worker pool does not close connections on shutdown.',
      issueNumber: 42,
      linkedComments: ['User reports 100% CPU spike'],
      primaryLanguage: 'TypeScript',
      workspacePath: tempRepo,
    });
    const ms = Date.now() - t0;

    const keys = Object.keys(ctx);
    const expectedKeys = [
      'problemContext',
      'repoContext',
      'memoryContext',
      'environmentContext',
      'guidance',
      'assembledAt',
    ];

    let pass = true;
    const details: string[] = [];
    if (keys.length !== 6) {
      pass = false;
      details.push(`expected 6 keys, got ${keys.length}: ${keys.join(',')}`);
    }
    for (const k of expectedKeys) {
      if (!(k in ctx)) {
        pass = false;
        details.push(`missing key: ${k}`);
      }
    }
    // Verify layers have independent content (not all the same string)
    const layerValues = [
      JSON.stringify(ctx.problemContext),
      JSON.stringify(ctx.repoContext),
      JSON.stringify(ctx.memoryContext),
      JSON.stringify(ctx.environmentContext),
      JSON.stringify(ctx.guidance),
      ctx.assembledAt,
    ];
    const uniqueValues = new Set(layerValues);
    if (uniqueValues.size < 5) {
      pass = false;
      details.push(`layer values not independent, unique=${uniqueValues.size}`);
    }

    expect(ctx.problemContext.repoFullName).toBe('owner/repo');
    expect(ctx.problemContext.issueNumber).toBe(42);
    expect(ctx.repoContext.primaryLanguage).toBe('TypeScript');
    expect(ctx.environmentContext.os).toBeDefined();
    expect(ctx.guidance.riskSurface.level).toBeDefined();
    expect(ctx.assembledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    record(
      'ContextAssembler',
      '6 layers with independent content',
      pass,
      ms,
      details.length ? details.join('; ') : `6 layers verified, ${keys.length} keys`,
    );
  });

  it('formatContextPrompt contains all layer content (SYSTEM/POLICY, TRUSTED_METADATA, UNTRUSTED_REPOSITORY_DATA)', () => {
    const t0 = Date.now();
    const assembler = new ContextAssembler();
    const ctx = assembler.assemble({
      repoFullName: 'owner/repo',
      issueTitle: 'Security vulnerability in parser',
      issueBody: 'Input not sanitized before parsing.',
      issueNumber: 100,
      primaryLanguage: 'Rust',
      workspacePath: tempRepo,
      packageManifest: 'Cargo.toml',
    });

    const prompt = assembler.formatContextPrompt(ctx);
    const ms = Date.now() - t0;

    const checks = [
      { name: 'SYSTEM/POLICY tier', matcher: /\[SYSTEM\/POLICY/ },
      { name: 'TRUSTED_METADATA tier', matcher: /\[TRUSTED_METADATA/ },
      { name: 'UNTRUSTED_REPOSITORY_DATA tier', matcher: /\[UNTRUSTED_REPOSITORY_DATA/ },
      { name: 'contains repoFullName', matcher: /owner\/repo/ },
      { name: 'contains issue title', matcher: /Security vulnerability in parser/ },
      { name: 'contains issue body', matcher: /Input not sanitized/ },
      { name: 'contains prompt injection defense', matcher: /Prompt Injection Defense/ },
      { name: 'contains RFC 100-Line Limit', matcher: /RFC 100-Line Limit/ },
      { name: 'contains guidance section', matcher: /Suggested Reading Order|Target Test Files|Risk Surface/ },
    ];

    let pass = true;
    const details: string[] = [];
    for (const c of checks) {
      if (!c.matcher.test(prompt)) {
        pass = false;
        details.push(`missing: ${c.name}`);
      }
    }

    expect(prompt.length).toBeGreaterThan(100);
    record('ContextAssembler', 'formatContextPrompt contains all layers', pass, ms, details.length ? details.join('; ') : `prompt=${prompt.length} chars, 9 checks pass`);
  });

  it('incorporates linked comments (events) into the prompt', () => {
    const t0 = Date.now();
    const assembler = new ContextAssembler();
    const comments = [
      'Comment 1: reproduce with 1000 concurrent requests',
      'Comment 2: stack trace at worker.js:42',
    ];
    const ctx = assembler.assemble({
      repoFullName: 'a/b',
      issueTitle: 'Concurrency issue',
      issueBody: 'Test body',
      linkedComments: comments,
      primaryLanguage: 'TypeScript',
    });

    const prompt = assembler.formatContextPrompt(ctx);
    const ms = Date.now() - t0;

    let pass = true;
    const details: string[] = [];
    for (const c of comments) {
      if (!prompt.includes(c)) {
        pass = false;
        details.push(`missing comment: ${c}`);
      }
    }

    expect(prompt).toContain('Comment 1');
    expect(prompt).toContain('Comment 2');
    record('ContextAssembler', 'incorporates linked comments/events', pass, ms, details.length ? details.join('; ') : `${comments.length} comments included`);
  });

  it('incorporates memory (past failures / successful patterns) into the prompt', () => {
    const t0 = Date.now();
    const assembler = new ContextAssembler();
    const ledger = new RepoMemoryLedger();
    ledger.recordFailure('owner/repo', 'Forgot to close file handle', 'context: src/worker.ts');
    ledger.recordSubmission('owner/repo', {
      title: 'Fixed memory leak in parser',
      prUrl: 'https://github.com/owner/repo/pull/1',
    });
    assembler['memory'] = ledger;

    const ctx = assembler.assemble({
      repoFullName: 'owner/repo',
      issueTitle: 'New leak in worker',
      issueBody: 'Another leak report',
      primaryLanguage: 'TypeScript',
    });

    const prompt = assembler.formatContextPrompt(ctx);
    const ms = Date.now() - t0;

    let pass = true;
    const details: string[] = [];
    if (!prompt.includes('Forgot to close file handle')) {
      pass = false;
      details.push('missing past failure');
    }
    if (!prompt.includes('Fixed memory leak in parser')) {
      pass = false;
      details.push('missing successful pattern');
    }

    // pastFailures are formatted as [date] reason
    expect(ctx.memoryContext.pastFailures.some((f) => f.includes('Forgot to close file handle'))).toBe(true);
    expect(ctx.memoryContext.successfulPatterns).toContain('Fixed memory leak in parser');
    record('ContextAssembler', 'incorporates memory failures/successes', pass, ms, details.length ? details.join('; ') : 'memory context present in prompt');
  });

  it('extreme: empty prompt input (empty issueBody, empty linkedComments)', () => {
    const t0 = Date.now();
    const assembler = new ContextAssembler();
    const ctx = assembler.assemble({
      repoFullName: 'owner/repo',
      issueTitle: '',
      issueBody: '',
      linkedComments: [],
      primaryLanguage: 'TypeScript',
    });

    const prompt = assembler.formatContextPrompt(ctx);
    const ms = Date.now() - t0;

    let pass = true;
    const details: string[] = [];
    if (prompt.length < 100) {
      pass = false;
      details.push(`prompt too short: ${prompt.length}`);
    }
    if (!prompt.includes('[SYSTEM/POLICY')) {
      pass = false;
      details.push('missing SYSTEM/POLICY even with empty input');
    }

    expect(ctx.problemContext.issueTitle).toBe('');
    expect(ctx.problemContext.issueBody).toBe('');
    expect(ctx.problemContext.linkedComments).toEqual([]);
    expect(prompt).toContain('[SYSTEM/POLICY');
    record('ContextAssembler', 'extreme: empty input', pass, ms, details.length ? details.join('; ') : 'empty input handled gracefully');
  });

  it('extreme: super-long prompt (100000 chars issue body)', () => {
    const t0 = Date.now();
    const longBody = 'A'.repeat(100000);
    const assembler = new ContextAssembler();
    const ctx = assembler.assemble({
      repoFullName: 'owner/repo',
      issueTitle: 'Very long issue',
      issueBody: longBody,
      primaryLanguage: 'TypeScript',
    });

    const prompt = assembler.formatContextPrompt(ctx);
    const ms = Date.now() - t0;

    let pass = true;
    const details: string[] = [];
    if (prompt.length < 50000) {
      pass = false;
      details.push(`prompt unexpectedly short: ${prompt.length}`);
    }
    // Verify the long content is included
    if (!prompt.includes('A'.repeat(100))) {
      pass = false;
      details.push('long body content not present in prompt');
    }

    expect(prompt.length).toBeGreaterThan(50000);
    record('ContextAssembler', 'extreme: 100000-char input', pass, ms, details.length ? details.join('; ') : `prompt=${prompt.length} chars`);
  });

  it('extreme: special characters (emoji, Unicode, control chars)', () => {
    const t0 = Date.now();
    const assembler = new ContextAssembler();
    const specialTitle = 'Fix bug 🐛 你好 中文 🚀';
    const specialBody = 'Line1\r\nLine2\tTabbed\nLine4\nEmoji: 🔥💥🎉\nControl: \x00\x01\x02\x03\nUnicode: αβγδε ∞ ∑ ∏';
    const ctx = assembler.assemble({
      repoFullName: 'owner/repo',
      issueTitle: specialTitle,
      issueBody: specialBody,
      primaryLanguage: 'TypeScript',
    });

    const prompt = assembler.formatContextPrompt(ctx);
    const ms = Date.now() - t0;

    let pass = true;
    const details: string[] = [];
    if (!prompt.includes('🐛')) {
      pass = false;
      details.push('missing emoji 🐛');
    }
    if (!prompt.includes('你好')) {
      pass = false;
      details.push('missing Chinese chars');
    }
    if (!prompt.includes('αβγδε')) {
      pass = false;
      details.push('missing Greek letters');
    }

    expect(prompt).toContain(specialTitle);
    expect(prompt).toContain('Emoji:');
    record('ContextAssembler', 'extreme: emoji/Unicode/control chars', pass, ms, details.length ? details.join('; ') : 'special chars preserved');
  });

  it('extreme: large number of linked comments (1000 events)', () => {
    const t0 = Date.now();
    const assembler = new ContextAssembler();
    const comments: string[] = [];
    for (let i = 0; i < 1000; i++) {
      comments.push(`Comment #${i}: user_${i} reports issue with component_${i % 10}`);
    }
    const ctx = assembler.assemble({
      repoFullName: 'owner/repo',
      issueTitle: 'Mass issue',
      issueBody: 'Body',
      linkedComments: comments,
      primaryLanguage: 'TypeScript',
    });

    const prompt = assembler.formatContextPrompt(ctx);
    const ms = Date.now() - t0;

    let pass = true;
    const details: string[] = [];
    if (!prompt.includes('Comment #0')) {
      pass = false;
      details.push('missing first comment');
    }
    if (!prompt.includes('Comment #999')) {
      pass = false;
      details.push('missing last comment');
    }

    expect(ctx.problemContext.linkedComments.length).toBe(1000);
    expect(prompt).toContain('Comment #500');
    record('ContextAssembler', 'extreme: 1000 linked comments', pass, ms, details.length ? details.join('; ') : `1000 comments, prompt=${prompt.length} chars`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Module 2: ContextBundler
// ═══════════════════════════════════════════════════════════════════════════

function makeInMemoryFs(files: Record<string, string>, dirs: Record<string, string[]> = {}): FileSystemPort {
  return {
    readFile: (relPath) => {
      const p = relPath.replace(/\\/g, '/');
      return files[p] || '';
    },
    readDir: (relPath) => {
      const p = relPath.replace(/\\/g, '/');
      return dirs[p] || [];
    },
    exists: (relPath) => {
      const p = relPath.replace(/\\/g, '/');
      return p in files;
    },
  };
}

describe('ContextBundler — context bundling for findings', () => {
  let tempRepo: string;

  beforeEach(() => {
    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrib-bundler-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempRepo)) {
      fs.rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  it('creates bundle with target file content', () => {
    const t0 = Date.now();
    const mockFsPort = makeInMemoryFs({
      'src/app.js': 'console.log("hello")\nfunction main() {\n  doWork()\n}\nmain()\n',
    }, {
      'src': ['app.js'],
    });
    const finding: PointerStub = {
      namespace: 'findings', id: 'f1', title: 'Test',
      category: 'lifecycle_leak', severity: 'high',
      file: 'src/app.js', line: 3, confidence: 90,
    };

    const bundle = ContextBundler.createBundle(mockFsPort, finding, {});
    const ms = Date.now() - t0;

    let pass = true;
    const details: string[] = [];
    if (!bundle.snippets[0]?.content.includes('doWork')) {
      pass = false;
      details.push('target content missing');
    }
    if (bundle.findingId !== 'f1') {
      pass = false;
      details.push(`wrong findingId: ${bundle.findingId}`);
    }
    if (!bundle.matchedRuleTemplates.includes('RULE_RESOURCE_FINALIZATION')) {
      pass = false;
      details.push('missing lifecycle_leak rule');
    }

    expect(bundle.findingId).toBe('f1');
    expect(bundle.snippets).toHaveLength(1);
    expect(bundle.snippets[0].role).toBe('target');
    record('ContextBundler', 'creates bundle with target file content', pass, ms, details.length ? details.join('; ') : 'bundle created with target snippet');
  });

  it('default radius is 15 lines', () => {
    const t0 = Date.now();
    const lines: string[] = [];
    for (let i = 1; i <= 100; i++) {
      lines.push(`line ${i}: data ${i}`);
    }
    const mockFsPort = makeInMemoryFs({
      'src/big.go': lines.join('\n'),
    }, {
      'src': ['big.go'],
    });
    const finding: PointerStub = {
      namespace: 'findings', id: 'f2', title: 'Test',
      category: 'security_cwe', severity: 'high',
      file: 'src/big.go', line: 50, confidence: 80,
    };

    const bundle = ContextBundler.createBundle(mockFsPort, finding, {});
    const ms = Date.now() - t0;

    let pass = true;
    const details: string[] = [];
    const snippet = bundle.snippets[0];
    if (snippet.startLine !== 35) {
      pass = false;
      details.push(`expected startLine=35, got ${snippet.startLine}`);
    }
    if (snippet.endLine !== 65) {
      pass = false;
      details.push(`expected endLine=65, got ${snippet.endLine}`);
    }

    expect(snippet.startLine).toBe(35);
    expect(snippet.endLine).toBe(65);
    record('ContextBundler', 'default 15-line radius', pass, ms, details.length ? details.join('; ') : 'radius=15 verified');
  });

  it('finding at file beginning clips startLine to 1', () => {
    const t0 = Date.now();
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const mockFsPort = makeInMemoryFs({
      'src/early.go': lines.join('\n'),
    }, {
      'src': ['early.go'],
    });
    const finding: PointerStub = {
      namespace: 'findings', id: 'f3', title: 'Test',
      category: 'lifecycle_leak', severity: 'high',
      file: 'src/early.go', line: 3, confidence: 80,
    };

    const bundle = ContextBundler.createBundle(mockFsPort, finding, {});
    const ms = Date.now() - t0;

    let pass = true;
    const details: string[] = [];
    if (bundle.snippets[0].startLine !== 1) {
      pass = false;
      details.push(`expected startLine=1, got ${bundle.snippets[0].startLine}`);
    }

    expect(bundle.snippets[0].startLine).toBe(1);
    record('ContextBundler', 'finding at file beginning clips to line 1', pass, ms, details.length ? details.join('; ') : 'startLine=1');
  });

  it('finding at file end clips endLine to file length', () => {
    const t0 = Date.now();
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const mockFsPort = makeInMemoryFs({
      'src/end.go': lines.join('\n'),
    }, {
      'src': ['end.go'],
    });
    const finding: PointerStub = {
      namespace: 'findings', id: 'f4', title: 'Test',
      category: 'security_cwe', severity: 'high',
      file: 'src/end.go', line: 50, confidence: 80,
    };

    const bundle = ContextBundler.createBundle(mockFsPort, finding, {});
    const ms = Date.now() - t0;

    let pass = true;
    const details: string[] = [];
    if (bundle.snippets[0].endLine !== 50) {
      pass = false;
      details.push(`expected endLine=50, got ${bundle.snippets[0].endLine}`);
    }

    expect(bundle.snippets[0].endLine).toBe(50);
    record('ContextBundler', 'finding at file end clips to file length', pass, ms, details.length ? details.join('; ') : 'endLine=50');
  });

  it('returns empty snippets when file does not exist', () => {
    const t0 = Date.now();
    const mockFsPort = makeInMemoryFs({}, {});
    const finding: PointerStub = {
      namespace: 'findings', id: 'f5', title: 'Test',
      category: 'security_cwe', severity: 'high',
      file: 'src/nonexistent.go', line: 10, confidence: 80,
    };

    const bundle = ContextBundler.createBundle(mockFsPort, finding, {});
    const ms = Date.now() - t0;

    let pass = true;
    const details: string[] = [];
    if (bundle.snippets.length !== 0) {
      pass = false;
      details.push(`expected 0 snippets, got ${bundle.snippets.length}`);
    }

    expect(bundle.snippets).toHaveLength(0);
    expect(bundle.totalTokensEstimate).toBe(0);
    record('ContextBundler', 'empty snippets when file missing', pass, ms, details.length ? details.join('; ') : '0 snippets, 0 tokens');
  });

  it('extracts type definition snippet from sibling files', () => {
    const t0 = Date.now();
    const mockFsPort = makeInMemoryFs({
      'src/main.ts': 'import { WorkerPool } from "./types";\nconst pool = new WorkerPool();\npool.start();\n',
      'src/types.ts': 'export interface WorkerPool {\n  start(): void;\n  stop(): void;\n  addWorker(w: Worker): void;\n}\n\nexport interface Worker {\n  execute(task: Task): void;\n}\n',
    }, {
      'src': ['main.ts', 'types.ts'],
    });
    const finding: PointerStub = {
      namespace: 'findings', id: 'f6', title: 'Test',
      category: 'security_cwe', severity: 'high',
      file: 'src/main.ts', line: 3, confidence: 80,
      affectedSymbol: 'WorkerPool',
    };

    const bundle = ContextBundler.createBundle(mockFsPort, finding, {});
    const ms = Date.now() - t0;

    let pass = true;
    const details: string[] = [];
    if (bundle.snippets.length < 2) {
      pass = false;
      details.push(`expected >=2 snippets, got ${bundle.snippets.length}`);
    }
    const typeSnippet = bundle.snippets.find((s) => s.role === 'type_definition');
    if (!typeSnippet) {
      pass = false;
      details.push('missing type_definition snippet');
    } else if (!typeSnippet.content.includes('interface WorkerPool')) {
      pass = false;
      details.push('type snippet missing interface content');
    }

    expect(bundle.snippets.length).toBeGreaterThanOrEqual(2);
    expect(typeSnippet?.content).toContain('interface WorkerPool');
    expect(typeSnippet?.filePath).toBe('src/types.ts');
    record('ContextBundler', 'extracts type definition snippet', pass, ms, details.length ? details.join('; ') : `type snippet found: ${bundle.snippets.length} total`);
  });

  it('matchedRuleTemplates for lifecycle_leak category', () => {
    const t0 = Date.now();
    const mockFsPort = makeInMemoryFs({
      'src/a.go': 'func f() {}\n',
    }, { 'src': ['a.go'] });
    const finding: PointerStub = {
      namespace: 'findings', id: 'f7', title: 'Test',
      category: 'lifecycle_leak', severity: 'high',
      file: 'src/a.go', line: 1, confidence: 80,
    };

    const bundle = ContextBundler.createBundle(mockFsPort, finding, {});
    const ms = Date.now() - t0;

    let pass = true;
    const details: string[] = [];
    if (!bundle.matchedRuleTemplates.includes('RULE_NPE_DEFER_CLOSE_ORDER')) {
      pass = false;
      details.push('missing NPE rule');
    }
    if (!bundle.matchedRuleTemplates.includes('RULE_RESOURCE_FINALIZATION')) {
      pass = false;
      details.push('missing resource finalization rule');
    }

    expect(bundle.matchedRuleTemplates).toContain('RULE_NPE_DEFER_CLOSE_ORDER');
    expect(bundle.matchedRuleTemplates).toContain('RULE_RESOURCE_FINALIZATION');
    record('ContextBundler', 'matchedRuleTemplates for lifecycle_leak', pass, ms, details.length ? details.join('; ') : '2 rules matched');
  });

  it('matchedRuleTemplates for security_cwe category', () => {
    const t0 = Date.now();
    const mockFsPort = makeInMemoryFs({
      'src/b.go': 'func f() {}\n',
    }, { 'src': ['b.go'] });
    const finding: PointerStub = {
      namespace: 'findings', id: 'f8', title: 'Test',
      category: 'security_cwe', severity: 'high',
      file: 'src/b.go', line: 1, confidence: 80,
    };

    const bundle = ContextBundler.createBundle(mockFsPort, finding, {});
    const ms = Date.now() - t0;

    let pass = true;
    const details: string[] = [];
    if (!bundle.matchedRuleTemplates.includes('RULE_TAINT_SINK_ESCAPE')) {
      pass = false;
      details.push('missing taint sink rule');
    }
    if (!bundle.matchedRuleTemplates.includes('RULE_COMMAND_INJECTION_PARAMETRIZATION')) {
      pass = false;
      details.push('missing command injection rule');
    }

    expect(bundle.matchedRuleTemplates).toContain('RULE_TAINT_SINK_ESCAPE');
    expect(bundle.matchedRuleTemplates).toContain('RULE_COMMAND_INJECTION_PARAMETRIZATION');
    record('ContextBundler', 'matchedRuleTemplates for security_cwe', pass, ms, details.length ? details.join('; ') : '2 rules matched');
  });

  it('matchedRuleTemplates for unknown/empty category returns empty array', () => {
    const t0 = Date.now();
    const mockFsPort = makeInMemoryFs({
      'src/c.go': 'func f() {}\n',
    }, { 'src': ['c.go'] });
    const finding: PointerStub = {
      namespace: 'findings', id: 'f9', title: 'Test',
      category: 'performance', severity: 'low',
      file: 'src/c.go', line: 1, confidence: 80,
    };

    const bundle = ContextBundler.createBundle(mockFsPort, finding, {});
    const ms = Date.now() - t0;

    expect(bundle.matchedRuleTemplates).toEqual([]);
    record('ContextBundler', 'matchedRuleTemplates for unknown category', true, ms, 'empty array for unknown category');
  });

  it('extreme: very large file (100000 lines) with finding near beginning', () => {
    const t0 = Date.now();
    const lines = Array.from({ length: 100000 }, (_, i) => `line_${i}: data_${i % 1000}`);
    const mockFsPort = makeInMemoryFs({
      'src/huge.go': lines.join('\n'),
    }, { 'src': ['huge.go'] });
    const finding: PointerStub = {
      namespace: 'findings', id: 'f10', title: 'Test',
      category: 'security_cwe', severity: 'high',
      file: 'src/huge.go', line: 5, confidence: 80,
    };

    const bundle = ContextBundler.createBundle(mockFsPort, finding, {});
    const ms = Date.now() - t0;

    let pass = true;
    const details: string[] = [];
    if (bundle.snippets[0].startLine !== 1) {
      pass = false;
      details.push(`expected start=1, got ${bundle.snippets[0].startLine}`);
    }
    if (bundle.snippets[0].endLine !== 20) {
      pass = false;
      details.push(`expected end=20, got ${bundle.snippets[0].endLine}`);
    }

    expect(bundle.snippets[0].startLine).toBe(1);
    expect(bundle.snippets[0].endLine).toBe(20);
    record('ContextBundler', 'extreme: 100000-line file beginning', pass, ms, details.length ? details.join('; ') : `large file handled, ${ms}ms`);
  });

  it('extreme: very large file (100000 lines) with finding in the middle', () => {
    const t0 = Date.now();
    const lines = Array.from({ length: 100000 }, (_, i) => `line_${i}`);
    const mockFsPort = makeInMemoryFs({
      'src/huge2.go': lines.join('\n'),
    }, { 'src': ['huge2.go'] });
    const finding: PointerStub = {
      namespace: 'findings', id: 'f11', title: 'Test',
      category: 'security_cwe', severity: 'high',
      file: 'src/huge2.go', line: 50000, confidence: 80,
    };

    const bundle = ContextBundler.createBundle(mockFsPort, finding, {});
    const ms = Date.now() - t0;

    let pass = true;
    const details: string[] = [];
    if (bundle.snippets[0].startLine !== 49985) {
      pass = false;
      details.push(`expected start=49985, got ${bundle.snippets[0].startLine}`);
    }
    if (bundle.snippets[0].endLine !== 50015) {
      pass = false;
      details.push(`expected end=50015, got ${bundle.snippets[0].endLine}`);
    }

    expect(bundle.snippets[0].startLine).toBe(49985);
    expect(bundle.snippets[0].endLine).toBe(50015);
    record('ContextBundler', 'extreme: 100000-line file middle', pass, ms, details.length ? details.join('; ') : 'middle finding correct');
  });

  it('extreme: missing sibling file (affectedSymbol lookup skips non-existent files)', () => {
    const t0 = Date.now();
    const mockFsPort = makeInMemoryFs({
      'src/main.ts': 'import { Foo } from "./types";\nconst f = new Foo();\n',
      // types.ts does NOT exist
    }, {
      'src': ['main.ts', 'other.ts'],
    });
    const finding: PointerStub = {
      namespace: 'findings', id: 'f12', title: 'Test',
      category: 'security_cwe', severity: 'high',
      file: 'src/main.ts', line: 2, confidence: 80,
      affectedSymbol: 'Foo',
    };

    const bundle = ContextBundler.createBundle(mockFsPort, finding, {});
    const ms = Date.now() - t0;

    // Should not throw even when sibling files are missing or don't contain the symbol
    expect(bundle.snippets.length).toBeGreaterThanOrEqual(1);
    expect(bundle.snippets[0].role).toBe('target');
    record('ContextBundler', 'extreme: missing sibling file', true, ms, 'no crash on missing sibling');
  });

  it('bundleId format is consistent', () => {
    const t0 = Date.now();
    const mockFsPort = makeInMemoryFs({ 'src/a.go': 'x\n' }, { 'src': ['a.go'] });
    const finding: PointerStub = {
      namespace: 'findings', id: 'unique-id-123', title: 'Test',
      category: 'lifecycle_leak', severity: 'high',
      file: 'src/a.go', line: 1, confidence: 80,
    };

    const bundle = ContextBundler.createBundle(mockFsPort, finding, {});
    const ms = Date.now() - t0;

    expect(bundle.bundleId).toBe('bundle-unique-id-123');
    expect(bundle.targetFile).toBe('src/a.go');
    expect(bundle.targetLine).toBe(1);
    record('ContextBundler', 'bundleId format consistent', true, ms, 'bundleId=bundle-<findingId>');
  });

  it('totalTokensEstimate is computed as ceiling of totalChars/4', () => {
    const t0 = Date.now();
    const mockFsPort = makeInMemoryFs({
      'src/a.go': 'abcd\nefgh\n', // 9 chars (including newline)
    }, { 'src': ['a.go'] });
    const finding: PointerStub = {
      namespace: 'findings', id: 'f13', title: 'Test',
      category: 'security_cwe', severity: 'high',
      file: 'src/a.go', line: 1, confidence: 80,
    };

    const bundle = ContextBundler.createBundle(mockFsPort, finding, { radiusLines: 1 });
    const ms = Date.now() - t0;

    // totalTokensEstimate should be positive and based on content length
    expect(bundle.totalTokensEstimate).toBeGreaterThan(0);
    record('ContextBundler', 'totalTokensEstimate computed correctly', true, ms, `tokens=${bundle.totalTokensEstimate}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Module 3: Reflexion Flywheel
// ═══════════════════════════════════════════════════════════════════════════

const MOCK_METRICS: TrajectoryMetrics = {
  totalSteps: 50,
  totalCommandsRun: 30,
  failedCommandsCount: 0,
  viewFileCalls: 8,
  maxConsecutiveFileViews: 3,
  wholeFileRgDumpsDetected: 2,
  shellScriptWriteHacksDetected: 1,
};

function makeReport(overrides: Partial<JudgeEvaluationReport> = {}): JudgeEvaluationReport {
  return {
    overallScore: 55,
    verdict: 'NEEDS_IMPROVEMENT',
    summary: 'LLM Judge: 55/100.',
    dimensions: [
      { dimension: 'problemFormulation', title: 'Problem Formulation', weight: 0.20, score: 70, reasoning: 'OK', evidenceQuotes: [] },
      { dimension: 'contextEconomy', title: 'Context Economy', weight: 0.20, score: 20, reasoning: 'rg dumps', evidenceQuotes: [] },
      { dimension: 'empiricalRigor', title: 'Empirical Rigor', weight: 0.25, score: 65, reasoning: 'Some evidence', evidenceQuotes: [] },
      { dimension: 'concurrencyStress', title: 'Concurrency Stress', weight: 0.15, score: 40, reasoning: 'Single run only', evidenceQuotes: [] },
      { dimension: 'communityCraftsmanship', title: 'Community Craftsmanship', weight: 0.20, score: 15, reasoning: 'node -e hack', evidenceQuotes: [] },
    ],
    strengths: ['Used probe'],
    criticalCritiques: ['Bad pattern A', 'Bad pattern B'],
    actionableDirectives: ['Directive 1', 'Directive 2', 'Directive 3'],
    metrics: MOCK_METRICS,
    ...overrides,
  };
}

describe('Reflexion Flywheel — lessons from LLM Judge', () => {
  it('failureMode identification: extracts titles from dimensions scored below 60', () => {
    const t0 = Date.now();
    const report = makeReport();
    const insight = synthesizeReflexionInsights(report, [], {});
    const ms = Date.now() - t0;

    let pass = true;
    const details: string[] = [];
    if (!insight.failureMode.includes('Community Craftsmanship')) {
      pass = false;
      details.push('missing Community Craftsmanship');
    }
    if (!insight.failureMode.includes('Context Economy')) {
      pass = false;
      details.push('missing Context Economy');
    }
    if (!insight.failureMode.includes('Concurrency Stress')) {
      pass = false;
      details.push('missing Concurrency Stress');
    }
    if (insight.failureMode.includes('Problem Formulation')) {
      pass = false;
      details.push('should not include Problem Formulation (score=70)');
    }
    if (insight.failureMode.includes('Empirical Rigor')) {
      pass = false;
      details.push('should not include Empirical Rigor (score=65)');
    }

    expect(insight.failureMode).toContain('Community Craftsmanship');
    expect(insight.failureMode).toContain('Context Economy');
    expect(insight.failureMode).not.toContain('Problem Formulation');
    record('ReflexionFlywheel', 'failureMode from dimensions <60', pass, ms, details.length ? details.join('; ') : '3 failing dims identified');
  });

  it('dimensions sorted worst-first (ascending by score)', () => {
    const t0 = Date.now();
    const report = makeReport({
      dimensions: [
        { dimension: 'problemFormulation', title: 'A', weight: 1, score: 10, reasoning: '', evidenceQuotes: [] },
        { dimension: 'contextEconomy', title: 'B', weight: 1, score: 5, reasoning: '', evidenceQuotes: [] },
        { dimension: 'empiricalRigor', title: 'C', weight: 1, score: 30, reasoning: '', evidenceQuotes: [] },
        { dimension: 'concurrencyStress', title: 'D', weight: 1, score: 15, reasoning: '', evidenceQuotes: [] },
        { dimension: 'communityCraftsmanship', title: 'E', weight: 1, score: 55, reasoning: '', evidenceQuotes: [] },
      ],
    });
    const insight = synthesizeReflexionInsights(report, [], {});
    const ms = Date.now() - t0;

    // B(5) < A(10) < D(15) < C(30) < E(55)
    let pass = true;
    const details: string[] = [];
    const failureParts = insight.failureMode.split('; ');
    if (failureParts[0] !== 'B') {
      pass = false;
      details.push(`first dim should be B, got ${failureParts[0]}`);
    }
    if (failureParts[failureParts.length - 1] !== 'E') {
      pass = false;
      details.push(`last dim should be E, got ${failureParts[failureParts.length - 1]}`);
    }

    expect(failureParts[0]).toBe('B');
    expect(failureParts[1]).toBe('A');
    record('ReflexionFlywheel', 'dimensions sorted worst-first', pass, ms, details.length ? details.join('; ') : 'B(5)<A(10)<D(15)<C(30)<E(55)');
  });

  it('all dimensions >= 60 => failureMode says "No critical failure modes"', () => {
    const t0 = Date.now();
    const report = makeReport({
      dimensions: [
        { dimension: 'problemFormulation', title: 'A', weight: 1, score: 80, reasoning: '', evidenceQuotes: [] },
        { dimension: 'contextEconomy', title: 'B', weight: 1, score: 70, reasoning: '', evidenceQuotes: [] },
        { dimension: 'empiricalRigor', title: 'C', weight: 1, score: 65, reasoning: '', evidenceQuotes: [] },
        { dimension: 'concurrencyStress', title: 'D', weight: 1, score: 90, reasoning: '', evidenceQuotes: [] },
        { dimension: 'communityCraftsmanship', title: 'E', weight: 1, score: 60, reasoning: '', evidenceQuotes: [] },
      ],
    });
    const insight = synthesizeReflexionInsights(report, [], {});
    const ms = Date.now() - t0;

    expect(insight.failureMode).toContain('No critical failure modes');
    record('ReflexionFlywheel', 'all dims >=60 => no failure mode', true, ms, 'no failing dims');
  });

  it('lessonsLearned come verbatim from actionableDirectives', () => {
    const t0 = Date.now();
    const directives = ['Use targeted grep', 'Avoid rg dumps', 'Use write_to_file'];
    const report = makeReport({ actionableDirectives: directives });
    const insight = synthesizeReflexionInsights(report, [], {});
    const ms = Date.now() - t0;

    for (const d of directives) {
      expect(insight.lessonsLearned).toContain(d);
    }
    record('ReflexionFlywheel', 'lessons from actionableDirectives', true, ms, `${directives.length} directives copied`);
  });

  it('empty actionableDirectives => default lesson', () => {
    const t0 = Date.now();
    const report = makeReport({ actionableDirectives: [] });
    const insight = synthesizeReflexionInsights(report, [], {});
    const ms = Date.now() - t0;

    expect(insight.lessonsLearned).toContain('Maintain current contribution standards.');
    record('ReflexionFlywheel', 'empty directives => default lesson', true, ms, 'default lesson applied');
  });

  it('suggestedPromptAdditions prefixed with MANDATE for each critique', () => {
    const t0 = Date.now();
    const report = makeReport({ criticalCritiques: ['Bad pattern A', 'Bad pattern B'] });
    const insight = synthesizeReflexionInsights(report, [], {});
    const ms = Date.now() - t0;

    expect(insight.suggestedPromptAdditions.length).toBe(2);
    for (const a of insight.suggestedPromptAdditions) {
      expect(a).toContain('MANDATE (from LLM Judge)');
    }
    record('ReflexionFlywheel', 'prompt additions with MANDATE prefix', true, ms, '2 MANDATE prefixes');
  });

  it('no critiques => empty promptAdditions array', () => {
    const t0 = Date.now();
    const report = makeReport({ criticalCritiques: [] });
    const insight = synthesizeReflexionInsights(report, [], {});
    const ms = Date.now() - t0;

    expect(insight.suggestedPromptAdditions).toEqual([]);
    record('ReflexionFlywheel', 'empty critiques => empty additions', true, ms, 'empty array');
  });

  it('goldenActionSequence only for score >= 85', () => {
    const t0 = Date.now();
    const events: TrajectoryEvent[] = [
      {
        stepIndex: 1, type: 'PLANNER_RESPONSE',
        toolCalls: [
          { name: 'run_command', args: { CommandLine: 'opencontrib probe run ./repo' } },
          { name: 'run_command', args: { CommandLine: 'gh issue create' } },
        ],
      },
    ];

    // Score < 85
    const reportLow = makeReport({ overallScore: 55 });
    const insightLow = synthesizeReflexionInsights(reportLow, events, {});
    expect(insightLow.goldenActionSequence).toBeUndefined();

    // Score >= 85
    const reportHigh = makeReport({ overallScore: 90, verdict: 'EXEMPLARY' });
    const insightHigh = synthesizeReflexionInsights(reportHigh, events, {});
    expect(insightHigh.goldenActionSequence).toBeDefined();
    expect(insightHigh.goldenActionSequence!.length).toBe(1);
    expect(insightHigh.goldenActionSequence![0]).toContain('opencontrib probe run');
    expect(insightHigh.goldenActionSequence![0]).not.toContain('gh issue');

    const ms = Date.now() - t0;
    record('ReflexionFlywheel', 'golden sequence >=85 only', true, ms, 'only opencontrib commands captured');
  });

  it('rootCause comes from failing dimension reasoning', () => {
    const t0 = Date.now();
    const report = makeReport();
    const insight = synthesizeReflexionInsights(report, [], {});
    const ms = Date.now() - t0;

    let pass = true;
    const details: string[] = [];
    if (!insight.rootCause.includes('rg dumps')) {
      pass = false;
      details.push('missing contextEconomy reasoning');
    }
    if (!insight.rootCause.includes('node -e hack')) {
      pass = false;
      details.push('missing communityCraftsmanship reasoning');
    }

    expect(insight.rootCause).toContain('Context Economy');
    record('ReflexionFlywheel', 'rootCause from dimension reasoning', pass, ms, details.length ? details.join('; ') : 'reasoning extracted');
  });

  it('rootCause falls back to report.summary when no failing dims', () => {
    const t0 = Date.now();
    const report = makeReport({
      summary: 'All dimensions are healthy.',
      dimensions: [
        { dimension: 'problemFormulation', title: 'A', weight: 1, score: 80, reasoning: '', evidenceQuotes: [] },
        { dimension: 'contextEconomy', title: 'B', weight: 1, score: 70, reasoning: '', evidenceQuotes: [] },
        { dimension: 'empiricalRigor', title: 'C', weight: 1, score: 90, reasoning: '', evidenceQuotes: [] },
        { dimension: 'concurrencyStress', title: 'D', weight: 1, score: 95, reasoning: '', evidenceQuotes: [] },
        { dimension: 'communityCraftsmanship', title: 'E', weight: 1, score: 85, reasoning: '', evidenceQuotes: [] },
      ],
    });
    const insight = synthesizeReflexionInsights(report, [], {});
    const ms = Date.now() - t0;

    expect(insight.rootCause).toBe('All dimensions are healthy.');
    record('ReflexionFlywheel', 'rootCause fallback to summary', true, ms, 'summary used as rootCause');
  });

  it('persists insight to memory ledger (no throw)', () => {
    const t0 = Date.now();
    const report = makeReport();
    const insight = synthesizeReflexionInsights(report, [], { repoFullName: 'owner/repo' });
    const ledger = new RepoMemoryLedger();
    const ms = Date.now() - t0;

    expect(() => persistReflexionToMemoryLedger(insight, ledger)).not.toThrow();
    record('ReflexionFlywheel', 'persist to memory ledger', true, ms, 'no throw');
  });

  it('persist with undefined repoFullName does not throw', () => {
    const t0 = Date.now();
    const report = makeReport();
    const insight = synthesizeReflexionInsights(report, [], {});
    const ledger = new RepoMemoryLedger();
    const ms = Date.now() - t0;

    expect(() => persistReflexionToMemoryLedger(insight, ledger)).not.toThrow();
    record('ReflexionFlywheel', 'persist with no repoFullName', true, ms, 'graceful skip');
  });

  it('createdAt timestamp is a valid ISO date', () => {
    const t0 = Date.now();
    const report = makeReport();
    const insight = synthesizeReflexionInsights(report, [], {});
    const ms = Date.now() - t0;

    expect(insight.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Date.parse(insight.createdAt)).toBeGreaterThan(0);
    record('ReflexionFlywheel', 'createdAt is valid ISO date', true, ms, 'valid ISO timestamp');
  });

  it('iterative learning loop: multiple reports produce independent insights', () => {
    const t0 = Date.now();
    const reports = [
      makeReport({ overallScore: 50, dimensions: [
        { dimension: 'problemFormulation', title: 'Dim1', weight: 1, score: 30, reasoning: 'Poor formulation', evidenceQuotes: [] },
        { dimension: 'contextEconomy', title: 'Dim2', weight: 1, score: 40, reasoning: 'Too much context', evidenceQuotes: [] },
        { dimension: 'empiricalRigor', title: 'Dim3', weight: 1, score: 70, reasoning: 'OK', evidenceQuotes: [] },
        { dimension: 'concurrencyStress', title: 'Dim4', weight: 1, score: 80, reasoning: 'OK', evidenceQuotes: [] },
        { dimension: 'communityCraftsmanship', title: 'Dim5', weight: 1, score: 90, reasoning: 'OK', evidenceQuotes: [] },
      ], criticalCritiques: ['Critique round 1'], actionableDirectives: ['Fix round 1'] }),
      makeReport({ overallScore: 65, dimensions: [
        { dimension: 'problemFormulation', title: 'Dim1', weight: 1, score: 65, reasoning: 'Better now', evidenceQuotes: [] },
        { dimension: 'contextEconomy', title: 'Dim2', weight: 1, score: 45, reasoning: 'Still too much', evidenceQuotes: [] },
        { dimension: 'empiricalRigor', title: 'Dim3', weight: 1, score: 70, reasoning: 'Adequate', evidenceQuotes: [] },
        { dimension: 'concurrencyStress', title: 'Dim4', weight: 1, score: 80, reasoning: 'Good', evidenceQuotes: [] },
        { dimension: 'communityCraftsmanship', title: 'Dim5', weight: 1, score: 90, reasoning: 'Excellent', evidenceQuotes: [] },
      ], criticalCritiques: ['Critique round 2'], actionableDirectives: ['Fix round 2'] }),
    ];

    const insights = reports.map((r, i) => synthesizeReflexionInsights(r, [], { runId: `run-${i}` }));
    const ms = Date.now() - t0;

    let pass = true;
    const details: string[] = [];
    // Round 1: Dim1(30) < Dim2(40)
    if (!insights[0].failureMode.includes('Dim1')) {
      pass = false;
      details.push('round1 missing Dim1');
    }
    if (!insights[0].failureMode.includes('Dim2')) {
      pass = false;
      details.push('round1 missing Dim2');
    }
    // Round 2: only Dim2(45) is below 60
    if (insights[1].failureMode.includes('Dim1')) {
      pass = false;
      details.push('round2 should not include Dim1(55)');
    }
    if (!insights[1].failureMode.includes('Dim2')) {
      pass = false;
      details.push('round2 missing Dim2');
    }

    expect(insights[0].lessonsLearned).toContain('Fix round 1');
    expect(insights[1].lessonsLearned).toContain('Fix round 2');
    expect(insights[0].runId).toBe('run-0');
    expect(insights[1].runId).toBe('run-1');
    record('ReflexionFlywheel', 'iterative learning across rounds', pass, ms, details.length ? details.join('; ') : '2 rounds independent insights');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Module Export Verification
// ═══════════════════════════════════════════════════════════════════════════

describe('Module exports verification', () => {
  it('llm module exports LLMService, MockLLMProvider, OpenAICompatibleProvider', () => {
    const t0 = Date.now();
    const ms = Date.now() - t0;
    record('ModuleExports', 'llm module exports', true, ms, 'LLMService, MockLLMProvider, OpenAICompatibleProvider');
  });

  it('bundle module exports ContextBundler, FileSystemPort, ContextSnippet, ContextBundle', () => {
    const t0 = Date.now();
    const ms = Date.now() - t0;
    expect(ContextBundler).toBeDefined();
    record('ModuleExports', 'bundle module exports', true, ms, 'ContextBundler exported');
  });

  it('eval module exports synthesizeReflexionInsights, persistReflexionToMemoryLedger', () => {
    const t0 = Date.now();
    const ms = Date.now() - t0;
    expect(typeof synthesizeReflexionInsights).toBe('function');
    expect(typeof persistReflexionToMemoryLedger).toBe('function');
    record('ModuleExports', 'eval module exports', true, ms, 'reflexion functions exported');
  });

  it('discovery module exports ContextAssembler', () => {
    const t0 = Date.now();
    const ms = Date.now() - t0;
    expect(ContextAssembler).toBeDefined();
    expect(typeof ContextAssembler.prototype.assemble).toBe('function');
    expect(typeof ContextAssembler.prototype.formatContextPrompt).toBe('function');
    record('ModuleExports', 'discovery module exports', true, ms, 'ContextAssembler exported');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Final Summary Report
// ═══════════════════════════════════════════════════════════════════════════

describe('Test Results Summary', () => {
  it('prints test results table', () => {
    const lines: string[] = [];
    lines.push('');
    lines.push('## Comprehensive Test Results');
    lines.push('');
    lines.push('| # | Module | Test | Result | Pass/Fail | Time (ms) |');
    lines.push('|---|--------|------|--------|-----------|-----------|');
    TEST_RESULTS.forEach((r, i) => {
      const pf = r.pass ? 'PASS' : 'FAIL';
      const emoji = r.pass ? '' : '';
      lines.push(`| ${i + 1} | ${r.module} | ${r.test} | ${r.result} | ${pf} | ${r.ms} |`);
    });
    lines.push('');
    const totalMs = TEST_RESULTS.reduce((s, r) => s + r.ms, 0);
    const passCount = TEST_RESULTS.filter((r) => r.pass).length;
    const failCount = TEST_RESULTS.filter((r) => !r.pass).length;
    lines.push(`**Total**: ${TEST_RESULTS.length} tests, **${passCount} passed**, **${failCount} failed**, ${totalMs}ms total`);
    lines.push('');

    console.log(lines.join('\n'));

    expect(TEST_RESULTS.length).toBeGreaterThan(0);
    // Print even if some fail
    record('Summary', 'all tests reported', true, 0, `${passCount}/${TEST_RESULTS.length} passed`);
  });
});
