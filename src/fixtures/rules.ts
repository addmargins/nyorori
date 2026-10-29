// Spec 6.1 upgrade check: replays the spec 3.3 calculation-rule fixtures
// through a measurer binary and lists every scoring difference.

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runCccc, validateRuns } from "../measure/cccc.js";
import { defaultPolicy } from "../policy/schema.js";
import { buildFileMeasurement, flattenUnits } from "../units/model.js";

type Row = [string, string, number, number, number, number];
interface Expectation {
  functions: Row[];
  residue: [number, number];
  parseErrors?: boolean;
}

export const DEFAULT_FIXTURES_DIR = fileURLToPath(new URL("../../test/fixtures/cccc-rules/", import.meta.url));

export interface RuleDrift {
  file: string;
  expected: unknown;
  actual: unknown;
}

export interface RuleCheck {
  checked: number;
  drifts: RuleDrift[];
  /** Fixture files on disk with no expectation, or expectations with no file. */
  unpaired: string[];
}

export async function checkCalculationRules(binary: string, dir = DEFAULT_FIXTURES_DIR): Promise<RuleCheck> {
  const expected = JSON.parse(await readFile(`${dir}/expected.json`, "utf8")) as Record<string, Expectation | string>;
  const files = Object.keys(expected).filter((k) => !k.startsWith("_"));
  const onDisk = (await readdir(dir)).filter((f) => f !== "expected.json");
  const unpaired = [...onDisk.filter((f) => !files.includes(f)), ...files.filter((f) => !onDisk.includes(f))];
  const policy = defaultPolicy();
  const runs = await runCccc({ binary, treeRoot: dir, files, policy, side: "B" });
  const byPath = new Map(validateRuns(runs, policy).files.map((f) => [f.path, f]));

  const drifts: RuleDrift[] = [];
  for (const file of files) {
    const exp = expected[file] as Expectation;
    const report = byPath.get(file);
    if (!report) {
      drifts.push({ file, expected: exp, actual: "missing from cccc output" });
      continue;
    }
    const m = buildFileMeasurement("C", file, "0", report, 10);
    const actual: Expectation = {
      functions: flattenUnits(m.units).map((u): Row => [u.name, u.kind, u.line, u.cognitive, u.cyclomatic, u.depth]),
      residue: [m.residue.cognitive, m.residue.cyclomatic],
      ...(m.parseErrors.length > 0 ? { parseErrors: true } : {}),
    };
    const want = { functions: exp.functions, residue: exp.residue, ...(exp.parseErrors ? { parseErrors: true } : {}) };
    if (JSON.stringify(actual) !== JSON.stringify(want)) drifts.push({ file, expected: want, actual });
  }
  return { checked: files.length, drifts, unpaired };
}
