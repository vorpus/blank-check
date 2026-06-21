import preset from "@dopamine/config/eslint-preset";

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...preset,
  {
    // The generated transport types are not hand-authored — don't lint them.
    ignores: ["src/openapi.gen.ts"],
  },
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
];
