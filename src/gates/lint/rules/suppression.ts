// suppression-directive: reports every suppression comment so evaluate.ts
// can find the B→C surplus. The messageId is the directive kind.

import type { Rule } from "eslint";
import { classifyDirectiveComment, type DirectiveKind } from "../text.js";

const KINDS: readonly DirectiveKind[] = [
  "eslint-disable",
  "eslint-config",
  "ts-ignore",
  "ts-nocheck",
  "ts-expect-error",
  "coverage-ignore",
  "stryker-disable",
];

export const suppressionDirective: Rule.RuleModule = {
  meta: {
    type: "problem",
    schema: [],
    messages: Object.fromEntries(KINDS.map((k) => [k, "{{directive}}"])),
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type !== "Line" && comment.type !== "Block") continue;
          const d = classifyDirectiveComment(comment.value, comment.type);
          if (!d || !comment.loc) continue;
          context.report({ loc: comment.loc, messageId: d.kind, data: { directive: d.normalized } });
        }
      },
    };
  },
};
