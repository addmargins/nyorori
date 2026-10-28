// Regenerates policy/default.policy.json from the schema defaults.
// Runs from the build output: `npm run gen:policy` builds first.
import { writeFileSync } from "node:fs";
import { defaultPolicy } from "../dist/policy/schema.js";

const { revision: _revision, ...rest } = defaultPolicy();
writeFileSync(new URL("../policy/default.policy.json", import.meta.url), JSON.stringify(rest, null, 2) + "\n");
