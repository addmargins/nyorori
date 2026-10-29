// The gate's own ESLint rules. They encode the bypass shapes measured in
// spec 7.2 / 10.2 that no core rule catches:
// - dynamic-code: building or loading code from strings (V17, audit F7),
//   which makes units vanish from the cccc report
// - branch-hiding: syntax that moves decisions where cccc assigns no cost (S9)
// - param-mutation: helpers threading shared state through parameters (S10)
// - suppression-directive: every suppression comment, so B→C surplus can be found

import type { ESLint } from "eslint";
import { branchHiding } from "./rules/branch-hiding.js";
import { dynamicCode } from "./rules/dynamic-code.js";
import { paramMutation } from "./rules/param-mutation.js";
import { suppressionDirective } from "./rules/suppression.js";

export { staticPropertyName } from "./rules/ast.js";

export const PLUGIN_NAME = "nyorori";

export const nyororiPlugin: ESLint.Plugin = {
  meta: { name: "nyorori-gate" },
  rules: {
    "dynamic-code": dynamicCode,
    "branch-hiding": branchHiding,
    "param-mutation": paramMutation,
    "suppression-directive": suppressionDirective,
  },
};
