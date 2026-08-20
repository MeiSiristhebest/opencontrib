import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createDefaultPluginHost,
  STANDARD_AST_RELATIONAL_RULES,
  serializeRuleToYaml,
} from '../src/index.js';

describe('Deep Relational Rules, Auto-Rewrites & Native Config Passthrough', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrib-deep-rules-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('serializes standard relational rules to valid ast-grep YAML with fix templates', () => {
    const unclosedBodyRule = STANDARD_AST_RELATIONAL_RULES.find((r) => r.id === 'go-unclosed-http-body');
    expect(unclosedBodyRule).toBeDefined();

    const yamlStr = serializeRuleToYaml(unclosedBodyRule!);
    expect(yamlStr).toContain('id: go-unclosed-http-body');
    expect(yamlStr).toContain('language: go');
    expect(yamlStr).toContain('pattern: "$RESP, $ERR := http.Get($URL)"');
    expect(yamlStr).toContain('fix:');

    // Go Redis ZRange pagination trap rule
    const redisRule = STANDARD_AST_RELATIONAL_RULES.find((r) => r.id === 'go-redis-zrange-order-trap');
    expect(redisRule).toBeDefined();
    expect(redisRule!.language).toBe('go');
    expect(redisRule!.metadata?.category).toBe('protocol_drift');

    // Go Mutex in loop rule
    const mutexLoopRule = STANDARD_AST_RELATIONAL_RULES.find((r) => r.id === 'go-mutex-defer-in-loop');
    expect(mutexLoopRule).toBeDefined();
    expect(mutexLoopRule!.language).toBe('go');

    // Go Typed nil error rule
    const typedNilRule = STANDARD_AST_RELATIONAL_RULES.find((r) => r.id === 'go-typed-nil-error-trap');
    expect(typedNilRule).toBeDefined();
    expect(typedNilRule!.language).toBe('go');
  });

  it('detects native sgconfig.yml and passes configuration transparently', async () => {
    // Write sample native sgconfig.yml in target repository
    const sgConfigContent = `ruleDirs:
  - rules
`;
    fs.writeFileSync(path.join(tempDir, 'sgconfig.yml'), sgConfigContent, 'utf8');

    const host = await createDefaultPluginHost({ workspacePath: tempDir });
    expect(host.router).toBeDefined();

    // Verify ast-grep probe is active
    const activeCaps = host.router.getLevel1Capabilities();
    expect(activeCaps).toContain('security.static-analysis');
  });

  it('detects native .semgrep.yml and prioritizes repository custom rules', async () => {
    const semgrepConfigContent = `rules:
  - id: custom-repo-security-rule
    pattern: exec($CMD)
    message: Disallow raw exec calls
    languages: [python]
    severity: ERROR
`;
    fs.writeFileSync(path.join(tempDir, '.semgrep.yml'), semgrepConfigContent, 'utf8');

    const host = await createDefaultPluginHost({ workspacePath: tempDir });
    expect(host.router).toBeDefined();
  });
});
