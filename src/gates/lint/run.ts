// Runs the gate's ESLint configuration over a tree materialized from git
// blobs. The candidate's own lint setup is never loaded or executed.

import { isAbsolute, relative, sep } from "node:path";
import { ESLint } from "eslint";
import type { Policy } from "../../policy/schema.js";
import { buildLintConfig, categoryOf } from "./config.js";
import type { FileLintResult, LintMessage } from "./types.js";

export interface LintRunOptions {
  /** Injected for tests; defaults to the real ESLint class. */
  eslintFactory?: (options: ESLint.Options) => ESLint;
}

export function eslintOptions(treeRoot: string, policy: Policy): ESLint.Options {
  return {
    cwd: treeRoot,
    // `true` means "no config file": eslint.config.* in the tree is not read.
    overrideConfigFile: true,
    overrideConfig: buildLintConfig(policy),
    allowInlineConfig: false,
    cache: false,
    // The caller passes an explicit file list from the manifest; ignore
    // patterns would only give the candidate another lever.
    ignore: false,
    errorOnUnmatchedPattern: true,
    globInputPaths: false,
    warnIgnored: true,
    fix: false,
  };
}

function toPosix(p: string): string {
  return sep === "/" ? p : p.split(sep).join("/");
}

/**
 * Lints `relFiles` (paths relative to `treeRoot`). Results are keyed by the
 * same relative path. Throws when ESLint itself fails; the caller turns that
 * into INCONCLUSIVE(TOOL_ERROR).
 */
export async function lintFiles(
  treeRoot: string,
  relFiles: readonly string[],
  policy: Policy,
  options: LintRunOptions = {},
): Promise<Map<string, FileLintResult>> {
  const out = new Map<string, FileLintResult>();
  if (relFiles.length === 0) return out;
  const factory = options.eslintFactory ?? ((o) => new ESLint(o));
  const eslint = factory(eslintOptions(treeRoot, policy));
  const results = await eslint.lintFiles([...relFiles]);
  for (const r of results) {
    const rel = toPosix(isAbsolute(r.filePath) ? relative(treeRoot, r.filePath) : r.filePath);
    out.set(rel, convert(rel, r.messages));
  }
  const missing = relFiles.filter((f) => !out.has(f));
  if (missing.length > 0) {
    throw new Error(`ESLint returned no result for: ${missing.join(", ")}`);
  }
  return out;
}

export function convert(path: string, messages: readonly import("eslint").Linter.LintMessage[]): FileLintResult {
  const result: FileLintResult = { path, messages: [] };
  for (const m of messages) {
    if (m.fatal) {
      result.parseError = { message: m.message, line: m.line, column: m.column };
      continue;
    }
    // ruleId null: notices such as "eslint-disable has no effect because of
    // noInlineConfig" or "file ignored". Directives are reported separately
    // by the suppression-directive rule.
    if (!m.ruleId) {
      if (/ignored/i.test(m.message)) {
        throw new Error(`ESLint ignored ${path}: ${m.message}`);
      }
      continue;
    }
    const category = categoryOf(m.ruleId);
    if (!category) continue;
    const msg: LintMessage = {
      ruleId: m.ruleId,
      message: m.message,
      line: m.line,
      column: m.column,
      category,
    };
    if (m.messageId) msg.messageId = m.messageId;
    if (m.endLine !== undefined) msg.endLine = m.endLine;
    result.messages.push(msg);
  }
  if (result.parseError) result.messages = [];
  return result;
}
