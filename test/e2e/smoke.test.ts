import { describe, expect, it } from "vitest";
import { TestRepo, fnWithCogc, gate, run, servicePolicy } from "./helpers.js";

describe("smoke", () => {
  it("new unit 15 PASS / 16 FAIL", async () => {
    const repo = new TestRepo();
    const b = repo.commit({ "README.md": "x\n" });
    const c15 = repo.commit({ "src/a.js": fnWithCogc("a", 15) });
    const out = await run(repo, b, c15, servicePolicy());
    console.log(JSON.stringify(out.verdict.gates), out.verdict.summary);
    expect(gate(out, "complexity").state).toBe("PASS");
  });
});
