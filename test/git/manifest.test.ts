import { afterEach, describe, expect, it } from "vitest";
import { buildManifest, classifyPath, extensionCandidates, isLfsPointer, parseNameStatus } from "../../src/git/manifest.js";
import { defaultPolicy } from "../../src/policy/schema.js";
import type { Manifest, ManifestEntry } from "../../src/types.js";
import { TestRepo } from "./repo.js";

const fn = (name: string, body = "return 1;") => `export function ${name}(a: boolean) { if (a) { ${body} } return 0; }\n`;
let repo: TestRepo;
afterEach(() => repo?.dispose());

const byPath = (m: Manifest) => new Map<string, ManifestEntry>(m.entries.map((e) => [(e.c ?? e.b)!.path, e]));

describe("pure helpers", () => {
  it("parseNameStatus handles R/C scores and NUL separation", () => {
    expect(parseNameStatus("M\0a.ts\0R087\0old.ts\0new.ts\0A\0b.ts\0D\0c.ts\0C100\0x.ts\0y.ts\0T\0l.ts\0")).toEqual([
      { status: "M", pathB: "a.ts", pathC: "a.ts" },
      { status: "R", similarity: 87, pathB: "old.ts", pathC: "new.ts" },
      { status: "A", pathB: null, pathC: "b.ts" },
      { status: "D", pathB: "c.ts", pathC: null },
      { status: "C", similarity: 100, pathB: "x.ts", pathC: "y.ts" },
      { status: "T", pathB: "l.ts", pathC: "l.ts" },
    ]);
  });
  it("extension candidates", () => {
    expect(extensionCandidates("src/a.d.ts")).toEqual([".d.ts", ".ts"]);
    expect(extensionCandidates("Makefile")).toEqual([""]);
    expect(extensionCandidates(".env.example")).toEqual([".env.example", ".example"]);
  });
  it("classifyPath follows the policy order", () => {
    const p = defaultPolicy({ scope: { exclude: ["generated/**"] } });
    expect(classifyPath("src/a.ts", p)).toEqual({ kind: "measure" });
    expect(classifyPath("src/A.TSX", p)).toEqual({ kind: "measure" });
    expect(classifyPath("src/a.d.ts", p)).toEqual({ kind: "excluded", reason: "DECLARATION_FILE" });
    expect(classifyPath("generated/a.ts", p)).toEqual({ kind: "excluded", reason: "POLICY_EXCLUDE" });
    expect(classifyPath("src/a.vue", p)).toEqual({ kind: "unmeasured", reason: "UNSUPPORTED_FORMAT" });
    expect(classifyPath("README.md", p)).toEqual({ kind: "excluded", reason: "NOT_CODE" });
    expect(classifyPath("LICENSE", p)).toEqual({ kind: "excluded", reason: "NOT_CODE" });
    expect(classifyPath("tool.py", p)).toEqual({ kind: "unregistered", ext: ".py" });
  });
  it("isLfsPointer", () => {
    expect(isLfsPointer(Buffer.from("version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 3\n"))).toBe(true);
    expect(isLfsPointer(Buffer.from("export const version = 1;\n"))).toBe(false);
  });
});

describe("buildManifest on real repositories", () => {
  it("classifies statuses, sides and test files", async () => {
    repo = new TestRepo();
    const big = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";
    const b = repo.commit({ "src/keep.ts": fn("keep"), "src/old.ts": big, "src/gone.ts": fn("gone"), "src/a.test.ts": fn("t") });
    const c = repo.commit({
      "src/keep.ts": fn("keep", "return 2;"),
      "src/old.ts": null,
      "src/new.ts": big.replace("v0 = 0", "v0 = 100"),
      "src/gone.ts": null,
      "src/added.ts": fn("added"),
      "README.md": "# hi\n",
    });
    const m = await buildManifest(repo.dir, b, c, defaultPolicy());
    expect(m.baseSha).toBe(b);
    expect(m.candidateSha).toBe(c);
    const e = byPath(m);
    expect(e.get("src/keep.ts")).toMatchObject({ status: "M", measure: { B: true, C: true } });
    expect(e.get("src/new.ts")).toMatchObject({ status: "R", measure: { B: true, C: true }, b: { path: "src/old.ts" } });
    expect(e.get("src/new.ts")!.similarity).toBeGreaterThanOrEqual(70);
    expect(e.get("src/gone.ts")).toMatchObject({ status: "D", c: null, measure: { B: true, C: false } });
    expect(e.get("src/added.ts")).toMatchObject({ status: "A", b: null, measure: { B: false, C: true } });
    expect(e.get("README.md")).toMatchObject({ excluded: "NOT_CODE", measure: { B: false, C: false } });
    expect(m.problems).toEqual([]);
  });

  it("marks symlinks, submodules and type changes unmeasured", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "src/real.ts": fn("r"), "src/flip.ts": fn("flip") });
    const c = repo.commit({
      "src/link.ts": { symlink: "../../../etc/passwd" },
      "vendor/sub": { gitlink: b },
      "src/flip.ts": { symlink: "real.ts" },
    });
    const e = byPath(await buildManifest(repo.dir, b, c, defaultPolicy()));
    expect(e.get("src/link.ts")).toMatchObject({ unmeasured: "SYMLINK", measure: { B: false, C: false } });
    expect(e.get("vendor/sub")).toMatchObject({ unmeasured: "SUBMODULE", measure: { B: false, C: false } });
    expect(e.get("src/flip.ts")).toMatchObject({ status: "T", unmeasured: "TYPE_CHANGE", measure: { B: true, C: false } });
  });

  it("routes unsupported formats, excluded paths, declarations and unregistered extensions", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "x.txt": "x\n" });
    const c = repo.commit({
      "src/App.vue": "<script>export default {}</script>\n",
      "generated/api.ts": fn("gen"),
      "src/types.d.ts": "export declare const x: number;\n",
      "scripts/run.py": "print(1)\n",
      ".gitattributes": "*.ts text\n",
    });
    const m = await buildManifest(repo.dir, b, c, defaultPolicy({ scope: { exclude: ["generated/**"] } }));
    const e = byPath(m);
    expect(e.get("src/App.vue")).toMatchObject({ unmeasured: "UNSUPPORTED_FORMAT" });
    expect(e.get("generated/api.ts")).toMatchObject({ excluded: "POLICY_EXCLUDE", newInExcludedPath: true });
    expect(e.get("src/types.d.ts")).toMatchObject({ excluded: "DECLARATION_FILE" });
    expect(m.problems).toEqual([expect.objectContaining({ reason: "UNREGISTERED_EXTENSION", path: "scripts/run.py" })]);
    expect(m.sensitivePathsChanged).toEqual([".gitattributes"]);
  });

  it("detects LFS pointers, oversize blobs and case collisions", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "x.txt": "x\n" });
    const c = repo.commit({
      "src/lfs.ts": "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a\nsize 12345\n",
      "src/huge.ts": "export const s = '" + "a".repeat(3000) + "';\n",
      "src/Util.ts": fn("u1"),
      "src/util.ts": fn("u2"),
    });
    const m = await buildManifest(repo.dir, b, c, defaultPolicy({ scope: { max_file_bytes: 2000 } }));
    const reasons = m.problems.map((p) => [p.reason, p.path]);
    expect(reasons).toContainEqual(["LFS_POINTER", "src/lfs.ts"]);
    expect(reasons).toContainEqual(["FILE_TOO_LARGE", "src/huge.ts"]);
    expect(reasons.filter((r) => r[0] === "CASE_COLLISION")).toHaveLength(1);
    const e = byPath(m);
    expect(e.get("src/lfs.ts")!.measure.C).toBe(false);
    expect(e.get("src/huge.ts")!.measure.C).toBe(false);
  });

  it("gives JSX-in-.js files a .jsx measured path that does not collide with a real .jsx", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "x.txt": "x\n" });
    const c = repo.commit({ "src/foo.js": "export const A = () => <div />;\n", "src/foo.jsx": "export const B = () => <p />;\n" });
    const m = await buildManifest(repo.dir, b, c, defaultPolicy({ scope: { jsx_in_js: ["src/**"] } }));
    const e = byPath(m);
    expect(e.get("src/foo.js")!.c!.measuredPath).toBe("src/foo.js.jsx");
    expect(e.get("src/foo.jsx")!.c!.measuredPath).toBe("src/foo.jsx");
    expect(m.problems).toEqual([]);
  });

  it("ignores repository-level attributes and configs: classification comes from policy only", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "src/a.ts": fn("a") });
    const c = repo.commit({ "src/a.ts": fn("a", "return 3;"), "cccc.toml": 'exclude = ["src/**"]\n', ".gitattributes": "*.ts -diff export-ignore\n" });
    const e = byPath(await buildManifest(repo.dir, b, c, defaultPolicy()));
    expect(e.get("src/a.ts")).toMatchObject({ status: "M", measure: { B: true, C: true } });
    expect(e.get("cccc.toml")).toMatchObject({ excluded: "NOT_CODE" });
  });

  it("rejects unknown revisions", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "a.ts": fn("a") });
    await expect(buildManifest(repo.dir, b, "deadbeef", defaultPolicy())).rejects.toThrow();
  });
});
