// Types shared by the G2 lint-structure modules.

/**
 * How a rule hit is routed (spec 7.4):
 * - block: a new hit fails the gate
 * - trigger:S4/S9/S10: a new hit only routes the PR to simplification review
 * - observe: recorded for calibration, never routed
 */
export type LintCategory = "block" | "trigger:S4" | "trigger:S9" | "trigger:S10" | "observe";

export interface LintMessage {
  ruleId: string;
  messageId?: string;
  message: string;
  line: number;
  column: number;
  endLine?: number;
  category: LintCategory;
}

export interface FileLintResult {
  /** Path as handed to the linter (relative to the tree root). */
  path: string;
  messages: LintMessage[];
  /** Set when the file could not be parsed; `messages` is then empty. */
  parseError?: { message: string; line: number; column: number };
}
