import preset from "@dopamine/config/eslint-preset";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...preset,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Test files assert on mock methods (`expect(mock.method)…`), which the
    // type-aware `unbound-method` rule false-positives on. Off for tests only.
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "@typescript-eslint/unbound-method": "off",
    },
  },
];
