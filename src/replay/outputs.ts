// Writes one run's spec 9.2 artifacts (same files as `nyorori run --out`) so
// every replayed pair keeps its evidence next to the replay report.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunGatesOutput } from "../pipeline/types.js";

export async function writeRunOutputs(dir: string, out: RunGatesOutput): Promise<void> {
  await mkdir(dir, { recursive: true });
  const w = (name: string, data: string | Buffer) => writeFile(join(dir, name), data);
  const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
  await w("manifest.json", json(out.manifest));
  const bySide: Record<string, number> = {};
  for (const run of out.ccccRuns) {
    const n = (bySide[run.side] = (bySide[run.side] ?? 0) + 1);
    const suffix = n === 1 ? "" : `.${n}`;
    await w(`raw.${run.side}${suffix}.json`, run.stdout);
    await w(`raw.${run.side}${suffix}.stderr`, run.stderr);
  }
  for (const r of out.results) await w(`gate-result.${r.gate}.json`, json(r));
  await w("quality-gate.json", json(out.verdict));
  await w("gate-summary.md", out.summaryMarkdown + "\n");
  await w("gate-feedback.json", json(out.feedback));
}
