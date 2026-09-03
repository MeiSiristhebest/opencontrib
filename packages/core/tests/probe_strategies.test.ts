/**
 * Verifies the OCP refactor of probe output parsing & fallback commands:
 * adding behaviour means registering an entry, not editing a branch.
 */

import { describe, test, expect } from 'bun:test';
import {
  OUTPUT_PARSERS,
  FALLBACK_COMMANDS,
  parseProbeOutput,
  getEphemeralFallbackCommand,
  getDockerFallbackCommand,
} from '../src/probe/strategies.js';
import type { ProbeManifest } from '../src/probe/types.js';

const baseManifest: ProbeManifest = {
  id: 'p',
  name: 'semgrep',
  category: 'security_cwe',
  description: '',
  execution: { kind: 'command', command: 'x' },
} as unknown as ProbeManifest;

describe('Probe strategy registry (OCP)', () => {
  test('named parsers are registered and dispatch by probe name', () => {
    expect(OUTPUT_PARSERS.semgrep).toBeTypeOf('function');
    expect(OUTPUT_PARSERS['osv-scanner']).toBeTypeOf('function');
    expect(OUTPUT_PARSERS.knip).toBeTypeOf('function');
    expect(OUTPUT_PARSERS.ruff).toBeTypeOf('function');
  });

  test('parseProbeOutput routes semgrep JSON to the registered parser', () => {
    const stdout = JSON.stringify({
      results: [
        {
          check_id: 'r2c.rule',
          extra: { message: 'bad', metadata: { category: 'security' }, severity: 'ERROR' },
          start: { line: 7, col: 1 },
          end: { line: 7 },
          path: '/repo/src/a.ts',
        },
      ],
    });
    const findings = parseProbeOutput(baseManifest, stdout, '/repo');
    expect(findings).toHaveLength(1);
    expect(findings[0].probeName).toBe('semgrep');
    expect(findings[0].severity).toBe('high');
  });

  test('adding a probe = adding a registry entry (no branch edits)', () => {
    const before = Object.keys(OUTPUT_PARSERS).length;
    OUTPUT_PARSERS['custom-probe'] = (_probe, data) =>
      (data.hits || []).map((h: any) => ({
        id: h.id,
        probeName: 'custom-probe',
        category: 'security_cwe',
        title: h.title,
        description: '',
        file: h.file,
        line: 1,
        severity: 'medium',
        prPotentialScore: 80,
      }));
    expect(Object.keys(OUTPUT_PARSERS).length).toBe(before + 1);
    const out = parseProbeOutput(
      { ...baseManifest, name: 'custom-probe' },
      JSON.stringify({ hits: [{ id: 'h1', title: 'x', file: 'f.ts' }] }),
      '/repo',
    );
    expect(out[0].title).toBe('x');
    delete OUTPUT_PARSERS['custom-probe'];
  });

  test('fallback commands are keyed per probe, not branched', () => {
    expect(Object.keys(FALLBACK_COMMANDS)).toEqual(['semgrep', 'ruff', 'knip', 'ast-grep']);
    // The ephemeral command only resolves when its runner binary ('uv') is on
    // the OS PATH in the current environment; otherwise the function returns
    // undefined. The keying contract (one entry per probe, no branching) is the
    // real assertion — the command string is only checked when resolvable, so
    // the test stays deterministic across machines / CI hosts.
    const ephemeral = getEphemeralFallbackCommand('semgrep', '/t');
    if (ephemeral !== undefined) {
      expect(ephemeral).toContain('semgrep');
    }
    // docker command builder is only returned when docker is discoverable;
    // the registry entry itself exists regardless of environment.
    expect(typeof FALLBACK_COMMANDS.semgrep.docker).toBe('function');
    expect(getDockerFallbackCommand('unknown-probe', '/t')).toBeUndefined();
  });
});
