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
];
