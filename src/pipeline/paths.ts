// Spec 10.2 V1/V4: the policy, the measurer, the outputs and the ledger must
// not live inside the repository being judged, or a candidate commit could
// supply them. Compared by realpath so symlinks cannot slip a path inside.

import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export class RepoPathError extends Error {
  constructor(
    readonly label: string,
    readonly path: string,
    readonly repoDir: string,
  ) {
    super(`${label} ${JSON.stringify(path)} is inside the measured repository ${JSON.stringify(repoDir)}; keep gate inputs and outputs outside it`);
    this.name = "RepoPathError";
  }
}

/** realpath of the deepest existing ancestor, so a not-yet-created --out is still placed. */
async function realpathOfExisting(p: string): Promise<string> {
  let cur = resolve(p);
  for (;;) {
    try {
      return await realpath(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = dirname(cur);
      if (parent === cur) return cur;
      cur = parent;
    }
  }
}

export function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function assertToolsOutsideRepo(repoDir: string, items: ReadonlyArray<{ label: string; path: string }>): Promise<void> {
  const root = await realpathOfExisting(repoDir);
  for (const it of items) {
    // A bare command name resolves through PATH, not the repository.
    if (!it.path.includes(sep) && !it.path.includes("/")) continue;
    if (isInside(await realpathOfExisting(it.path), root)) throw new RepoPathError(it.label, it.path, repoDir);
  }
}
