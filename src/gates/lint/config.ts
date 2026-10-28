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
  "max-lines-per-function": "trigger:S4",
  [`${PLUGIN_NAME}/branch-hiding`]: "trigger:S9",
  "no-param-reassign": "trigger:S10",
  "max-depth": "observe",
  "max-statements": "observe",
  "max-lines": "observe",
};

/** Rules whose B→C surplus produces DYNAMIC_CODE rather than LINT_NEW_VIOLATION. */
export const DYNAMIC_CODE_RULES: ReadonlySet<string> = new Set([
  "no-eval",
  "no-new-func",
  "no-implied-eval",
  `${PLUGIN_NAME}/dynamic-code`,
]);

export const SUPPRESSION_RULE = `${PLUGIN_NAME}/suppression-directive`;

export function categoryOf(ruleId: string): LintCategory | undefined {
  return RULE_CATEGORY[ruleId];
}

export function buildLintConfig(policy: Policy): Linter.Config[] {
  const { lint, triggers, scope } = policy;
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
        [`${PLUGIN_NAME}/dynamic-code`]: "error",
        [`${PLUGIN_NAME}/suppression-directive`]: "error",
        "@typescript-eslint/max-params": ["error", { max: lint.max_params, countVoidThis: false }],
        "max-nested-callbacks": ["error", { max: lint.max_nested_callbacks }],
        "max-lines-per-function": [
          "error",
          { max: triggers.s4_max_function_lines, skipBlankLines: true, skipComments: true, IIFEs: true },
        ],
        [`${PLUGIN_NAME}/branch-hiding`]: "error",
        "no-param-reassign": ["error", { props: true }],
        "max-depth": ["error", { max: 4 }],
        "max-statements": ["error", { max: 30 }],
        "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
      },
    },
    {
      // Deeply nested callbacks are the norm in describe/it blocks.
      name: "nyorori/tests",
      files: scope.test_globs,
      rules: { "max-nested-callbacks": "off" },
    },
  ];
}
