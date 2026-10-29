// Runs one spec 7.2 variant through G1 in two settings:
//   legacy — B holds the original (the user's "refactor a CogC 28 function" case),
//   new    — B has no pricing code (an agent writes the variant from scratch).

import * as prettier from "prettier";
import { flattenUnits, visibleBranches } from "../../src/units/model.js";
import { runScenario, type ScenarioResult } from "./helpers.js";
import { ORIGINAL, variantSources, type Variant } from "./variants.js";

export interface VariantRow {
  id: string;
  description: string;
  kind: Variant["kind"];
  units: number;
  maxCognitive: number;
  maxCyclomatic: number;
  sumCognitive: number;
  residueCognitive: number;
  visibleBranches: number;
  newCodeVerdict: "PASS" | "FAIL";
  newCodeReasons: string[];
  legacyVerdict: "PASS" | "FAIL";
  legacyTriggers: string[];
  newTriggers: string[];
  legacy: ScenarioResult;
  fresh: ScenarioResult;
}

const repoPath = (file: string) => `src/${file === "price.js" ? "pricing.js" : file}`;

async function normalizedLineCount(src: string): Promise<number> {
  const out = await prettier.format(src, { parser: "babel", printWidth: 100 });
  return out.split("\n").filter((l) => l.trim() !== "").length;
}

function routing(r: ScenarioResult): string[] {
  return [...new Set(r.outcome.triggers.filter((t) => t.routing).map((t) => t.id))].sort(
    (a, b) => Number(a.slice(1)) - Number(b.slice(1)),
  );
}

export async function analyzeVariant(v: Pick<Variant, "id" | "dir" | "description" | "kind">): Promise<VariantRow> {
  const original = variantSources(ORIGINAL)["price.js"]!;
  const files = Object.fromEntries(
    Object.entries(variantSources(v.dir)).map(([name, src]) => [repoPath(name), src]),
  );
  const normalizedLines = new Map<string, { B?: number; C?: number }>();
  normalizedLines.set("src/pricing.js", {
    B: await normalizedLineCount(original),
    C: await normalizedLineCount(files["src/pricing.js"]!),
  });
  const legacy = runScenario({ b: { "src/pricing.js": original }, c: files, normalizedLines });
  const fresh = runScenario({ b: {}, c: files });

  const measurements = [...fresh.c.values()];
  const units = measurements.flatMap((m) => flattenUnits(m.units));
  const verdict = (r: ScenarioResult) => (r.outcome.violations.length > 0 ? "FAIL" : "PASS");
  return {
    id: v.id,
    description: v.description,
    kind: v.kind,
    units: units.length,
    maxCognitive: Math.max(0, ...units.map((u) => u.cognitive)),
    maxCyclomatic: Math.max(0, ...units.map((u) => u.cyclomatic)),
    sumCognitive: units.reduce((s, u) => s + u.cognitive, 0),
    residueCognitive: measurements.reduce((s, m) => s + m.residue.cognitive, 0),
    visibleBranches: measurements.reduce((s, m) => s + visibleBranches(m), 0),
    newCodeVerdict: verdict(fresh),
    newCodeReasons: fresh.outcome.violations.map((x) => `${x.unit?.split("::")[1] ?? x.file}=${x.after}`),
    legacyVerdict: verdict(legacy),
    legacyTriggers: routing(legacy),
    newTriggers: routing(fresh),
    legacy,
    fresh,
  };
}
