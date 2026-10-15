import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  WorktreeManager,
  applySearchReplaceHunks,
  buildDynamicPatchPrompt,
  SearchReplaceHunkSchema,
  CodeChangeFileSchema,
} from '../src/index.js';

describe('Phase 3 Hardening: SOTA Patch Generation & Search/Replace Hunks', () => {
  it('SearchReplaceHunkSchema and CodeChangeFileSchema validate correctly', () => {
    const validHunk = {
      search: 'const oldVal = 1;',
      replace: 'const newVal = 2;',
    };
    expect(SearchReplaceHunkSchema.safeParse(validHunk).success).toBe(true);

    const validFileWithHunks = {
      path: 'src/config.ts',
      operation: 'MODIFY' as const,
      hunks: [validHunk],
      explanation: 'Update config value',
    };
    expect(CodeChangeFileSchema.safeParse(validFileWithHunks).success).toBe(true);
  });

  describe('applySearchReplaceHunks algorithm', () => {
    it('applies exact search/replace hunks correctly', () => {
      const original = 'line 1\nline 2: target\nline 3\n';
      const hunks = [{ search: 'line 2: target', replace: 'line 2: patched' }];
      const result = applySearchReplaceHunks(original, hunks, 'test.txt');

      expect(result.error).toBeUndefined();
      expect(result.content).toBe('line 1\nline 2: patched\nline 3\n');
    });

    it('handles CRLF vs LF line endings cleanly', () => {
      const original = 'line 1\r\nline 2: target\r\nline 3\r\n';
      const hunks = [{ search: 'line 2: target', replace: 'line 2: patched' }];
      const result = applySearchReplaceHunks(original, hunks, 'test.txt');

      expect(result.error).toBeUndefined();
      expect(result.content).toContain('line 2: patched');
      expect(result.content).toContain('\r\n');
    });

    it('performs fuzzy matching with minor whitespace / indentation variations', () => {
      const original = 'function test() {\n    const a = 1;\n    return a;\n}\n';
      const hunks = [{
        search: 'const a = 1;\nreturn a;',
        replace: '  const a = 2;\n  return a * 2;',
      }];
      const result = applySearchReplaceHunks(original, hunks, 'test.ts');

      expect(result.error).toBeUndefined();
      expect(result.content).toContain('return a * 2;');
    });

    it('returns informative error if search block cannot be found', () => {
      const original = 'const x = 1;\n';
      const hunks = [{ search: 'const nonExistent = 42;', replace: 'const replacement = 99;' }];
      const result = applySearchReplaceHunks(original, hunks, 'file.ts');

      expect(result.error).toBeDefined();
      expect(result.error).toContain("SearchReplaceMismatchError: search block #1 for 'file.ts' was not found");
      expect(result.content).toBe(original);
    });
  });

  describe('WorktreeManager.applySurgicalFilesSafely with hunks', () => {
    it('applies surgical search/replace hunks to existing workspace file', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-wm-hunk-'));
      try {
        const filePath = 'lib/util.ts';
        const fullPath = path.join(tempDir, filePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(
          fullPath,
          'export function greeting() {\n  return "hello";\n}\n',
          'utf8',
        );

        const wm = new WorktreeManager();
        const outcome = wm.applySurgicalFilesSafely(tempDir, [
          {
            path: filePath,
            operation: 'MODIFY',
            hunks: [
              {
                search: 'return "hello";',
                replace: 'return "hello world";',
              },
            ],
          },
        ]);

        expect(outcome.errors.length).toBe(0);
        expect(outcome.appliedFiles.length).toBe(1);

        const updated = fs.readFileSync(fullPath, 'utf8');
        expect(updated).toBe('export function greeting() {\n  return "hello world";\n}\n');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('buildDynamicPatchPrompt with fileContexts', () => {
    it('renders <source_code_context> and hunk instructions when fileContexts provided', () => {
      const prompt = buildDynamicPatchPrompt({
        basePrompt: 'Fix null pointer dereference in parser',
        repoFullName: 'test-org/test-repo',
        testCommand: 'bun test',
        fileContexts: [
          {
            path: 'src/parser.ts',
            content: 'export function parse(input: string | null) { return input.length; }',
          },
        ],
      });

      expect(prompt).toContain('<source_code_context>');
      expect(prompt).toContain('[File: src/parser.ts]');
      expect(prompt).toContain('export function parse(input: string | null)');
      expect(prompt).toContain('</source_code_context>');
      expect(prompt).toContain("For MODIFY operations, you may provide surgical 'hunks'");
    });

    it('preserves line endings outside the matched hunk range without global CRLF pollution', () => {
      // Mixed file: header uses LF, target hunk uses CRLF, footer uses LF
      const original = "line1\nline2\nfoo = 1\r\nbar = 2\r\nline5\nline6";
      const res = applySearchReplaceHunks(
        original,
        [{ search: "foo = 1\nbar = 2", replace: "foo = 100\nbar = 200" }],
        "test.py",
      );
      expect(res.error).toBeUndefined();
      // Leading and trailing LF lines should remain pure LF
      expect(res.content.startsWith("line1\nline2\n")).toBe(true);
      expect(res.content.endsWith("\nline5\nline6")).toBe(true);
      // Replaced hunk adopted CRLF matching original hunk
      expect(res.content).toContain("foo = 100\r\nbar = 200");
    });
  });
});
