// Regressions from the round-2 audits: F5 (parser lag), F10 (unpinned measurer), F15 (unreadable baseline).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildManifest } from "../../src/git/manifest.js";
import { validateCcccRun } from "../../src/measure/cccc.js";
import { checkMeasurer, enforcingGates } from "../../src/measure/fingerprint.js";
import { measureSides } from "../../src/measure/measure.js";
import { defaultPolicy } from "../../src/policy/schema.js";
import { TestRepo } from "../git/repo.js";
import { requireCccc } from "./helpers.js";

const id = { version: "cccc 1.8.5", sha256: "a".repeat(64) };

describe("unpinned measurer (audit F10)", () => {
  it("an empty pin with enforcing gates is MEASURER_MISMATCH", () => {
    const r = checkMeasurer(id, defaultPolicy());
    expect(r.map((i) => [i.reason, i.authorFixable])).toEqual([["MEASURER_MISMATCH", false]]);
    expect(r[0]!.detail).toContain("complexity");
  });
  it("allow_unpinned or an all-observe policy accepts an empty pin", () => {
    expect(checkMeasurer(id, defaultPolicy({ measurer: { allow_unpinned: true } }))).toEqual([]);
    const observeAll = defaultPolicy({
      complexity: { mode: "observe" }, lint: { mode: "observe" }, deps: { mode: "observe" },
      tests: { mode: "observe" }, coverage: { mode: "observe" }, review: { mode: "observe" },
    });
    expect(enforcingGates(observeAll)).toEqual([]);
    expect(checkMeasurer(id, observeAll)).toEqual([]);
  });
  it("degraded counts as gating", () => {
    expect(enforcingGates(defaultPolicy({ complexity: { mode: "degraded" } }))).toContain("complexity");
  });
  it("a matching pin passes, a different one does not", () => {
    expect(checkMeasurer(id, defaultPolicy({ measurer: { cccc_sha256: "a".repeat(64) } }))).toEqual([]);
    expect(checkMeasurer(id, defaultPolicy({ measurer: { cccc_sha256: "b".repeat(64) } })).map((i) => i.reason)).toEqual(["MEASURER_MISMATCH"]);
  });
});

describe("parser lag (audit F5)", () => {
  const run = (errs: string[]) => ({
    side: "C" as const,
    rc: 0,
    signal: null,
    stdout: Buffer.from(JSON.stringify({ files: [{ path: "a.ts", cognitive: 0, cyclomatic: 0, functions: [], parse_errors: errs }], summary: { file_count: 1 } })),
    stderr: Buffer.alloc(0),
    durationMs: 1,
    timedOut: false,
    expectedPaths: ["a.ts"],
  });
  it("allowlisted parse errors are for a gate owner, not the author", () => {
    const v = validateCcccRun(run(["Unexpected token `accessor`"]), 1000, { parserLagAllowlist: ["`accessor`"] });
    expect(v.inconclusive.map((i) => [i.reason, i.authorFixable])).toEqual([["PARSE_ERROR_CANDIDATE", false]]);
  });
  it("any non-listed error keeps it author-fixable", () => {
    const v = validateCcccRun(run(["Unexpected token `accessor`", "Expected `)`"]), 1000, { parserLagAllowlist: ["`accessor`"] });
    expect(v.inconclusive[0]!.authorFixable).toBe(true);
    expect(validateCcccRun(run(["Expected `)`"]), 1000, { parserLagAllowlist: [""] }).inconclusive[0]!.authorFixable).toBe(true);
  });
});

describe("unreadable baseline (audit F15)", () => {
  let repo: TestRepo | undefined;
  let work: string | undefined;
  afterEach(() => {
    repo?.dispose();
    if (work) rmSync(work, { recursive: true, force: true });
  });
  it("a non-UTF-8 B side only removes the baseline; its C units are new", async () => {
    repo = new TestRepo();
    const fn = "export function f(a: boolean) { if (a) { return 1; } return 0; }\n";
    const b = repo.commit({ "src/a.ts": Buffer.concat([Buffer.from(fn), Buffer.from([0x2f, 0x2f, 0xff, 0x0a])]) });
    const c = repo.commit({ "src/a.ts": fn });
    const policy = defaultPolicy({ measurer: { allow_unpinned: true } });
    const m = await buildManifest(repo.dir, b, c, policy);
    work = mkdtempSync(join(tmpdir(), "nyorori-r2m-"));
    const r = await measureSides({ repoDir: repo.dir, manifest: m, policy, binary: requireCccc(), workDir: work, rng: () => 1 });
    expect(r.inconclusive).toEqual([]);
    expect([...r.baselineMissing]).toEqual(["src/a.ts"]);
    expect(r.b.has("src/a.ts")).toBe(false);
    expect(r.c.get("src/a.ts")!.units[0]!.cognitive).toBe(1);
  });

  it("measures an extensionless node script end to end under its repository path", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ "bin/cli": "#!/usr/bin/env node\nfunction main(a) { if (a) { if (a > 1) { return 2; } } return 0; }\n" });
    const policy = defaultPolicy({ measurer: { allow_unpinned: true } });
    const m = await buildManifest(repo.dir, b, c, policy);
    work = mkdtempSync(join(tmpdir(), "nyorori-r2m-"));
    const r = await measureSides({ repoDir: repo.dir, manifest: m, policy, binary: requireCccc(), workDir: work, rng: () => 1 });
    expect(r.inconclusive).toEqual([]);
    expect(r.c.get("bin/cli")!.units.map((u) => [u.key, u.cognitive])).toEqual([["bin/cli::main#function[0]", 3]]);
  });
});
