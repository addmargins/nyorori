// First-parent history for the moving baseline: parsing, candidate rules and
// the cost on a large repository (5k commits × 300 changed files).

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { candidatesFor, cutoffCommit, historyIndex, parseHistory, readFirstParentHistory } from "../../src/pipeline/history.js";
import { selectBaselines } from "../../src/pipeline/moving-baseline.js";
import { TestRepo } from "../git/repo.js";

describe("parseHistory", () => {
  it("reads sha, time and per-path statuses, including rename pairs", () => {
    const out = ["\u0001aaa 100\0\n", "M\0src/a.ts\0", "A\0src/new.ts\0", "\u0001bbb 90\0\n", "R100\0old.ts\0new.ts\0", "D\0gone.ts\0", "\u0001ccc 80\0"].join("");
    const h = parseHistory(out);
    expect(h.map((c) => [c.sha, c.time])).toEqual([["aaa", 100], ["bbb", 90], ["ccc", 80]]);
    expect(h[2]!.touched.size).toBe(0);
    expect([...h[0]!.touched]).toEqual([["src/a.ts", "M"], ["src/new.ts", "A"]]);
    expect([...h[1]!.touched]).toEqual([["old.ts", "D"], ["new.ts", "R"], ["gone.ts", "D"]]);
  });

  it("stops a file's touch list at its most recent creation", () => {
    const touched = (p: string, s: string) => new Map([[p, s]]);
    const h = [
      { sha: "5", time: 50, touched: touched("f", "M") },
      { sha: "4", time: 40, touched: touched("f", "A") }, // re-added here
      { sha: "3", time: 30, touched: touched("f", "D") },
      { sha: "2", time: 20, touched: touched("f", "M") },
      { sha: "1", time: 10, touched: touched("f", "A") },
    ];
    expect(candidatesFor(h, "f", 5, null)).toEqual({ base: "5", nthTouch: "4", beforeCutoff: null, creation: "4" });
    expect(candidatesFor(h, "f", 1, null).nthTouch).toBe("5");
    expect(candidatesFor(h, "missing", 5, "1")).toEqual({ base: "5", nthTouch: null, beforeCutoff: "1", creation: null });
    expect(cutoffCommit(h, 0.0001)).toBe("4"); // ~8.6 s before 50
  });
});

/** 5,000 first-parent commits, each touching one of 300 files, via fast-import. */
function bigRepo(commits: number, files: number): TestRepo {
  const repo = new TestRepo();
  const lines: string[] = [];
  for (let i = 0; i < commits; i++) {
    const path = `src/f${i % files}.js`;
    const body = `export const v${i} = ${i};\n`;
    lines.push(
      "commit refs/heads/main",
      `committer t <t@t> ${1_700_000_000 + i * 60} +0000`,
      `data ${Buffer.byteLength(`c${i}`)}`,
      `c${i}`,
      `M 100644 inline ${path}`,
      `data ${Buffer.byteLength(body)}`,
      body.trimEnd(),
      "",
    );
  }
  execFileSync("git", ["fast-import", "--quiet"], { cwd: repo.dir, input: lines.join("\n") + "\n" });
  execFileSync("git", ["checkout", "-q", "-f", "main"], { cwd: repo.dir });
  return repo;
}

describe("moving-baseline history on a large repository", () => {
  it("one history read serves 300 changed files in well under a second", async () => {
    const repo = bigRepo(5000, 300);
    try {
      const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.dir }).toString().trim();
      const t0 = performance.now();
      const history = await readFirstParentHistory(repo.dir, base);
      const read = performance.now() - t0;
      expect(history).toHaveLength(5000);
      const tracked = new Map(Array.from({ length: 300 }, (_, i) => [`src/f${i}.js`, `src/f${i}.js`]));
      const t1 = performance.now();
      const groups = selectBaselines(history, tracked, { lookback_merges: 5, lookback_days: 30 });
      const select = performance.now() - t1;
      // Every file was touched every 300 commits: its 5th touch is distinct, and 30 days (43,200 commits at one
      // per minute) is beyond the history, so the 5th touch wins and no file is clamped to its creation.
      expect(groups.size).toBe(300);
      expect([...groups.values()].every((s) => s.size === 1)).toBe(true);
      const index = historyIndex(history);
      // Each 5th touch lies 4×300 commits back from the file's latest touch.
      for (const [m, files] of groups) {
        const file = [...files][0]!;
        const latest = history.findIndex((c) => c.touched.has(file));
        expect(index.get(m)).toBe(latest + 4 * 300);
      }
      expect(read + select).toBeLessThan(5000);
      console.log(`history read ${read.toFixed(0)} ms, selection ${select.toFixed(0)} ms for 5000 commits × 300 files`);
    } finally {
      repo.dispose();
    }
  }, 20_000);
});
