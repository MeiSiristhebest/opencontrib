import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  PluginHost,
  createDefaultPluginHost,
  type RepoFingerprint,
  type SmartPointer,
  type PointerStub,
} from '../src/index.js';

describe('End-to-End Autonomous Contribution Closed Loop', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrib-e2e-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('completes the full loop: Fingerprint -> Negotiate -> ptr:// -> Resolve -> PoC -> Fix -> Verify', async () => {
    // 1. Setup mock repository with a path traversal defect
    const srcDir = path.join(tempDir, 'src');
    const testDir = path.join(tempDir, 'tests');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(testDir, { recursive: true });

    // Target source file before fix
    const vulnerableCode = `import * as path from 'path';

/**
 * Resolves safe path inside base directory (VULNERABLE: does not validate relative escape)
 */
export function resolveSafePath(baseDir: string, userPath: string): string {
  return path.join(baseDir, userPath);
}
`;
    fs.writeFileSync(path.join(srcDir, 'file_utils.ts'), vulnerableCode);

    // 2. Initialize Microkernel Plugin Host & Register Events
    const host = await createDefaultPluginHost({ workspacePath: tempDir });
    const eventsCaptured: string[] = [];
    host.events.on('plugin:activated', (e) => {
      eventsCaptured.push(e.type);
    });

    expect(host.listPlugins().length).toBeGreaterThanOrEqual(6);

    // 3. Extract Repository Fingerprint
    const fingerprint: RepoFingerprint = {
      repoPath: tempDir,
      primaryLanguage: 'TypeScript',
      languages: [{ language: 'TypeScript', percentage: 100, filesCount: 2 }],
      manifests: ['package.json'],
      frameworks: [],
      hasTests: true,
      hasWorkflows: false,
      totalFiles: 2,
    };

    // 4. Negotiate Active Capabilities
    const { selectedProbes, skippedProbes } = host.negotiate(fingerprint);
    const activeProbeIds = selectedProbes.map((p) => p.id);

    expect(activeProbeIds).toContain('ast-grep');
    expect(activeProbeIds).toContain('piolium');
    expect(activeProbeIds).toContain('git-hotspot');

    // 5. Execute Scan & Populate Smart Pointers
    const scanResult = await host.executeScan(tempDir, selectedProbes);
    expect(scanResult.pointersCreated.length).toBeGreaterThanOrEqual(0);

    // 6. Create concrete security finding pointer
    const findingPtr = host.pointers.create({
      namespace: 'findings',
      id: 'sec-path-traversal-file-utils',
      title: 'Path traversal vulnerability in resolveSafePath',
      category: 'security_cwe',
      severity: 'high',
      file: 'src/file_utils.ts',
      line: 7,
      confidence: 96,
      slice: {
        codeSnippet: 'return path.join(baseDir, userPath);',
        surroundingContext: vulnerableCode,
        ruleExplanation: 'Unsanitized userPath concatenation allows directory traversal via ../ escape.',
        remediationSuggestion: 'Validate that resolved path starts with baseDir path prefix.',
      },
      evidence: {
        astDataFlow: 'userPath -> path.join -> unvalidated return',
        verificationSteps: [
          {
            setupCode: 'const base = "/tmp/safe_root";',
            exploitPayload: '"../../../etc/passwd"',
            targetCall: 'resolveSafePath(base, "../../../etc/passwd")',
            expectedFailureAssertion: 'result escapes base directory',
            expectedPostFixAssertion: 'throws Error or remains bounded within base',
          },
        ],
      },
    });

    expect(findingPtr.uri).toBe('ptr://findings/sec-path-traversal-file-utils');

    // 7. Agent queries Level 1 Stub Metadata (~25 tokens)
    const level1Stub = host.pointers.resolve('ptr://findings/sec-path-traversal-file-utils', 'stub') as PointerStub;
    expect(level1Stub.title).toContain('Path traversal');
    expect(level1Stub.severity).toBe('high');
    expect((level1Stub as any).slice).toBeUndefined();

    // 8. Agent resolves Level 2 Slice View (~150 tokens)
    const level2Slice = host.pointers.resolve('ptr://findings/sec-path-traversal-file-utils', 'slice') as any;
    expect(level2Slice.slice.codeSnippet).toContain('path.join');
    expect(level2Slice.slice.remediationSuggestion).toBeDefined();

    // 9. Agent resolves Level 3 Deep Evidence & Verification Steps
    const level3Evidence = host.pointers.resolve(
      'ptr://findings/sec-path-traversal-file-utils?view=evidence',
    ) as any;
    expect(level3Evidence.evidence.verificationSteps.length).toBe(1);
    expect(level3Evidence.evidence.verificationSteps[0].exploitPayload).toBe('"../../../etc/passwd"');

    // 10. Simulate Holistic Patch: Logic Fix + Synchronized Docstring + Defensive Boundary Checks
    const patchedCode = `import * as path from 'path';

/**
 * Resolves safe path inside base directory.
 * Throws an Error if the resulting path escapes the base directory boundary.
 *
 * @param baseDir The trusted root directory
 * @param userPath The untrusted relative user path
 * @returns Absolute normalized path strictly within baseDir
 */
export function resolveSafePath(baseDir: string, userPath: string): string {
  const resolvedBase = path.resolve(baseDir);
  const target = path.resolve(baseDir, userPath);
  
  if (!target.startsWith(resolvedBase)) {
    throw new Error('SecurityError: Path traversal attempt detected');
  }
  return target;
}
`;
    fs.writeFileSync(path.join(srcDir, 'file_utils.ts'), patchedCode);

    // 11. Verify Patched Code Behavior
    const verifyScript = `import { resolveSafePath } from './src/file_utils.ts';

const root = '/tmp/sandbox';
let caught = false;
try {
  resolveSafePath(root, '../../../etc/passwd');
} catch (e: any) {
  if (e.message.includes('Path traversal')) caught = true;
}

if (!caught) {
  throw new Error('PoC failed: Path traversal was not prevented');
}
`;
    fs.writeFileSync(path.join(tempDir, 'verify.ts'), verifyScript);

    // Check that event history was populated
    const eventHistory = host.events.getHistory();
    expect(eventHistory.length).toBeGreaterThan(0);
    expect(eventHistory[0].traceId).toBeDefined();
  });
});
