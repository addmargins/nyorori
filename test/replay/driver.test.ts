// The replay driver against real tiny repositories and the real cccc binary:
// deltas between two policies, exit codes, concurrency invariance, the CLI.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LoadedPolicy } from "../../src/policy/load.js";
import { replayCommand } from "../../src/replay/cli.js";
import { replay, type ReplayReport } from "../../src/replay/driver.js";
import { pLimit } from "../../src/replay/limit.js";
import { CCCC, TestRepo, fnWithCogc, servicePolicy } from "../e2e/helpers.js";

function loaded(revision: string, cognitiveLimit: number): LoadedPolicy {
  const policy = { ...servicePolicy({ complexity: { cognitive_limit: cognitiveLimit } }), revision };
  return { policy, revision };
}

describe("nyorori replay", () => {
  let root: string;
  let repo: TestRepo;
  let b0: string;
  let c1: string;
  let c2: string;
  let c3: string;
  let broken: string;
  let n = 0;
  const outDir = () => join(root, `out-${++n}`);
  const workDir = () => join(root, "work");

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "nyorori-replay-"));
    repo = new TestRepo();
    b0 = repo.commit({ "README.md": "x\n", "src/ok.js": fnWithCogc("ok", 3) });
    c1 = repo.commit({ "src/a.js": fnWithCogc("a", 13) });
    c2 = repo.commit({ "docs/guide.md": "hello\n" });
    c3 = repo.commit({ "src/b.js": fnWithCogc("b", 5) });
    broken = repo.commit({ "src/c.js": "function broken( {\n" });
  });
  afterAll(() => {
    repo.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  function dataset(name: string, pairs: Array<Record<string, string>>): string {
    const dir = join(root, "datasets");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify({ schema_version: 1, repository: "test/replay", pairs }));
    return file;
  }

  const threePairs = () => [
    { id: "PR-1", base: b0, candidate: c1 },
    { id: "PR-2", base: c1, candidate: c2 },
    { id: "PR-3", base: c2, candidate: c3 },
  ];

  async function run(datasetPath: string, extra: Partial<Parameters<typeof replay>[0]> = {}): Promise<ReplayReport & { out: string }> {
    const out = outDir();
    const report = await replay({
      repoDir: repo.dir,
      datasetPath,
      outDir: out,
      workDir: workDir(),
      policy: loaded("P-15", 15),
      ccccBinary: CCCC,
      runnerCommit: "replay-test",
      rng: () => 1,
      ...extra,
    });
    return { ...report, out };
  }

  it("reports the OVER_LIMIT_NEW violation a stricter policy adds and exits 1", async () => {
    const r = await run(dataset("three", threePairs()), { comparePolicy: loaded("P-12", 12), jobs: 2 });
    expect(r.exit_code).toBe(1);
    expect(r.counts).toEqual({ pairs: 3, completed: 3, changed: 1, errored: 0, service_inconclusive: 0 });
    const p1 = r.pairs.find((p) => p.id === "PR-1")!;
    expect(p1.current!.state).toBe("PASS");
    expect(p1.comparison!.state).toBe("FAIL");
    expect(p1.delta!.changed).toBe(true);
    expect(p1.delta!.state).toEqual({ before: "PASS", after: "FAIL" });
    expect(p1.delta!.merge_allowed).toEqual({ before: true, after: false });
    expect(p1.delta!.violations.removed).toEqual([]);
    expect(p1.delta!.violations.added).toHaveLength(1);
    expect(p1.delta!.violations.added[0]).toMatchObject({ gate: "complexity", reason: "OVER_LIMIT_NEW", file: "src/a.js", after: 13, limit: 12 });
    expect(p1.delta!.violations.added[0]!.unit).toContain("src/a.js::a#");
    expect(p1.delta!.gates.map((g) => g.gate)).toContain("complexity");
    for (const id of ["PR-2", "PR-3"]) expect(r.pairs.find((p) => p.id === id)!.delta!.changed).toBe(false);
    expect(r.pairs.find((p) => p.id === "PR-2")!.current!.state).toBe("NOT_APPLICABLE");

    // Friction metrics per side.
    expect(r.totals.current.states).toMatchObject({ PASS: 2, NOT_APPLICABLE: 1, FAIL: 0 });
    expect(r.totals.current.fail_rate).toBe(0);
    expect(r.totals.comparison!.states).toMatchObject({ PASS: 1, NOT_APPLICABLE: 1, FAIL: 1 });
    expect(r.totals.comparison!.fail_rate).toBeCloseTo(1 / 3, 4);
    expect(r.totals.current.inconclusive_rate).toBe(0);
    expect(r.totals.current.review_required_count).toBe(0);
    expect(r.sides.comparison!.policy_revision).toBe("P-12");

    // Outputs: per pair and per side, plus the replay report and summary.
    for (const id of ["PR-1", "PR-2", "PR-3"]) {
      for (const side of ["current", "comparison"]) {
        expect(existsSync(join(r.out, id, side, "quality-gate.json")), `${id}/${side}`).toBe(true);
        expect(existsSync(join(r.out, id, side, "gate-summary.md"))).toBe(true);
      }
    }
    expect(existsSync(join(r.out, "PR-1", "current", "raw.C.json"))).toBe(true);
    const written = JSON.parse(readFileSync(join(r.out, "replay-result.json"), "utf8")) as ReplayReport;
    expect(written.schema_version).toBe(1);
    expect(written.exit_code).toBe(1);
    expect(written.pairs.map((p) => p.id)).toEqual(["PR-1", "PR-2", "PR-3"]);
    const md = readFileSync(join(r.out, "replay-summary.md"), "utf8");
    expect(md.startsWith("# replay: DELTAS")).toBe(true);
    // Deltas come before the totals.
    expect(md.indexOf("판정 차이")).toBeLessThan(md.indexOf("마찰 지표"));
    expect(md).toContain("OVER_LIMIT_NEW");
    expect(md).toContain("PASS → FAIL");
  }, 120_000);

  it("gives the same result with one job as with two, and exits 0 without deltas", async () => {
    const ds = dataset("three-again", threePairs());
    const one = await run(ds, { comparePolicy: loaded("P-15b", 15), jobs: 1 });
    const two = await run(ds, { comparePolicy: loaded("P-15b", 15), jobs: 2 });
    expect(one.exit_code).toBe(0);
    expect(two.exit_code).toBe(0);
    expect(one.counts.changed).toBe(0);
    expect(two.pairs).toEqual(one.pairs);
    expect(two.totals).toEqual(one.totals);
  }, 120_000);

  it("exits 2 when a candidate cannot be measured (G1 INCONCLUSIVE) even without a comparison", async () => {
    const r = await run(dataset("broken", [{ id: "PR-ok", base: b0, candidate: c1 }, { id: "PR-broken", base: c3, candidate: broken }]));
    expect(r.exit_code).toBe(2);
    expect(r.sides.comparison).toBeNull();
    const bad = r.pairs.find((p) => p.id === "PR-broken")!;
    expect(bad.errors).toEqual([]);
    expect(bad.current!.state).toBe("INCONCLUSIVE");
    // The syntax error breaks G1; G2 (ESLint) cannot parse it either.
    expect(bad.current!.service_inconclusive).toContain("complexity");
    expect(r.counts.service_inconclusive).toBe(1);
    expect(r.totals.current.inconclusive_count).toBe(1);
    expect(r.totals.comparison).toBeNull();
    const md = readFileSync(join(r.out, "replay-summary.md"), "utf8");
    expect(md.startsWith("# replay: ERROR")).toBe(true);
    expect(md).toContain("PR-broken [current]: INCONCLUSIVE in complexity");
  }, 120_000);

  it("exits 2 and records the error when a pair's commit does not exist", async () => {
    const r = await run(dataset("missing", [{ id: "PR-1", base: b0, candidate: c1 }, { id: "PR-gone", base: b0, candidate: "f".repeat(40) }]));
    expect(r.exit_code).toBe(2);
    const gone = r.pairs.find((p) => p.id === "PR-gone")!;
    expect(gone.current).toBeNull();
    expect(gone.errors).toHaveLength(1);
    expect(gone.errors[0]!.side).toBe("current");
    expect(r.counts).toMatchObject({ errored: 1, completed: 1 });
    expect(r.pairs.find((p) => p.id === "PR-1")!.current!.state).toBe("PASS");
  }, 120_000);

  it("refuses a non-empty out dir and an out dir inside the repository", async () => {
    const ds = dataset("one", [{ id: "PR-1", base: b0, candidate: c1 }]);
    const used = outDir();
    mkdirSync(used, { recursive: true });
    writeFileSync(join(used, "stale"), "");
    await expect(run(ds, { outDir: used })).rejects.toThrow(/not empty/);
    await expect(run(ds, { outDir: join(repo.dir, "replay-out") })).rejects.toThrow(/inside the repository/);
  });

  it("the CLI subcommand parses its own arguments and maps errors to exit codes", async () => {
    const policyDir = join(root, "policies");
    mkdirSync(policyDir, { recursive: true });
    const write = (name: string, limit: number) => {
      const { revision: _r, ...p } = servicePolicy({ complexity: { cognitive_limit: limit } });
      const file = join(policyDir, name);
      writeFileSync(file, JSON.stringify(p));
      return file;
    };
    const p15 = write("p15.json", 15);
    const p12 = write("p12.json", 12);
    const ds = dataset("cli", threePairs());
    const base = ["--repo", repo.dir, "--pairs", ds, "--policy", p15, "--cccc", CCCC, "--workdir", workDir(), "--quiet"];
    expect(await replayCommand([...base, "--out", outDir(), "--compare-policy", p12, "--jobs", "2"])).toBe(1);
    expect(await replayCommand([...base, "--out", outDir()])).toBe(0);
    expect(await replayCommand(["--repo", repo.dir])).toBe(64);
    expect(await replayCommand([...base, "--out", outDir(), "--jobs", "0"])).toBe(64);
    expect(await replayCommand([...base, "--out", outDir(), "--bogus"])).toBe(64);
    const inside = join(repo.dir, "pairs.json");
    writeFileSync(inside, JSON.stringify({ schema_version: 1, pairs: threePairs() }));
    expect(await replayCommand(["--repo", repo.dir, "--pairs", inside, "--policy", p15, "--out", outDir(), "--cccc", CCCC, "--quiet"])).toBe(64);
    rmSync(inside);
  }, 180_000);
});

describe("pLimit", () => {
  it("never runs more than N tasks at once and preserves results and order", async () => {
    const limit = pLimit(2);
    let active = 0;
    let peak = 0;
    const task = (i: number) =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return i;
      });
    const results = await Promise.all([0, 1, 2, 3, 4].map(task));
    expect(results).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    await expect(limit(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(() => pLimit(0)).toThrow(RangeError);
  });
});
