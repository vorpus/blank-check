/**
 * Tailwind v4 uses a PostCSS plugin; no tailwind.config.js is required (config is
 * CSS-first via `@theme` in app/globals.css).
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
