// Lint configuration for nyorori's own sources. The gate never loads this
// file: G2 runs ESLint with an in-code config (src/gates/lint/config.ts).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const SOURCE_RULES = [
  {
    selector: "CallExpression[callee.object.name='z'][callee.property.name='enum'] > ArrayExpression",
    message:
      "Do not list a closed set inside z.enum. Pass its `as const` tuple: TRIGGER_IDS, GATE_IDS, GATE_MODES, GATE_STATES, REASON_CODES, INCONCLUSIVE_REASONS, FAIL_REASONS, UNMEASURED_REASONS or SIDES from src/types.ts. A set that belongs to an external format gets its own named tuple next to its parser.",
  },
  {
    selector: "Literal[regex.pattern=/0-9a-f\\]\\{40\\}/]",
    message: "Do not write a git object id pattern. Use isObjectId() from src/util/ids.ts (full lowercase id, 40 or 64 hex).",
  },
  {
    selector: "MemberExpression[property.name='message'] > TSAsExpression.object[typeAnnotation.typeName.name='Error']",
    message: "Use errorMessage(e) from src/util/errors.ts: a thrown value need not be an Error.",
  },
  {
    selector: "ConditionalExpression[test.operator='instanceof'][test.right.name='Error'][consequent.property.name='message']",
    message: "Use errorMessage(e) from src/util/errors.ts.",
  },
];

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
    // Each entry names the one place that owns the decision, so the error says what to use instead.
    files: ["src/**/*.ts"],
    ignores: ["src/util/**"],
    rules: { "no-restricted-syntax": ["error", ...SOURCE_RULES] },
  },
  {
    files: ["src/util/**/*.ts"],
    rules: { "no-restricted-syntax": ["error", SOURCE_RULES[0]] },
  },
  {
    rules: {
      // `_`-prefixed bindings are deliberate (destructuring a field away, unused callback args).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
    },
  },
);
