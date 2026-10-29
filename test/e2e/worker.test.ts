// The production path end to end: the gates run in the detached worker from
// the build output, with a zipped artifact the worker (not the parent) opens.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestRepo, fnWithCogc, gate, runViaWorker, servicePolicy, testPolicy } from "./helpers.js";
import { buildZip } from "./zip.js";

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
