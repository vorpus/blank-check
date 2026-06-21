import preset from "@dopamine/config/eslint-preset";

/**
 * Web ESLint: the shared monorepo preset (strict, type-aware, no-any) plus the
 * type-aware service pointed at this app's tsconfig. We intentionally do NOT pull
 * in `eslint-config-next`'s legacy shareable config here — it predates flat
 * config and clashes with the workspace's typescript-eslint flat setup; the
 * preset already covers the rules that matter for correctness.
 */

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...preset,
  {
    ignores: [".next/**", "next-env.d.ts"],
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
];
