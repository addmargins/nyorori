// Lint configuration for nyorori's own sources. The gate never loads this
// file: G2 runs ESLint with an in-code config (src/gates/lint/config.ts).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "test/fixtures/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain JavaScript scripts run on Node; TypeScript files get no-undef from the compiler instead.
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly", URL: "readonly", Buffer: "readonly" } },
  },
  {
    rules: {
      // `_`-prefixed bindings are deliberate (destructuring a field away, unused callback args).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
    },
  },
);
