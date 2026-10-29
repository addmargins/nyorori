import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RepoPathError, assertToolsOutsideRepo, isInside } from "../../src/pipeline/paths.js";

describe("gate inputs must live outside the judged repository (spec 10.2)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nyorori-paths-"));
    mkdirSync(join(root, "repo", "tools"), { recursive: true });
    mkdirSync(join(root, "elsewhere"), { recursive: true });
    writeFileSync(join(root, "repo", "tools", "policy.json"), "{}");
    writeFileSync(join(root, "elsewhere", "policy.json"), "{}");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("refuses a path inside the repository and accepts one beside it", async () => {
    const repo = join(root, "repo");
    await expect(assertToolsOutsideRepo(repo, [{ label: "policy", path: join(repo, "tools", "policy.json") }])).rejects.toBeInstanceOf(RepoPathError);
    await expect(assertToolsOutsideRepo(repo, [{ label: "policy", path: join(root, "elsewhere", "policy.json") }])).resolves.toBeUndefined();
    // A sibling whose name merely starts with the repository's name is outside.
    mkdirSync(join(root, "repo-out"));
    await expect(assertToolsOutsideRepo(repo, [{ label: "--out", path: join(root, "repo-out") }])).resolves.toBeUndefined();
  });

  it("follows symlinks, so a link from outside into the repository is still inside", async () => {
    const repo = join(root, "repo");
    symlinkSync(join(repo, "tools", "policy.json"), join(root, "elsewhere", "link.json"));
    await expect(assertToolsOutsideRepo(repo, [{ label: "policy", path: join(root, "elsewhere", "link.json") }])).rejects.toThrow(/inside the measured repository/);
  });

  it("places a not-yet-created output by its nearest existing ancestor", async () => {
    const repo = join(root, "repo");
    await expect(assertToolsOutsideRepo(repo, [{ label: "--out", path: join(repo, "gate-out", "deep") }])).rejects.toBeInstanceOf(RepoPathError);
    await expect(assertToolsOutsideRepo(repo, [{ label: "--out", path: join(root, "elsewhere", "gate-out", "deep") }])).resolves.toBeUndefined();
  });

  it("lets a bare command name resolve through PATH", async () => {
    await expect(assertToolsOutsideRepo(join(root, "repo"), [{ label: "cccc binary", path: "cccc" }])).resolves.toBeUndefined();
  });

  it("isInside treats the root itself as inside", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b/c", "/a/b")).toBe(true);
    expect(isInside("/a/bc", "/a/b")).toBe(false);
    expect(isInside("/a", "/a/b")).toBe(false);
  });
});
