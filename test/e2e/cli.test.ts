// The built CLI as an adopter runs it: exit codes and the spec 9.2 artifacts.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CCCC, TestRepo, fnWithCogc, servicePolicy } from "./helpers.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const CLI = join(ROOT, "dist/cli.js");

function nyorori(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env, NYORORI_CCCC: CCCC } });
}

describe("nyorori CLI", () => {
  let dir: string;
  let policyFile: string;
  beforeAll(() => {
    execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: ROOT, stdio: "inherit" });
    dir = mkdtempSync(join(tmpdir(), "nyorori-cli-"));
    policyFile = join(dir, "policy.json");
    const { revision: _r, ...p } = servicePolicy();
    writeFileSync(policyFile, JSON.stringify(p));
    return () => rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("exits 0/1/2 for PASS/FAIL/INCONCLUSIVE and writes the run artifacts", () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const pass = repo.commit({ "src/a.js": fnWithCogc("a", 15) });
    const fail = repo.commit({ "src/a.js": fnWithCogc("a", 16) });
    const broken = repo.commit({ "src/a.js": "function broken( {\n" });
    const base = ["run", "--repo", repo.dir, "--base", b, "--policy", policyFile];

    expect(nyorori([...base, "--candidate", pass]).status).toBe(0);

    const out = join(dir, "out");
    const r = nyorori([...base, "--candidate", fail, "--out", out]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("quality-gate: FAIL");
    // B has no code, so cccc only ran on C.
    for (const f of ["manifest.json", "raw.C.json", "raw.C.stderr", "gate-result.complexity.json", "quality-gate.json", "gate-summary.md", "gate-feedback.json"]) {
      expect(existsSync(join(out, f)), f).toBe(true);
    }
    expect(readdirSync(out).filter((f) => f.startsWith("gate-result.")).length).toBe(7);
    const verdict = JSON.parse(readFileSync(join(out, "quality-gate.json"), "utf8"));
    expect(verdict.state).toBe("FAIL");

    expect(nyorori([...base, "--candidate", broken]).status).toBe(2);
    repo.dispose();
  });

  it("refuses gate inputs inside the judged repository (64) unless --allow-repo-paths, and stamps authority local", () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ "src/a.js": fnWithCogc("a", 3), "gate/policy.json": readFileSync(policyFile, "utf8") });
    const inside = join(repo.dir, "gate", "policy.json");
    const base = ["run", "--repo", repo.dir, "--base", b, "--candidate", c];
    const refused = nyorori([...base, "--policy", inside]);
    expect(refused.status).toBe(64);
    expect(refused.stderr).toMatch(/inside the measured repository/);
    expect(nyorori([...base, "--policy", policyFile, "--out", join(repo.dir, "out")]).status).toBe(64);

    const out = join(dir, "out-authority");
    expect(nyorori([...base, "--policy", inside, "--allow-repo-paths", "--out", out]).status).toBe(0);
    const verdict = JSON.parse(readFileSync(join(out, "quality-gate.json"), "utf8"));
    expect(verdict.authority).toBe("local");
    expect(readFileSync(join(out, "gate-summary.md"), "utf8").split("\n")[0]).toContain("authority: local");
    // The debugging path gives the same verdict without the worker.
    expect(nyorori([...base, "--policy", policyFile, "--in-process"]).status).toBe(0);
    repo.dispose();
  });

  it("uses exit 64 for usage errors and 2 when the gate cannot run", () => {
    expect(nyorori(["run", "--repo", "/nonexistent"]).status).toBe(64);
    expect(nyorori(["nope"]).status).toBe(64);
    expect(nyorori(["run", "--repo", "/nonexistent", "--base", "HEAD", "--candidate", "HEAD", "--policy", policyFile]).status).toBe(2);
  });

  it("checks the calculation-rule fixtures against the binary", () => {
    const r = nyorori(["fixtures"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/0 drift\(s\)/);
  });
});
