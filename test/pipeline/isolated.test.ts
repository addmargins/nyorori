// The parent's contract with the analysis worker: a hung, crashing or
// oversized child becomes INCONCLUSIVE(TOOL_ERROR) on every service gate and
// one aggregated verdict, never a missing check (spec 9.1, 10.1).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { failedRunOutput, isolationFromEnv, runGatesIsolated, workerArgv } from "../../src/pipeline/isolated.js";
import type { RunGatesOptions } from "../../src/pipeline/types.js";
import { defaultPolicy } from "../../src/policy/schema.js";
import { TestRepo } from "../git/repo.js";

const SERVICE_GATES = ["complexity", "lint-structure", "deps", "tests", "coverage", "mutation"];

describe("runGatesIsolated failure modes", () => {
  let dir: string;
  let repo: TestRepo;
  let opts: RunGatesOptions;
  const fake = (name: string, body: string) => {
    const p = join(dir, `${name}.mjs`);
    writeFileSync(p, body);
    return p;
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "nyorori-isolated-"));
    repo = new TestRepo();
    const b = repo.commit({ "src/a.js": "export const a = 1;\n" });
    const c = repo.commit({ "src/a.js": "export const a = 2;\n" });
    opts = {
      repoDir: repo.dir,
      base: b,
      candidate: c,
      policy: defaultPolicy({ measurer: { allow_unpinned: true } }),
      policyRevision: "p",
      ccccBinary: "cccc",
      workDir: join(dir, "work"),
      runnerCommit: "r",
      authority: "github-app",
    };
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    repo.dispose();
  });

  function expectAllToolError(out: Awaited<ReturnType<typeof runGatesIsolated>>, detail: RegExp) {
    expect(out.results.filter((r) => SERVICE_GATES.includes(r.gate)).map((r) => r.state)).toEqual(SERVICE_GATES.map(() => "INCONCLUSIVE"));
    for (const r of out.results) {
      if (!SERVICE_GATES.includes(r.gate)) continue;
      expect(r.inconclusive).toHaveLength(1);
      expect(r.inconclusive[0]).toMatchObject({ reason: "TOOL_ERROR", authorFixable: false });
      expect(r.inconclusive[0]!.detail).toMatch(detail);
    }
    expect(out.verdict.state).toBe("INCONCLUSIVE");
    expect(out.verdict.mergeAllowed).toBe(false);
    expect(out.verdict.authority).toBe("github-app");
    expect(out.checkRun.conclusion).toBe("failure");
    expect(out.checkRun.title).toMatch(/^INCONCLUSIVE/);
    expect(out.summaryMarkdown).toContain("authority: github-app");
  }

  it("a worker that exceeds the wall timer is killed and reported", async () => {
    const hang = fake("hang", "setInterval(() => {}, 1000);\n");
    const started = Date.now();
    const out = await runGatesIsolated(opts, { workerModule: hang, timeoutMs: 1500 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expectAllToolError(out, /exceeded 1500 ms/);
  });

  it("a worker that exits non-zero is reported with its last stderr lines", async () => {
    const crash = fake("crash", 'process.stderr.write("boom: out of memory\\n"); process.exit(3);\n');
    const out = await runGatesIsolated(opts, { workerModule: crash });
    expectAllToolError(out, /exit 3.*boom: out of memory/);
  });

  it("a worker whose output exceeds the cap is cut off", async () => {
    const flood = fake("flood", 'process.stdout.write("x".repeat(200_000)); process.stdout.write("y".repeat(200_000), () => process.exit(0));\n');
    const out = await runGatesIsolated(opts, { workerModule: flood, maxOutputBytes: 100_000 });
    expectAllToolError(out, /worker output too large/);
  });

  it("a worker that returns garbage is reported, not trusted", async () => {
    const garbage = fake("garbage", 'process.stdout.write("not json", () => process.exit(0));\n');
    const out = await runGatesIsolated(opts, { workerModule: garbage });
    expectAllToolError(out, /no readable result/);
  });

  it("a workerCommand prefix wraps `node <module>` and keeps the protocol intact", async () => {
    const record = join(dir, "argv.txt");
    const prefix = join(dir, "prefix.sh");
    // Records argv (marker included) the way a `docker run` prefix would see it, drops the marker, runs the real command.
    writeFileSync(prefix, `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\nshift\nexec "$@"\n`, { mode: 0o755 });
    const real = new URL("../../dist/pipeline/worker.js", import.meta.url).pathname;
    // No workflow artifact here, so the artifact gates are observed; the point is the prefix, not G4.
    const policy = defaultPolicy({ measurer: { allow_unpinned: true }, tests: { mode: "observe" }, coverage: { mode: "observe" } });
    const out = await runGatesIsolated(
      { ...opts, policy, ccccBinary: process.env.NYORORI_CCCC ?? "/home/user/moznion/cccc/target/release/cccc" },
      { workerCommand: [prefix, "--flag"], workerModule: real },
    );
    const argv = readFileSync(record, "utf8").trim().split("\n");
    expect(argv.slice(0, 2)).toEqual(["--flag", "node"]);
    expect(argv[2]).toMatch(/^--max-old-space-size=\d+$/);
    expect(argv[3]).toBe(real);
    expect(out.verdict.state).toBe("PASS");
    expect(out.verdict.authority).toBe("github-app");
  });

  it("a prefix that never starts the worker is killed by the wall timer", async () => {
    const stuck = join(dir, "stuck.sh");
    writeFileSync(stuck, "#!/bin/sh\nsleep 600\n", { mode: 0o755 });
    const started = Date.now();
    const out = await runGatesIsolated(opts, { workerCommand: [stuck], timeoutMs: 1500 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expectAllToolError(out, /exceeded 1500 ms/);
  });

  it("isolationFromEnv parses the JSON prefix and rejects a malformed one", () => {
    expect(isolationFromEnv({})).toEqual({});
    expect(isolationFromEnv({ NYORORI_WORKER_COMMAND: '["docker","run","--rm","-i","img"]', NYORORI_WORKER_TIMEOUT_MS: "120000" })).toEqual({
      workerCommand: ["docker", "run", "--rm", "-i", "img"],
      timeoutMs: 120_000,
    });
    expect(() => isolationFromEnv({ NYORORI_WORKER_COMMAND: "docker run" })).toThrow(/JSON array/);
    expect(() => isolationFromEnv({ NYORORI_WORKER_COMMAND: "[]" })).toThrow(/non-empty/);
    expect(() => isolationFromEnv({ NYORORI_WORKER_TIMEOUT_MS: "soon" })).toThrow(/positive integer/);
    expect(workerArgv({ maxOldSpaceMb: 512, workerModule: "/w.js", workerCommand: ["bwrap", "--ro-bind", "/", "/"] })).toEqual([
      "bwrap", "--ro-bind", "/", "/", "node", "--max-old-space-size=512", "/w.js",
    ]);
  });

  it("the fallback verdict resolves revisions and keeps the authority", async () => {
    const out = await failedRunOutput({ ...opts, base: "HEAD~1", candidate: "HEAD", authority: "local" }, "x");
    expect(out.verdict.base_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(out.verdict.candidate_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(out.authority).toBe("local");
    expect(out.summaryMarkdown).toContain("authority: local");
    expect(out.pendingWaivers).toEqual([]);
  });
});
