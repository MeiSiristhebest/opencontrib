/**
 * ESLint flat config — architecture guardrails (review Stage 5).
 *
 * Keeps the dependency-inverted layers free of direct infrastructure imports.
 * TypeScript parsing is enabled explicitly and the same active config runs in
 * CI via `bunx eslint packages/`.
 */
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/*.test.ts"],
  },
  {
    files: ["packages/**/*.ts"],
    languageOptions: {
      parser: tsParser,
    },
  },
  {
    files: [
      "packages/core/src/ports/**/*.ts",
      "packages/core/src/testkit/**/*.ts",
      "packages/core/src/domain/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "fs",
              message: "ports/domain/testkit must not import node:fs directly",
            },
            {
              name: "node:fs",
              message: "ports/domain/testkit must not import node:fs directly",
            },
            {
              name: "child_process",
              message:
                "ports/domain/testkit must not import child_process directly",
            },
            {
              name: "node:child_process",
              message:
                "ports/domain/testkit must not import child_process directly",
            },
          ],
          patterns: [
            "fs/*",
            "child_process/*",
            "node:fs/*",
            "node:child_process/*",
          ],
        },
      ],
    },
  },
];
