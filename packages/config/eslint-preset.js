// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";

/**
 * Shared ESLint flat-config preset for the Dopamine monorepo.
 *
 * Consumers add it to their own `eslint.config.js`:
 *
 *   import preset from "@dopamine/config/eslint-preset";
 *   export default [
 *     ...preset,
 *     { languageOptions: { parserOptions: { project: "./tsconfig.json" } } },
 *   ];
 *
 * Type-aware rules (e.g. `no-floating-promises`) require each consuming package
 * to point the parser at its own tsconfig via `projectService` or `project`.
 *
 * @type {import("eslint").Linter.Config[]}
 */
const preset = tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/node_modules/**",
      // Flat-config files live outside the TS program; don't type-aware-lint them.
      "**/eslint.config.js",
      "**/*.config.{js,cjs,mjs}",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Consumers enable the type-aware service against their own tsconfig.
        projectService: true,
      },
    },
    plugins: {
      import: importPlugin,
    },
    rules: {
      // No floating promises — load-bearing for a server with async boundaries.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",

      // Keep the public surface honest: no `any` leaking out.
      "@typescript-eslint/no-explicit-any": "error",

      // Allow intentional throwaways named with a leading underscore (e.g. omit-via-rest).
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],

      // Prefer `import type` so type-only imports are erased — matches
      // `verbatimModuleSyntax` in the tsconfig base.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],

      // Import hygiene / ordering.
      "import/order": [
        "error",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
          "newlines-between": "always",
          alphabetize: { order: "asc", caseInsensitive: true },
        },
      ],
      "import/no-duplicates": "error",
    },
  },
  {
    // Tests may be a touch looser.
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);

export default preset;
