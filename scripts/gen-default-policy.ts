// Regenerates policy/default.policy.json from the schema defaults.
import { writeFileSync } from "node:fs";
import { defaultPolicy } from "../src/policy/schema.js";

const { revision: _revision, ...rest } = defaultPolicy();
writeFileSync("policy/default.policy.json", JSON.stringify(rest, null, 2) + "\n");
