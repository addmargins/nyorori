// Regressions from the round-2 audits (docs/debate/audit-*.md) and rulings D5/D6.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodePath, isInvalidPath, splitNul } from "../../src/git/exec.js";
import { buildManifest, readBlobsBatched, shebangKind } from "../../src/git/manifest.js";
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
const newWork = () => (work = mkdtempSync(join(tmpdir(), "nyorori-r2-")));
const entry = (m: Manifest, p: string): ManifestEntry => m.entries.find((x) => (x.c ?? x.b)!.path === p)!;
const script = (shebang: string) => `${shebang}\nfunction main(a) { if (a) { return 1; } return 0; }\nmain(process.argv[2]);\n`;

describe("extensionless files (ruling D6, audit F6 / bug #4)", () => {
  it("shebangKind", () => {
    expect(shebangKind(Buffer.from("#!/usr/bin/env node\n"))).toBe("js");
    expect(shebangKind(Buffer.from("#!/usr/bin/env -S node --experimental-vm-modules\n"))).toBe("js");
    expect(shebangKind(Buffer.from("#!/usr/bin/env bun\n"))).toBe("js");
    expect(shebangKind(Buffer.from("#!/usr/bin/env -S deno run -A\n"))).toBe("js");
    expect(shebangKind(Buffer.from("#!/usr/bin/env ts-node\n"))).toBe("ts");
    expect(shebangKind(Buffer.from("#!/usr/bin/env -S npx tsx\n"))).toBe("ts");
    expect(shebangKind(Buffer.from("#!/bin/bash\n"))).toBe("foreign");
    expect(shebangKind(Buffer.from("#!/usr/bin/env python3\n"))).toBe("foreign");
    expect(shebangKind(Buffer.from("module.exports = 1;\n"))).toBeNull();
    expect(shebangKind(Buffer.alloc(0))).toBeNull();
  });

  it("measures node/tsx scripts under a suffixed path, records other shebangs as foreign, keeps the rest non-code", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "bin/cli": script("#!/usr/bin/env node"), "README.md": "x\n" });
    const c = repo.commit({
      "bin/cli": script("#!/usr/bin/env node").replace("return 1", "return 2"),
      "bin/cli.js": "module.exports = 1;\n",
      "bin/dev": script("#!/usr/bin/env -S npx tsx"),
      "bin/deploy": "#!/bin/sh\necho hi\n",
      "lib/pricing": "module.exports = (a) => { if (a) { return 1; } return 2; };\n",
      "LICENSE": "MIT\n",
    });
    const m = await buildManifest(repo.dir, b, c, defaultPolicy());
    expect(entry(m, "bin/cli")).toMatchObject({ status: "M", measure: { B: true, C: true } });
    expect(entry(m, "bin/cli").c!.measuredPath).toBe("bin/cli.shebang.js");
    expect(entry(m, "bin/cli").b!.measuredPath).toBe("bin/cli.shebang.js");
    expect(entry(m, "bin/cli.js")).toMatchObject({ measure: { C: true } });
    expect(entry(m, "bin/dev").c!.measuredPath).toBe("bin/dev.shebang.ts");
    expect(entry(m, "bin/deploy")).toMatchObject({ unmeasured: "FOREIGN_LANGUAGE", measure: { C: false } });
    // No shebang: non-code here; a require() of it is G2's business (audit F6 → builder C).
    expect(entry(m, "lib/pricing")).toMatchObject({ excluded: "NOT_CODE", measure: { C: false } });
    expect(entry(m, "LICENSE")).toMatchObject({ excluded: "NOT_CODE" });
    expect(m.problems).toEqual([]);

    const files = (await materializeSideChecked(repo.dir, m, "C", join(newWork(), "C"))).files;
    expect(files.map((f) => f.measuredPath).sort()).toEqual(["bin/cli.js", "bin/cli.shebang.js", "bin/dev.shebang.ts"]);
  });
});

describe("case collisions (audit F16, bug #5)", () => {
  it("checks the candidate's full tree, not only changed files", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "src/util.ts": "export const a = 1;\n" });
    const c = repo.commit({ "src/Util.ts": "export const b = 2;\n" });
    const m = await buildManifest(repo.dir, b, c, defaultPolicy());
    expect(m.problems.map((p) => [p.reason, p.path])).toEqual([["CASE_COLLISION", "src/Util.ts"]]);
    expect(entry(m, "src/Util.ts").measure.C).toBe(false);
  });

  it("a .jsx suffix colliding with a real file is INCONCLUSIVE, not a crash", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ "src/foo.js": "export const a = 1;\n", "src/foo.js.jsx": "export const b = 2;\n" });
    const m = await buildManifest(repo.dir, b, c, defaultPolicy({ scope: { jsx_in_js: ["src/**"] } }));
    expect(m.problems.map((p) => p.reason)).toEqual(["CASE_COLLISION", "CASE_COLLISION"]);
    const r = await materializeSideChecked(repo.dir, m, "C", join(newWork(), "C"));
    expect(r).toEqual({ files: [], problems: [] });
  });

  it("materializeSideChecked turns a write collision into a record instead of throwing", async () => {
    repo = new TestRepo();
    const c = repo.commit({ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 1;\n" });
    const m = await buildManifest(repo.dir, `${c}~0`, c, defaultPolicy());
    const blob = repo.git("rev-parse", `${c}:a.ts`).trim();
    const side = (path: string) => ({ path, blob, mode: "100644", measuredPath: "same.ts" });
    const forged: Manifest = {
      ...m,
      entries: ["a.ts", "b.ts"].map((p) => ({ status: "A", b: null, c: side(p), measure: { B: false, C: true } }) as ManifestEntry),
    };
    const r = await materializeSideChecked(repo.dir, forged, "C", join(newWork(), "C"));
    expect(r.files.map((f) => f.path)).toEqual(["a.ts"]);
    expect(r.problems.map((p) => [p.reason, p.file, p.authorFixable])).toEqual([["CASE_COLLISION", "b.ts", true]]);
  });
});

describe("paths that are not valid UTF-8 (bug #5)", () => {
  it("decodePath keeps distinct invalid byte paths distinct", () => {
    const a = decodePath(Buffer.from([0x61, 0xff, 0x2e, 0x74, 0x73]));
    const b = decodePath(Buffer.from([0x61, 0xfe, 0x2e, 0x74, 0x73]));
    expect(a).not.toBe(b);
    expect(isInvalidPath(a)).toBe(true);
    expect(decodePath(Buffer.from("ü.ts"))).toBe("ü.ts");
    expect(splitNul(Buffer.from([0x61, 0, 0xff, 0]))).toEqual(["a", decodePath(Buffer.from([0xff]))]);
  });

  it("flags them INVALID_ENCODING and never measures or writes them", async () => {
    repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo.dir, input: "export const x = 1;\n" }).toString().trim();
    const index = Buffer.concat([
      Buffer.from(`100644 ${blob}\t`), Buffer.from([0x78, 0xff, 0x2e, 0x74, 0x73]), Buffer.from([0]),
      Buffer.from(`100644 ${blob}\t`), Buffer.from([0x78, 0xfe, 0x2e, 0x74, 0x73]), Buffer.from([0]),
    ]);
    execFileSync("git", ["update-index", "-z", "--index-info"], { cwd: repo.dir, input: index });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "bad names"], { cwd: repo.dir });
    const c = repo.git("rev-parse", "HEAD").trim();
    const m = await buildManifest(repo.dir, b, c, defaultPolicy());
    expect(m.problems.map((p) => p.reason)).toEqual(["INVALID_ENCODING", "INVALID_ENCODING"]);
    expect(m.entries.every((e) => !e.measure.C)).toBe(true);
    const r = await materializeSideChecked(repo.dir, m, "C", join(newWork(), "C"));
    expect(r.files).toEqual([]);
    const skipped: string[] = [];
    const full = await materializeFullTree(repo.dir, c, join(newWork(), "full"), () => true, { onSkip: (_p, why) => skipped.push(why) });
    expect(full.map((f) => f.path)).toEqual(["README.md"]);
    expect(skipped).toEqual(["INVALID_ENCODING", "INVALID_ENCODING"]);
  });
});

describe("bounded blob reads (bug #10)", () => {
  it("readBlobsBatched returns every blob with a tiny budget", async () => {
    repo = new TestRepo();
    const files = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`f${i}.ts`, `export const v = ${"x".repeat(i * 50)};\n`]));
    const c = repo.commit(files);
    const blobs = Object.keys(files).map((p) => repo!.git("rev-parse", `${c}:${p}`).trim());
    const got = await readBlobsBatched(repo.dir, blobs, 100);
    expect(got.size).toBe(7);
    expect(got.get(blobs[6]!)!.toString()).toBe(files["f6.ts"]);
  });

  it("materializeFullTree skips files above the size cap", async () => {
    repo = new TestRepo();
    const c = repo.commit({ "small.ts": "export const a = 1;\n", "big.ts": `export const s = "${"a".repeat(5000)}";\n` });
    const skipped: Array<[string, string]> = [];
    const out = await materializeFullTree(repo.dir, c, join(newWork(), "full"), () => true, {
      maxFileBytes: 1000,
      onSkip: (p, why) => skipped.push([p, why]),
    });
    expect(out.map((f) => f.path)).toEqual(["small.ts"]);
    expect(skipped).toEqual([["big.ts", "FILE_TOO_LARGE"]]);
  });
});
