// Replay dataset validation: full SHAs, bounded size, unique ids, and every
// path outside the repository under test.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DatasetError, loadDataset, parseDataset, MAX_PAIRS } from "../../src/replay/dataset.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const valid = { schema_version: 1, repository: "org/app", pairs: [{ id: "PR-1", base: A, candidate: B }] };

describe("replay dataset schema", () => {
  it("accepts a minimal dataset and optional per-pair inputs", () => {
    expect(parseDataset(valid).pairs[0]!.id).toBe("PR-1");
    const full = { ...valid, pairs: [{ ...valid.pairs[0], pr: "pr/1.json", comments: "c/1.json", artifacts: "art/1", previous_attempt: "c".repeat(40) }] };
    expect(parseDataset(full).pairs[0]!.artifacts).toBe("art/1");
  });

  it.each([
    ["short sha", { ...valid, pairs: [{ id: "x", base: A.slice(0, 7), candidate: B }] }],
    ["uppercase sha", { ...valid, pairs: [{ id: "x", base: A.toUpperCase(), candidate: B }] }],
    ["a ref instead of a sha", { ...valid, pairs: [{ id: "x", base: "main", candidate: B }] }],
    ["base equal to candidate", { ...valid, pairs: [{ id: "x", base: A, candidate: A }] }],
    ["unsafe id", { ...valid, pairs: [{ id: "../x", base: A, candidate: B }] }],
    ["duplicate ids", { ...valid, pairs: [valid.pairs[0], valid.pairs[0]] }],
    ["unknown field", { ...valid, pairs: [{ ...valid.pairs[0], command: "rm" }] }],
    ["wrong schema_version", { ...valid, schema_version: 2 }],
    ["no pairs", { ...valid, pairs: [] }],
    ["more than MAX_PAIRS", { ...valid, pairs: Array.from({ length: MAX_PAIRS + 1 }, (_, i) => ({ id: `p${i}`, base: A, candidate: B })) }],
  ])("rejects %s", (_name, raw) => {
    expect(() => parseDataset(raw)).toThrow(DatasetError);
  });
});

describe("replay dataset paths", () => {
  const root = mkdtempSync(join(tmpdir(), "nyorori-replay-ds-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "inside"), { recursive: true });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const read = async (p: string) => (await import("node:fs/promises")).readFile(p, "utf8");

  it("resolves pair paths relative to the dataset file", async () => {
    mkdirSync(join(root, "data", "art", "1"), { recursive: true });
    const file = join(root, "data", "pairs.json");
    writeFileSync(file, JSON.stringify({ ...valid, pairs: [{ ...valid.pairs[0], artifacts: "art/1" }] }));
    const loaded = await loadDataset(file, repo, read);
    expect(loaded.pairs[0]!.artifacts).toBe(join(root, "data", "art", "1"));
  });

  it("refuses a pair path that resolves inside the repository", async () => {
    const file = join(root, "data", "pairs-inside.json");
    writeFileSync(file, JSON.stringify({ ...valid, pairs: [{ ...valid.pairs[0], artifacts: "../repo/inside" }] }));
    await expect(loadDataset(file, repo, read)).rejects.toThrow(/inside the repository/);
  });

  it("refuses a dataset file inside the repository", async () => {
    const file = join(repo, "inside", "pairs.json");
    writeFileSync(file, JSON.stringify(valid));
    await expect(loadDataset(file, repo, read)).rejects.toThrow(/inside the repository/);
  });

  it("reports invalid JSON and a missing file as dataset errors", async () => {
    const file = join(root, "data", "bad.json");
    writeFileSync(file, "{");
    await expect(loadDataset(file, repo, read)).rejects.toThrow(DatasetError);
    await expect(loadDataset(join(root, "data", "missing.json"), repo, read)).rejects.toThrow(DatasetError);
  });
});
