// The G2 ESLint configuration, built entirely from policy P (spec 7.4).
// Nothing from the candidate tree is consulted: no eslint.config.*, no
// tsconfig (the parser runs without type information), no inline config.

import type { Linter } from "eslint";
import tseslint from "typescript-eslint";
import type { Policy } from "../../policy/schema.js";
import { PLUGIN_NAME, nyororiPlugin } from "./plugin.js";
import type { LintCategory } from "./types.js";

export const LINTED_FILES = ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"];

/** Routing for every rule the gate enables. Unknown rule ids are never trusted. */
export const RULE_CATEGORY: Readonly<Record<string, LintCategory>> = {
  "no-eval": "block",
  "no-new-func": "block",
  "no-implied-eval": "block",
  [`${PLUGIN_NAME}/dynamic-code`]: "block",
  [`${PLUGIN_NAME}/suppression-directive`]: "block",
  "@typescript-eslint/max-params": "block",
  "max-nested-callbacks": "block",
  // S4 fires on lines > 60 or statements > 30 (ruling D12): statement count
  // does not depend on formatting.
  "max-lines-per-function": "trigger:S4",
  "max-statements": "trigger:S4",
  [`${PLUGIN_NAME}/branch-hiding`]: "trigger:S9",
  [`${PLUGIN_NAME}/param-mutation`]: "trigger:S10",
  "max-depth": "observe",
  "max-lines": "observe",
};

/** Per-message refinements of RULE_CATEGORY (`ruleId:messageId`). */
export const MESSAGE_CATEGORY: Readonly<Record<string, LintCategory>> = {
  // Ruling D10: a lazy import from a fixed in-repo directory.
  [`${PLUGIN_NAME}/dynamic-code:templateImportData`]: "observe",
  [`${PLUGIN_NAME}/dynamic-code:templateImportCode`]: "trigger:S11",
};

/** Statement threshold of the S4 statements path (ruling D12). */
export const S4_MAX_STATEMENTS = 30;

/** Rules that are observe-only in test files (ruling D11). */
export const OBSERVE_IN_TESTS: ReadonlySet<string> = new Set([
  "@typescript-eslint/max-params",
  "max-nested-callbacks",
]);

/** Rules whose B→C surplus produces DYNAMIC_CODE rather than LINT_NEW_VIOLATION. */
export const DYNAMIC_CODE_RULES: ReadonlySet<string> = new Set([
  "no-eval",
  "no-new-func",
  "no-implied-eval",
  `${PLUGIN_NAME}/dynamic-code`,
]);

export const SUPPRESSION_RULE = `${PLUGIN_NAME}/suppression-directive`;

export function categoryOf(ruleId: string, messageId?: string): LintCategory | undefined {
  return (messageId !== undefined ? MESSAGE_CATEGORY[`${ruleId}:${messageId}`] : undefined) ?? RULE_CATEGORY[ruleId];
}

export function buildLintConfig(policy: Policy): Linter.Config[] {
  const { lint, triggers, scope } = policy;
  // Test files get the same rules; evaluate.ts downgrades the ones D11 makes observe.
  return [
    {
      name: "nyorori/gate",
      files: LINTED_FILES,
      linterOptions: {
        // Equivalent to --no-inline-config: a `/* eslint-disable */` already
        // on the base branch must not switch P's rules off (spec 7.4).
        noInlineConfig: true,
        reportUnusedDisableDirectives: "off",
        reportUnusedInlineConfigs: "off",
      },
      languageOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        // no-implied-eval and no-eval only recognise these when they are
        // declared globals.
        globals: {
          setTimeout: "readonly",
          setInterval: "readonly",
          setImmediate: "readonly",
          execScript: "readonly",
          window: "readonly",
          self: "readonly",
          global: "readonly",
          globalThis: "readonly",
        },
        parser: tseslint.parser as Linter.Parser,
        parserOptions: {
          ecmaFeatures: { jsx: true },
          // Never type-aware: that would read the candidate's tsconfig.
          project: false,
          projectService: false,
        },
      },
      plugins: {
        [PLUGIN_NAME]: nyororiPlugin,
        "@typescript-eslint": tseslint.plugin as never,
      },
      rules: {
        "no-eval": ["error", { allowIndirect: false }],
        "no-new-func": "error",
        "no-implied-eval": "error",
        [`${PLUGIN_NAME}/dynamic-code`]: ["error", { excludedDirs: scope.exclude }],
        [`${PLUGIN_NAME}/suppression-directive`]: "error",
        "@typescript-eslint/max-params": ["error", { max: lint.max_params, countVoidThis: false }],
        "max-nested-callbacks": ["error", { max: lint.max_nested_callbacks }],
        "max-lines-per-function": [
          "error",
          { max: triggers.s4_max_function_lines, skipBlankLines: true, skipComments: true, IIFEs: true },
        ],
        [`${PLUGIN_NAME}/branch-hiding`]: "error",
        [`${PLUGIN_NAME}/param-mutation`]: "error",
        "max-depth": ["error", { max: 4 }],
        "max-statements": ["error", { max: S4_MAX_STATEMENTS }],
        "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
      },
    },
  ];
}
