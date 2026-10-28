// The production path end to end: the gates run in the detached worker from
// the build output, with a zipped artifact the worker (not the parent) opens.

import { deflateRawSync } from "node:zlib";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestRepo, fnWithCogc, gate, runViaWorker, servicePolicy, testPolicy } from "./helpers.js";

/** A small ZIP with stored or deflated entries, built by hand (the gate's reader is the thing under test). */
export function buildZip(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const comp = e.deflate ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(e.deflate ? 8 : 0, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.deflate ? 8 : 0, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, comp);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const report = JSON.stringify({
  numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true,
  testResults: [{ name: "src/a.test.js", status: "passed", assertionResults: [{ ancestorTitles: [], title: "a", fullName: "a", status: "passed" }] }],
});
const wf = { repository: "org/gate", path: ".github/workflows/gate-untrusted-tests.yml", shas: ["a".repeat(40)] };

describe("isolated worker end to end", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "nyorori-zip-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("a FAIL verdict comes back intact through the worker, marked with the service's authority", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ "src/a.js": fnWithCogc("a", 16) });
    const out = await runViaWorker(repo, b, c, servicePolicy(), { authority: "github-app" });
    expect(gate(out, "complexity").violations.map((v) => v.reason)).toEqual(["OVER_LIMIT_NEW"]);
    expect(out.verdict.state).toBe("FAIL");
    expect(out.verdict.authority).toBe("github-app");
    expect(out.ccccRuns.length).toBeGreaterThan(0);
    expect(Buffer.isBuffer(out.ccccRuns[0]!.stdout)).toBe(true);
    expect(out.summaryMarkdown).toContain("authority: github-app");
    repo.dispose();
  });

  it("the worker opens the artifact zip; a hostile archive blocks only through UNTRUSTED_ARTIFACT", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c = repo.commit({ "src/a.js": fnWithCogc("a", 3), "src/a.test.js": "import { it, expect } from 'vitest';\nit('a', () => { expect(1).toBe(1); });\n" });
    const provenance = { repository: wf.repository, workflowPath: wf.path, workflowSha: wf.shas[0]!, runId: 1, runAttempt: 1, headSha: c, event: "merge_group" };
    const policy = testPolicy({ coverage: { mode: "observe" }, provenance: { trusted_workflows: [wf] } });

    const good = join(dir, "good.zip");
    writeFileSync(good, buildZip([{ name: "tests.C.json", data: Buffer.from(report), deflate: true }, { name: "metadata.json", data: Buffer.from("{}") }]));
    const ok = await runViaWorker(repo, b, c, policy, { artifactZip: { path: good, provenance } });
    expect(gate(ok, "tests").state).toBe("PASS");
    expect(ok.verdict.state).toBe("PASS");

    const bad = join(dir, "bad.zip");
    writeFileSync(bad, Buffer.from("PK\u0003\u0004 definitely not a zip"));
    const rejected = await runViaWorker(repo, b, c, policy, { artifactZip: { path: bad, provenance } });
    expect(rejected.verdict.reasons).toContain("UNTRUSTED_ARTIFACT");
    expect(rejected.verdict.mergeAllowed).toBe(false);
    // The archive problem never costs the service gates their result.
    expect(gate(rejected, "complexity").state).toBe("PASS");
    repo.dispose();
  });
});
