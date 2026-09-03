/**
 * ESLint flat config — architecture guardrails (review Stage 5).
 *
 * Keeps the dependency-inverted layers free of direct infrastructure imports.
 * Run with `bun x eslint packages/core/src` in CI. (This file is inert until
 * eslint is installed; it declares intent and is safe to commit.)
 */
export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.test.ts'],
  },
  {
    files: ['packages/core/src/ports/**/*.ts', 'packages/core/src/testkit/**/*.ts', 'packages/core/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'fs', message: 'ports/domain/testkit must not import node:fs directly' },
            { name: 'node:fs', message: 'ports/domain/testkit must not import node:fs directly' },
            { name: 'child_process', message: 'ports/domain/testkit must not import child_process directly' },
            { name: 'node:child_process', message: 'ports/domain/testkit must not import child_process directly' },
          ],
          patterns: ['fs/*', 'child_process/*'],
        },
      ],
    },
  },
];
