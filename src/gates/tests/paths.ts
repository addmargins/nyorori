// Test runners and coverage providers report absolute paths from the
// untrusted runner's checkout. Map them back to repository-relative paths.

import { posix } from "node:path";

export interface PathResolveOptions {
  /** Absolute checkout root on the runner, when the artifact metadata records it. */
  rootDir?: string;
  /** Repository-relative paths known to exist in the candidate tree. */
  knownFiles?: Iterable<string>;
}

export type PathResolution =
  | { ok: true; path: string }
  | { ok: false; raw: string; detail: string };

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export function createPathResolver(opts: PathResolveOptions): (raw: string) => PathResolution {
  const known = [...(opts.knownFiles ?? [])].map(toPosix);
  const knownSet = new Set(known);
  const root = opts.rootDir ? toPosix(opts.rootDir).replace(/\/+$/, "") + "/" : undefined;
  return (rawInput: string) => {
    const raw = toPosix(rawInput).replace(/^file:\/\//, "");
    if (root && raw.startsWith(root)) return { ok: true, path: posix.normalize(raw.slice(root.length)) };
    if (!raw.startsWith("/")) {
      const rel = posix.normalize(raw.replace(/^\.\//, ""));
      if (rel.startsWith("../")) return { ok: false, raw, detail: "path escapes the repository" };
      return { ok: true, path: rel };
    }
    if (knownSet.size === 0) return { ok: false, raw, detail: "absolute path and no rootDir or known files" };
    // Longest repository path that is a suffix on a segment boundary.
    const hits = known.filter((k) => raw.endsWith("/" + k));
    if (hits.length === 0) return { ok: false, raw, detail: "absolute path matches no candidate file" };
    hits.sort((a, b) => b.length - a.length);
    if (hits.length > 1 && hits[0]!.length === hits[1]!.length) {
      return { ok: false, raw, detail: `ambiguous: ${hits.slice(0, 3).join(", ")}` };
    }
    return { ok: true, path: hits[0]! };
  };
}
