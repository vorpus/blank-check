/**
 * Shared Prettier preset for the Dopamine monorepo.
 * @type {import("prettier").Config}
 */
const config = {
  printWidth: 100,
  singleQuote: false,
  semi: true,
  trailingComma: "all",
  tabWidth: 2,
  arrowParens: "always",
  endOfLine: "lf",
};

export default config;
