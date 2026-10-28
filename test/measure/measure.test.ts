import { readFile, readdir } from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addedCLines, fileLineMaps, mapLine } from "../../src/git/linemap.js";
import { buildManifest } from "../../src/git/manifest.js";
import { assertSafeRelativePath, countLines, materializeFullTree, materializeSide } from "../../src/git/tree.js";
import { runCccc, validateRuns } from "../../src/measure/cccc.js";
import { measureSides } from "../../src/measure/measure.js";
import { defaultPolicy } from "../../src/policy/schema.js";
import { flattenUnits } from "../../src/units/model.js";
import { TestRepo } from "../git/repo.js";
import { requireCccc } from "./helpers.js";

const complex = (name: string) => `export function ${name}(a: number, b: boolean) {
  if (a > 1) {
    if (b) {
      return 1;
    }
  }
  return 0;
}
`;
let repo: TestRepo | undefined;
let work: string | undefined;
afterEach(() => {
  repo?.dispose();
  repo = undefined;
  if (work) rmSync(work, { recursive: true, force: true });
  work = undefined;
});
const newWork = () => (work = mkdtempSync(join(tmpdir(), "nyorori-work-")));

describe("tree materialization", () => {
  it("rejects unsafe paths", () => {
    for (const p of ["", "/etc/passwd", "../x", "a/../../x", "a//b", "a/./b", "a\0b"]) {
      expect(() => assertSafeRelativePath(p), p).toThrow();
    }
    expect(() => assertSafeRelativePath("src/a.ts")).not.toThrow();
  });
  it("countLines", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\r\nb\r\n")).toBe(2);
  });

  it("writes blob bytes exactly, ignoring working-tree-encoding in .gitattributes", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "src/a.ts": complex("a") });
    // The candidate adds an attribute that would make checkout re-encode every .ts as UTF-16.
    const c = repo.commit({ "src/a.ts": complex("a2"), ".gitattributes": "*.ts working-tree-encoding=UTF-16 eol=crlf\n" });
    const m = await buildManifest(repo.dir, b, c, defaultPolicy());
    const dest = join(newWork(), "C");
    const files = await materializeSide(repo.dir, m, "C", dest);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(await readFile(join(dest, "src/a.ts"), "utf8")).toBe(complex("a2"));
    expect(await readdir(dest)).toEqual(["src"]); // nothing but the manifest's measured files
  });

  it("materializeFullTree writes regular files only", async () => {
    repo = new TestRepo();
    const c = repo.commit({ "src/a.ts": complex("a"), "src/link.ts": { symlink: "a.ts" }, "README.md": "x\n" });
    const dest = join(newWork(), "full");
    const files = await materializeFullTree(repo.dir, c, dest, (p) => p.endsWith(".ts"));
    expect(files.map((f) => f.path)).toEqual(["src/a.ts"]);
  });
});

describe("line maps on real repositories", () => {
  it("maps unchanged lines across an edit and a rename", async () => {
    repo = new TestRepo();
    const body = Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";
    const b = repo.commit({ "src/old.ts": body });
    const edited = body.replace("export const v10 = 10;\n", "export const v10 = 10;\nexport const extra = 1;\n");
    const c = repo.commit({ "src/old.ts": null, "src/new.ts": edited });
    const m = await buildManifest(repo.dir, b, c, defaultPolicy());
    const [map] = await fileLineMaps(repo.dir, m);
    expect(map).toMatchObject({ pathB: "src/old.ts", pathC: "src/new.ts" });
    expect(mapLine(map!, 5)).toBe(5);
    expect(mapLine(map!, 12)).toBe(13);
    expect([...addedCLines(map!)]).toEqual([12]);
  });

  it("ignores -diff/binary attributes in the candidate tree", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "src/a.ts": "a\nb\nc\n" });
    const c = repo.commit({ ".gitattributes": "*.ts -diff binary\n", "src/a.ts": "a\nB\nc\n" });
    const m = await buildManifest(repo.dir, b, c, defaultPolicy());
    const maps = await fileLineMaps(repo.dir, m);
    expect(maps.find((x) => x.pathC === "src/a.ts")!.hunks).toEqual([{ bStart: 2, bCount: 1, cStart: 2, cCount: 1 }]);
  });

  it("covers added files with one hunk", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "x.txt": "x\n" });
    const c = repo.commit({ "src/a.ts": "a\nb\n" });
    const [map] = await fileLineMaps(repo.dir, await buildManifest(repo.dir, b, c, defaultPolicy()));
    expect(map!.hunks).toEqual([{ bStart: 0, bCount: 0, cStart: 1, cCount: 2 }]);
  });
});

describe("measureSides end to end", () => {
  const policy = defaultPolicy({ measurer: { determinism_sample_rate: 1, allow_unpinned: true } });

  it("measures B and C, keyed by repository path, with a determinism re-run", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "src/a.ts": complex("a"), "src/same.ts": complex("same") });
    const c = repo.commit({ "src/a.ts": complex("a") + complex("extra"), "src/same.ts": null, "src/moved.ts": complex("same") });
    const m = await buildManifest(repo.dir, b, c, policy);
    const r = await measureSides({ repoDir: repo.dir, manifest: m, policy, binary: requireCccc(), workDir: newWork() });
    expect(r.inconclusive).toEqual([]);
    expect(r.determinismChecked).toBe(true);
    expect(flattenUnits(r.b.get("src/a.ts")!.units).map((u) => [u.name, u.cognitive])).toEqual([["a", 3]]);
    expect(flattenUnits(r.c.get("src/a.ts")!.units).map((u) => [u.name, u.cognitive])).toEqual([["a", 3], ["extra", 3]]);
    // Pure rename: measured once, B reuses C's report under its own path.
    expect(r.b.get("src/same.ts")!.units[0]!.key).toBe("src/same.ts::same#function[0]");
    expect(r.c.get("src/moved.ts")!.units[0]!.key).toBe("src/moved.ts::same#function[0]");
    expect(r.runs.filter((x) => x.side === "B").flatMap((x) => x.expectedPaths)).toEqual(["src/a.ts"]);
    expect(r.fingerprint.cccc_version).toBe("cccc 1.8.5");
    expect(r.fingerprint.cccc_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("still measures every .ts after the candidate adds a UTF-16 working-tree-encoding attribute", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "src/a.ts": complex("a"), "src/b.ts": complex("b") });
    const c = repo.commit({
      "src/a.ts": complex("a").replace("a > 1", "a > 2"),
      "src/b.ts": complex("b").replace("a > 1", "a > 3"),
      ".gitattributes": "*.ts working-tree-encoding=UTF-16\n",
    });
    // The threat is real: a checkout of C re-encodes the file and cccc skips it.
    rmSync(join(repo.dir, "src/a.ts"));
    repo.git("checkout", "-f", c, "--", "src/a.ts");
    const checkedOut = await readFile(join(repo.dir, "src/a.ts"));
    expect(checkedOut[0] === 0xfe || checkedOut[0] === 0xff).toBe(true);
    const checkoutDir = join(newWork(), "checkout");
    mkdirSync(checkoutDir);
    writeFileSync(join(checkoutDir, "a.ts"), checkedOut);
    const naive = validateRuns(await runCccc({ binary: requireCccc(), treeRoot: checkoutDir, files: ["a.ts"], policy, side: "C" }), policy);
    expect(naive.files).toEqual([]); // a checkout-based gate would have measured nothing
    const m = await buildManifest(repo.dir, b, c, policy);
    expect(m.sensitivePathsChanged).toEqual([".gitattributes"]);
    const r = await measureSides({ repoDir: repo.dir, manifest: m, policy, binary: requireCccc(), workDir: newWork() });
    expect(r.inconclusive).toEqual([]);
    expect([...r.c.keys()].sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(r.c.get("src/a.ts")!.units[0]!.cognitive).toBe(3);
  });

  it("ignores a candidate cccc.toml that excludes everything", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "src/a.ts": complex("a") });
    const c = repo.commit({ "cccc.toml": 'exclude = ["src/**"]\n', ".cccc.toml": 'exclude = ["**"]\n', "src/a.ts": complex("a") + complex("z") });
    const m = await buildManifest(repo.dir, b, c, policy);
    const r = await measureSides({ repoDir: repo.dir, manifest: m, policy, binary: requireCccc(), workDir: newWork() });
    expect(r.inconclusive).toEqual([]);
    expect(flattenUnits(r.c.get("src/a.ts")!.units)).toHaveLength(2);
  });

  it("C-side syntax error is INCONCLUSIVE and author-fixable; B-side syntax error removes the baseline", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "src/broken-before.ts": "export function f( {\n", "src/broken-after.ts": complex("x") });
    const c = repo.commit({ "src/broken-before.ts": complex("f"), "src/broken-after.ts": "export function x( {\n" });
    const m = await buildManifest(repo.dir, b, c, policy);
    const r = await measureSides({ repoDir: repo.dir, manifest: m, policy, binary: requireCccc(), workDir: newWork() });
    expect(r.inconclusive.map((i) => [i.reason, i.file, i.authorFixable])).toEqual([["PARSE_ERROR_CANDIDATE", "src/broken-after.ts", true]]);
    expect([...r.baselineMissing]).toEqual(["src/broken-before.ts"]);
    expect(r.b.has("src/broken-before.ts")).toBe(false);
    expect(r.c.get("src/broken-before.ts")!.units[0]!.cognitive).toBe(3);
  });

  it("non-UTF-8 candidate file is INCONCLUSIVE and author-fixable", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "src/a.ts": complex("a") });
    const c = repo.commit({ "src/a.ts": Buffer.concat([Buffer.from(complex("a")), Buffer.from([0x2f, 0x2f, 0xff, 0x0a])]) });
    const m = await buildManifest(repo.dir, b, c, policy);
    const r = await measureSides({ repoDir: repo.dir, manifest: m, policy, binary: requireCccc(), workDir: newWork() });
    const reasons = r.inconclusive.map((i) => [i.reason, i.authorFixable]);
    expect(reasons).toContainEqual(["MANIFEST_MISMATCH", true]);
    expect(r.c.has("src/a.ts")).toBe(false);
  });

  it("UNITS_VANISHED when a file with many units keeps its size but loses every unit", async () => {
    repo = new TestRepo();
    const many = ["a", "b", "c", "d", "e"].map(complex).join("");
    const b = repo.commit({ "src/m.ts": many });
    const strings = many
      .split("\n")
      .map((l, i) => `const s${i} = ${JSON.stringify(l)};`)
      .join("\n");
    const c = repo.commit({ "src/m.ts": `${strings}\nexport const run = new Function(s0);\n` });
    const m = await buildManifest(repo.dir, b, c, policy);
    const r = await measureSides({ repoDir: repo.dir, manifest: m, policy, binary: requireCccc(), workDir: newWork() });
    expect(r.inconclusive.map((i) => i.reason)).toEqual(["UNITS_VANISHED"]);
  });

  it("measurer pin mismatch stops before measuring", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "src/a.ts": complex("a") });
    const c = repo.commit({ "src/a.ts": complex("a2") });
    const pinned = defaultPolicy({ measurer: { cccc_sha256: "0".repeat(64) } });
    const m = await buildManifest(repo.dir, b, c, pinned);
    const r = await measureSides({ repoDir: repo.dir, manifest: m, policy: pinned, binary: requireCccc(), workDir: newWork() });
    expect(r.inconclusive.map((i) => i.reason)).toEqual(["MEASURER_MISMATCH"]);
    expect(r.runs).toEqual([]);
  });

  it("measures JSX-in-.js through the .jsx suffix and reports by repository path", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "x.txt": "x\n" });
    const c = repo.commit({ "src/foo.js": "export const A = (p) => <div>{p.a && <b />}</div>;\n", "src/foo.jsx": "export const B = (p) => (p.x ? <i /> : null);\n" });
    const p = defaultPolicy({ scope: { jsx_in_js: ["src/**"] }, measurer: { allow_unpinned: true } });
    const m = await buildManifest(repo.dir, b, c, p);
    const r = await measureSides({ repoDir: repo.dir, manifest: m, policy: p, binary: requireCccc(), workDir: newWork() });
    expect(r.inconclusive).toEqual([]);
    expect([...r.c.keys()].sort()).toEqual(["src/foo.js", "src/foo.jsx"]);
    expect(r.c.get("src/foo.js")!.units[0]!.key).toBe("src/foo.js::A#arrow[0]");
  });
});
