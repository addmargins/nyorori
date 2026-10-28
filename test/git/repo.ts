// Throwaway git repositories for integration tests.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type FileSpec = string | Buffer | { symlink: string } | { gitlink: string } | null;

export class TestRepo {
  readonly dir: string;
  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "nyorori-repo-"));
    this.git("init", "-q", "-b", "main");
  }
  git(...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
      cwd: this.dir,
      env: { PATH: process.env.PATH, HOME: this.dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    }).toString();
  }
  /** Applies the files (null deletes) and commits; returns the commit sha. */
  commit(files: Record<string, FileSpec>, message = "c"): string {
    for (const [path, spec] of Object.entries(files)) {
      const abs = join(this.dir, path);
      if (spec === null) {
        this.git("rm", "-q", "--cached", "--ignore-unmatch", "--", path);
        if (existsSync(abs)) rmSync(abs, { recursive: true, force: true });
        continue;
      }
      mkdirSync(dirname(abs), { recursive: true });
      if (existsSync(abs)) unlinkSync(abs);
      if (typeof spec === "object" && !Buffer.isBuffer(spec) && "gitlink" in spec) {
        this.git("update-index", "--add", "--cacheinfo", `160000,${spec.gitlink},${path}`);
        continue;
      }
      if (typeof spec === "object" && !Buffer.isBuffer(spec) && "symlink" in spec) symlinkSync(spec.symlink, abs);
      else writeFileSync(abs, spec as string | Buffer);
      this.git("add", "-f", "--", path);
    }
    this.git("commit", "-q", "--allow-empty", "-m", message);
    return this.git("rev-parse", "HEAD").trim();
  }
  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
