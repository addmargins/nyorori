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
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='z'][callee.property.name='enum'] > ArrayExpression",
          message:
            "Do not list a closed set inside z.enum. Pass its `as const` tuple: TRIGGER_IDS, GATE_IDS, GATE_MODES, GATE_STATES, REASON_CODES, INCONCLUSIVE_REASONS, FAIL_REASONS, UNMEASURED_REASONS or SIDES from src/types.ts. A set that belongs to an external format gets its own named tuple next to its parser.",
        },
      ],
    },
  },
  {
    rules: {
      // `_`-prefixed bindings are deliberate (destructuring a field away, unused callback args).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
    },
  },
);
