import { describe, expect, it } from 'bun:test';
import { ProbeRegistry, type PluginStateProvider } from '../src/probe/registry.js';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('ProbeRegistry single source of truth (microkernel consolidation)', () => {
  it('listAll returns every built-in probe; listEnabled filters by the state provider', () => {
    const state: PluginStateProvider = {
      // Treat "semgrep" as disabled; everything else enabled.
      isEnabled: (id: string) => id !== 'semgrep',
    };
    const reg = new ProbeRegistry(undefined, state);

    const all = reg.listAll();
    expect(all.length).toBeGreaterThan(10);
    expect(all.some((p) => p.name === 'semgrep')).toBe(true);

    const enabled = reg.listEnabled();
    expect(enabled.some((p) => p.name === 'semgrep')).toBe(false);
    expect(enabled.length).toBe(all.length - 1);
  });

  it('isEnabled delegates to the injected state provider', () => {
    let asked: string | null = null;
    const state: PluginStateProvider = {
      isEnabled: (id: string): boolean => {
        asked = id;
        return false;
      },
    };
    const reg = new ProbeRegistry(undefined, state);
    expect(reg.isEnabled('codeql')).toBeFalsy();
    expect(asked === 'codeql').toBe(true);
  });

  it('is the ONLY module declaring a built-in probe-definition table (architecture guard)', () => {
    // The canonical data-driven table is BUILTIN_PROBES in probe/registry.ts.
    // The microkernel files (plugin-host / plugin-manager) must NOT declare a
    // second built-in probe table — that would reintroduce a source of truth.
    const srcRoot = join(import.meta.dir, '..', 'src');
    const banned = /BUILTIN_PROBES|BUILTIN_PROBE_MANIFESTS|builtinProbes\s*[:=]/;
    const candidates = [
      join(srcRoot, 'probe', 'registry.ts'),
      join(srcRoot, 'kernel', 'plugin-host.ts'),
      join(srcRoot, 'kernel', 'plugin-manager.ts'),
    ];
    let declaredElsewhere = 0;
    for (const file of candidates) {
      const text = readFileSync(file, 'utf-8');
      const hasTable = banned.test(text);
      if (file.endsWith('registry.ts')) {
        expect(hasTable).toBe(true); // canonical owner
      } else if (hasTable) {
        declaredElsewhere++;
      }
    }
    expect(declaredElsewhere).toBe(0);
  });
});
