import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { defaultPolicy } from "../../src/policy/schema.js";
import { canonicalJson, loadPolicy, loadPolicyFromText } from "../../src/policy/load.js";

describe("policy loading", () => {
  it("default.policy.json equals the schema defaults", () => {
    const { policy } = loadPolicyFromText(readFileSync("policy/default.policy.json", "utf8"), { revision: "x" });
    expect({ ...policy, revision: "x" }).toEqual({ ...defaultPolicy(), revision: "x" });
  });

  it("strict example parses", async () => {
    const { policy, revision } = await loadPolicy("policy/example.strict.policy.json");
    expect(policy.complexity.cognitive_limit).toBe(12);
    expect(revision).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(policy.revision).toBe(revision);
  });

  it("revision is independent of key order and uses the caller's commit when given", () => {
    const a = loadPolicyFromText('{"schema_version":1,"complexity":{"cognitive_limit":12,"mode":"observe"}}');
    const b = loadPolicyFromText('{"complexity":{"mode":"observe","cognitive_limit":12},"schema_version":1}');
    expect(a.revision).toBe(b.revision);
    expect(loadPolicyFromText('{"schema_version":1}', { revision: "abc123" }).revision).toBe("abc123");
  });

  it("rejects executable formats, invalid JSON and unknown keys", async () => {
    await expect(loadPolicy("policy.js")).rejects.toThrow(/\.json/);
    expect(() => loadPolicyFromText("{nope")).toThrow(/not valid JSON/);
    expect(() => loadPolicyFromText('{"schema_version":1,"complexity":{"cogc":3}}')).toThrow();
  });

  it("canonicalJson sorts keys recursively", () => {
    expect(canonicalJson({ b: [{ d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[{"c":2,"d":1}]}');
  });
});
