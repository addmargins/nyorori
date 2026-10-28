// Regressions from the round-3 security review (/tmp/secreview s1_html, s3_collision, s4_fulltree).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildManifest, foldPathForCollision, hasEmbeddedScript, pathTooLong } from "../../src/git/manifest.js";
import { materializeFullTree, materializeSideChecked } from "../../src/git/tree.js";
import { defaultPolicy } from "../../src/policy/schema.js";
import type { Manifest, ManifestEntry } from "../../src/types.js";
import { TestRepo } from "./repo.js";

let repo: TestRepo | undefined;
let work: string | undefined;
afterEach(() => {
  repo?.dispose();
  repo = undefined;
  if (work) rmSync(work, { recursive: true, force: true });
  work = undefined;
});
const entry = (m: Manifest, p: string): ManifestEntry => m.entries.find((x) => (x.c ?? x.b)!.path === p)!;
const logic = "function run(x, y) { if (x) { if (y) { y += 1; } } return y; }";

/** Commits a blob under a path the working tree cannot hold. */
function commitRawPath(r: TestRepo, path: string, content: string): string {
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: r.dir, input: content }).toString().trim();
  r.git("update-index", "--add", "--cacheinfo", `100644,${blob},${path}`);
  r.git("commit", "-q", "-m", "raw");
  return r.git("rev-parse", "HEAD").trim();
}

describe("script-capable markup (security review #3)", () => {
  it("hasEmbeddedScript", () => {
    expect(hasEmbeddedScript(Buffer.from("<html><SCRIPT type=module>x()</SCRIPT></html>"))).toBe(true);
    expect(hasEmbeddedScript(Buffer.from('<svg><rect onclick="go()"/></svg>'))).toBe(true);
    expect(hasEmbeddedScript(Buffer.from('<a href="javascript:void(0)">x</a>'))).toBe(true);
    expect(hasEmbeddedScript(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'))).toBe(false);
    expect(hasEmbeddedScript(Buffer.from("<p>the descriptions mention scripts</p>"))).toBe(false);
  });

  it("routes .html/.htm/.svg/.xhtml carrying script as unmeasured; plain markup stays non-code", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({
      "src/page.html": `<!doctype html><html><body><script>\n${logic}\n</script></body></html>\n`,
      "src/legacy.htm": `<body onload="run(1,2)"></body>\n`,
      "assets/icon.svg": `<svg xmlns="http://www.w3.org/2000/svg"><script>${logic}</script></svg>\n`,
      "src/app.xhtml": `<a href="javascript:run()">go</a>\n`,
      "assets/plain.svg": `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>\n`,
      "docs/index.html": "<html><body><p>hello</p></body></html>\n",
    });
    const m = await buildManifest(repo.dir, b, c, defaultPolicy());
    for (const p of ["src/page.html", "src/legacy.htm", "assets/icon.svg", "src/app.xhtml"]) {
      expect(entry(m, p), p).toMatchObject({ unmeasured: "UNSUPPORTED_FORMAT", measure: { C: false } });
    }
    expect(entry(m, "assets/plain.svg")).toMatchObject({ excluded: "NOT_CODE" });
    expect(entry(m, "docs/index.html")).toMatchObject({ excluded: "NOT_CODE" });
    expect(m.problems).toEqual([]);
  });

  it("oversize script-capable files are routed, not trusted", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ "big.html": `<p>${"a".repeat(3000)}</p>\n` });
    const m = await buildManifest(repo.dir, b, c, defaultPolicy({ scope: { max_file_bytes: 1000 } }));
    expect(entry(m, "big.html")).toMatchObject({ unmeasured: "UNSUPPORTED_FORMAT" });
  });
});

describe("normalization-insensitive collisions (security review #9)", () => {
  it("folds NFC and the full case mapping", () => {
    expect(foldPathForCollision("src/café.js")).toBe(foldPathForCollision("src/café.js"));
    expect(foldPathForCollision("src/ıd.js")).toBe(foldPathForCollision("src/Id.js"));
    expect(foldPathForCollision("src/ſx.js")).toBe(foldPathForCollision("src/sx.js"));
    // Compatibility forms are not folded (no common file system does).
    expect(foldPathForCollision("src/ﬁ.js")).not.toBe(foldPathForCollision("src/fi.js"));
  });

  it.each([
    ["NFC vs NFD", "src/café.js", "src/café.js"],
    ["dotless i vs I", "src/ıd.js", "src/Id.js"],
    ["long s vs s", "src/ſx.js", "src/sx.js"],
    ["ASCII case", "src/A.js", "src/a.js"],
  ])("flags %s among changed files", async (_label, p1, p2) => {
    repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ [p1]: "export const a = 1;\n", [p2]: "export function b(x) { if (x) { return 2; } return 1; }\n" });
    const m = await buildManifest(repo.dir, b, c, defaultPolicy());
    expect(m.problems.filter((p) => p.reason === "CASE_COLLISION")).toHaveLength(2);
    expect(m.entries.filter((e) => e.measure.C)).toEqual([]);
  });

  it("flags an NFD addition against an unchanged NFC file in the full tree", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "src/café.js": "export const a = 1;\n" });
    const c = repo.commit({ "src/café.js": "export const b = 2;\n" });
    const m = await buildManifest(repo.dir, b, c, defaultPolicy());
    expect(m.problems.map((p) => [p.reason, p.path])).toEqual([["CASE_COLLISION", "src/café.js"]]);
  });
});

describe("paths too long for the work dir (security review #10)", () => {
  it("pathTooLong", () => {
    expect(pathTooLong("src/a.ts")).toBeNull();
    expect(pathTooLong(`src/${"x".repeat(252)}.ts`)).toBeNull(); // 255-byte segment
    expect(pathTooLong(`src/${"x".repeat(253)}.ts`)).toMatch(/segment is 256 bytes/);
    expect(pathTooLong(`src/${"é".repeat(128)}`)).toMatch(/segment is 256 bytes/); // counted in UTF-8 bytes
    expect(pathTooLong(Array.from({ length: 20 }, () => "y".repeat(250)).join("/"))).toMatch(/path is \d+ bytes/);
  });

  it("a changed file with an over-long name is an author-fixable problem, never a crash", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "src/a.js": "export const a = 1;\n" });
    const long = `src/${"x".repeat(300)}.js`;
    const c = commitRawPath(repo, long, "export const z = 1;\n");
    const m = await buildManifest(repo.dir, b, c, defaultPolicy());
    expect(m.problems.map((p) => [p.reason, p.path])).toEqual([["INVALID_ENCODING", long]]);
    expect(m.problems[0]!.detail).toContain("path too long for the gate's work dir");
    expect(entry(m, long).measure.C).toBe(false);
    work = mkdtempSync(join(tmpdir(), "nyorori-r3-"));
    expect((await materializeSideChecked(repo.dir, m, "C", join(work, "C"))).problems).toEqual([]);
  });

  it("an unchanged over-long file in the full tree is skipped with PATH_TOO_LONG", async () => {
    repo = new TestRepo();
    repo.commit({ "src/a.js": "export const a = 1;\n" });
    const long = `src/${"x".repeat(300)}.js`;
    commitRawPath(repo, long, "export const z = 1;\n");
    const c = repo.commit({ "src/a.js": "export const a = 2;\n" });
    work = mkdtempSync(join(tmpdir(), "nyorori-r3-"));
    const skipped: Array<[string, string]> = [];
    const files = await materializeFullTree(repo.dir, c, join(work, "full"), () => true, { onSkip: (p, why) => skipped.push([p, why]) });
    expect(files.map((f) => f.path)).toEqual(["src/a.js"]);
    expect(skipped).toEqual([[long, "PATH_TOO_LONG"]]);
  });
});
