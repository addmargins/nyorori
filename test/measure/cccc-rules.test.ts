// Spec 3.3 calculation-rule fixtures against the real pinned binary. Any
// failure here after a measurer upgrade is a scoring change that must be
// listed in the policy change (spec 6.1).

import { mkdtemp, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCccc, validateRuns } from "../../src/measure/cccc.js";
import { defaultPolicy } from "../../src/policy/schema.js";
import type { CcccFile } from "../../src/types.js";
import { buildFileMeasurement, flattenUnits } from "../../src/units/model.js";
import { requireCccc } from "./helpers.js";

const FIXTURES = new URL("../fixtures/cccc-rules/", import.meta.url).pathname;
type Row = [string, string, number, number, number, number];
interface Expectation {
  functions: Row[];
  residue: [number, number];
  parseErrors?: boolean;
}

async function measureAll(dir: string, files: string[], jobs?: number) {
  const policy = defaultPolicy();
  const runs = await runCccc({ binary: requireCccc(), treeRoot: dir, files, policy, side: "B", ...(jobs ? { jobs } : {}) });
  return { runs, validated: validateRuns(runs, policy) };
}

describe("cccc 1.8.5 calculation rules (spec 3.3)", async () => {
  const expected = JSON.parse(await readFile(join(FIXTURES, "expected.json"), "utf8")) as Record<string, Expectation | string>;
  const files = Object.keys(expected).filter((k) => !k.startsWith("_"));
  const { runs, validated } = await measureAll(FIXTURES, files);
  const byPath = new Map<string, CcccFile>(validated.files.map((f) => [f.path, f]));

  it("covers every fixture file on disk", async () => {
    const onDisk = (await readdir(FIXTURES)).filter((f) => f !== "expected.json").sort();
    expect(onDisk).toEqual([...files].sort());
  });

  it("exits 0 even with parse errors, and reports them only in parse_errors", () => {
    expect(runs.every((r) => r.rc === 0)).toBe(true);
    expect(runs.map((r) => r.stderr.toString())).toEqual([""]);
  });

  it.each(files)("%s", (file) => {
    const exp = expected[file] as Expectation;
    const report = byPath.get(file);
    expect(report, `${file} missing from cccc output`).toBeDefined();
    const m = buildFileMeasurement("C", file, "0", report!, 10);
    const rows = flattenUnits(m.units).map((u): Row => [u.name, u.kind, u.line, u.cognitive, u.cyclomatic, u.depth]);
    expect(rows).toEqual(exp.functions);
    expect([m.residue.cognitive, m.residue.cyclomatic]).toEqual(exp.residue);
    expect(m.parseErrors.length > 0).toBe(Boolean(exp.parseErrors));
  });

  it("scores a syntax-error file 0/0, losing the functions before the error", () => {
    const f = byPath.get("syntax-error.ts")!;
    expect([f.cognitive, f.cyclomatic, f.functions.length]).toEqual([0, 0, 0]);
  });

  it("produces byte-identical output with -j1 and -j4", async () => {
    const one = await measureAll(FIXTURES, files, 1);
    const four = await measureAll(FIXTURES, files, 4);
    expect(Buffer.concat(one.runs.map((r) => r.stdout)).equals(Buffer.concat(four.runs.map((r) => r.stdout)))).toBe(true);
  });
});

describe("cccc 1.8.5 I/O behaviour (spec 3.1 C4/C5, 6.3)", () => {
  it("skips a non-UTF-8 file: missing from files[], reported on stderr, exit 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nyorori-enc-"));
    try {
      await copyFile(join(FIXTURES, "if.ts"), join(dir, "ok.ts"));
      await writeFile(join(dir, "enc.ts"), Buffer.from([0x63, 0x6f, 0x6e, 0x73, 0x74, 0x20, 0x78, 0x3d, 0x22, 0xff, 0xfe, 0x22, 0x0a]));
      const { runs, validated } = await measureAll(dir, ["ok.ts", "enc.ts"]);
      expect(runs[0]!.rc).toBe(0);
      expect(runs[0]!.stderr.toString()).toContain("cannot read enc.ts");
      expect(validated.files.map((f) => f.path)).toEqual(["ok.ts"]);
      const reasons = validated.inconclusive.map((i) => [i.reason, i.file ?? null, i.authorFixable]);
      expect(reasons).toContainEqual(["MANIFEST_MISMATCH", "enc.ts", true]);
      expect(reasons).toContainEqual(["MEASURER_STDERR", null, true]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops an explicitly named file with an unrouted extension without any message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nyorori-ext-"));
    try {
      await writeFile(join(dir, "a.foo"), "if (a) {}\n");
      const { runs, validated } = await measureAll(dir, ["a.foo"]);
      expect(runs[0]!.rc).toBe(0);
      expect(runs[0]!.stderr.toString()).toBe("");
      const parsed = JSON.parse(runs[0]!.stdout.toString()) as { files: unknown[] };
      expect(parsed.files).toEqual([]);
      expect(validated.inconclusive.map((i) => i.reason)).toEqual(["MANIFEST_MISMATCH", "MANIFEST_MISMATCH"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("routes a .js.jsx copy as JSX while the plain .js fails to parse", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nyorori-jsx-"));
    try {
      const src = "export const A = (p) => <div>{p.a && <b />}</div>;\n";
      await writeFile(join(dir, "foo.js"), src);
      await writeFile(join(dir, "foo.js.jsx"), src);
      await writeFile(join(dir, "foo.jsx"), src);
      const { validated } = await measureAll(dir, ["foo.js", "foo.js.jsx", "foo.jsx"]);
      const by = new Map(validated.files.map((f) => [f.path, f]));
      expect(by.get("foo.js")!.parse_errors?.length).toBeGreaterThan(0);
      expect(by.get("foo.js.jsx")!.parse_errors).toBeUndefined();
      expect([by.get("foo.js.jsx")!.cognitive, by.get("foo.js.jsx")!.cyclomatic]).toEqual([
        by.get("foo.jsx")!.cognitive,
        by.get("foo.jsx")!.cyclomatic,
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
