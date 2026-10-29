// The cccc invocation contract (spec 6.3) and the --version pin (spec 6.1),
// checked against a fake measurer that records how it was called.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildManifest } from "../../src/git/manifest.js";
import { runCccc, validateRuns } from "../../src/measure/cccc.js";
import { checkMeasurer, identifyMeasurer } from "../../src/measure/fingerprint.js";
import { measureSides } from "../../src/measure/measure.js";
import { defaultPolicy } from "../../src/policy/schema.js";
import { TestRepo } from "../git/repo.js";

interface Call {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
}

let dir: string;
let fake: string;
let log: string;

/** A measurer stand-in: records argv/env/cwd, answers --version, emits cccc-shaped JSON for the files after `--`. */
function writeFake(version: string): void {
  writeFileSync(
    fake,
    `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv[0] === "--version") { process.stdout.write(${JSON.stringify(version)} + "\\n"); process.exit(0); }
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, env: process.env, cwd: process.cwd() }) + "\\n");
const files = argv.slice(argv.indexOf("--") + 1).map((path) => ({ path, cognitive: 1, cyclomatic: 2, functions: [{ name: "f", kind: "function", line: 1, cognitive: 1, cyclomatic: 2 }] }));
process.stdout.write(JSON.stringify({ files, summary: { file_count: files.length, function_count: files.length } }));
`,
  );
  chmodSync(fake, 0o755);
}

const calls = (): Call[] =>
  existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Call) : [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nyorori-fake-"));
  fake = join(dir, "cccc");
  log = join(dir, "calls.jsonl");
  writeFake("cccc 1.8.5");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function tree(files: string[]): string {
  const root = join(dir, "tree");
  for (const f of files) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), "export function f() {}\n");
  }
  return root;
}

describe("cccc invocation contract (spec 6.3)", () => {
  it("passes exactly --no-config --no-cache --lang es -j N -- <files>, from the tree root", async () => {
    const root = tree(["src/a.ts", "src/b.tsx"]);
    const policy = defaultPolicy({ measurer: { jobs: 3 } });
    await runCccc({ binary: fake, treeRoot: root, files: ["src/a.ts", "src/b.tsx"], policy, side: "C" });
    const [call] = calls();
    expect(call!.argv).toEqual(["--no-config", "--no-cache", "--lang", "es", "-j", "3", "--", "src/a.ts", "src/b.tsx"]);
    expect(call!.cwd).toBe(root);
  });

  it("runs with only PATH and a fresh, removed HOME in the environment", async () => {
    const root = tree(["a.ts"]);
    process.env.NYORORI_LEAK_CHECK = "secret";
    try {
      const policy = defaultPolicy();
      await runCccc({ binary: fake, treeRoot: root, files: ["a.ts"], policy, side: "C" });
      await runCccc({ binary: fake, treeRoot: root, files: ["a.ts"], policy, side: "C" });
    } finally {
      delete process.env.NYORORI_LEAK_CHECK;
    }
    const [first, second] = calls();
    expect(Object.keys(first!.env).sort()).toEqual(["HOME", "PATH"]);
    expect(first!.env.PATH).toBe("/usr/bin:/bin");
    expect(first!.env.HOME).toMatch(/nyorori-cccc-home-/);
    expect(first!.env.HOME).not.toBe(second!.env.HOME);
    expect(existsSync(first!.env.HOME!)).toBe(false);
  });

  it("chunks at policy.measurer.chunk_size and merges every chunk's report", async () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
    const root = tree(files);
    const policy = defaultPolicy({ measurer: { chunk_size: 2 } });
    const runs = await runCccc({ binary: fake, treeRoot: root, files, policy, side: "C" });
    expect(calls().map((c) => c.argv.slice(c.argv.indexOf("--") + 1))).toEqual([["a.ts", "b.ts"], ["c.ts", "d.ts"], ["e.ts"]]);
    expect(runs.map((r) => r.expectedPaths)).toEqual([["a.ts", "b.ts"], ["c.ts", "d.ts"], ["e.ts"]]);
    const merged = validateRuns(runs, policy);
    expect(merged.inconclusive).toEqual([]);
    expect(merged.files.map((f) => f.path)).toEqual(files);
  });

  it("validates each chunk on its own: a gap in one chunk is reported for that chunk", async () => {
    const root = tree(["a.ts", "b.ts", "c.ts"]);
    const policy = defaultPolicy({ measurer: { chunk_size: 2 } });
    const runs = await runCccc({ binary: fake, treeRoot: root, files: ["a.ts", "b.ts", "c.ts"], policy, side: "C" });
    runs[1] = { ...runs[1]!, stdout: Buffer.from(JSON.stringify({ files: [], summary: { file_count: 0 } })) };
    const merged = validateRuns(runs, policy);
    expect(merged.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(merged.inconclusive.map((i) => [i.reason, i.file ?? null])).toEqual([
      ["MANIFEST_MISMATCH", "c.ts"],
      ["MANIFEST_MISMATCH", null],
    ]);
  });
});

describe("measurer --version pin (spec 6.1)", () => {
  it("a binary reporting another version is MEASURER_MISMATCH even with a matching sha256", async () => {
    writeFake("cccc 1.9.0");
    const id = await identifyMeasurer(fake);
    expect(id.version).toBe("cccc 1.9.0");
    const policy = defaultPolicy({ measurer: { cccc_sha256: id.sha256 } });
    expect(checkMeasurer(id, policy).map((i) => [i.reason, i.detail])).toEqual([
      ["MEASURER_MISMATCH", 'measurer reports "cccc 1.9.0", policy pins "cccc 1.8.5"'],
    ]);
  });

  it("measureSides stops before running a mismatched measurer", async () => {
    writeFake("cccc 1.9.0");
    const repo = new TestRepo();
    try {
      const b = repo.commit({ "a.ts": "export const a = 1;\n" });
      const c = repo.commit({ "a.ts": "export const a = 2;\n" });
      const policy = defaultPolicy({ measurer: { allow_unpinned: true } });
      const m = await buildManifest(repo.dir, b, c, policy);
      const r = await measureSides({ repoDir: repo.dir, manifest: m, policy, binary: fake, workDir: join(dir, "work"), rng: () => 1 });
      expect(r.inconclusive.map((i) => i.reason)).toEqual(["MEASURER_MISMATCH"]);
      expect(r.runs).toEqual([]);
      expect(calls()).toEqual([]);
      expect(r.fingerprint.cccc_version).toBe("cccc 1.9.0");
    } finally {
      repo.dispose();
    }
  });
});
