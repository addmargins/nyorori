// Where a specifier lands in the repository, independent of the resolver
// that built the graph. Used to find imports of files the gate does not
// measure (S11, audit F6 / security review #4): Node resolves package.json
// `imports` (#subpath), self-references by package name through `exports`,
// tsconfig aliases and baseUrl into the repo, and CommonJS `require()` runs
// any unknown extension — or a file literally named `x?raw` — as JavaScript.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { AliasSpec } from "./aliases.js";
import { CODE_EXTENSIONS } from "./graph.js";

export interface PackageInfo {
  /** Tree-relative directory of the package.json ("" for the root). */
  dir: string;
  name?: string;
  imports?: unknown;
  exports?: unknown;
}

const MAX_PACKAGES = 2000;

/** Every package.json in a tree (node_modules excluded), read as data. */
export function readPackages(treeRoot: string): PackageInfo[] {
  const out: PackageInfo[] = [];
  const walk = (rel: string) => {
    if (out.length >= MAX_PACKAGES) return;
    const abs = join(treeRoot, rel);
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && e.name !== "node_modules" && e.name !== ".git") walk(rel ? `${rel}/${e.name}` : e.name);
      else if (e.isFile() && e.name === "package.json") {
        const info = parsePackage(readFileSync(join(abs, e.name), "utf8"), rel);
        if (info) out.push(info);
      }
    }
  };
  if (existsSync(treeRoot)) walk("");
  return out;
}

export function parsePackage(text: string, dir: string): PackageInfo | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const j = json as Record<string, unknown>;
  return {
    dir,
    ...(typeof j.name === "string" ? { name: j.name } : {}),
    ...(j.imports !== undefined ? { imports: j.imports } : {}),
    ...(j.exports !== undefined ? { exports: j.exports } : {}),
  };
}

/** Every string target of an exports/imports value, across all conditions. */
function targetsOf(value: unknown, depth = 0): string[] {
  if (depth > 8) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((v) => targetsOf(v, depth + 1));
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap((v) => targetsOf(v, depth + 1));
  return [];
}

/** Node's subpath pattern matching (one `*`), returning substituted targets. */
export function matchSubpath(map: unknown, key: string): string[] {
  if (typeof map !== "object" || map === null || Array.isArray(map)) return key === "." ? targetsOf(map) : [];
  const entries = Object.entries(map as Record<string, unknown>);
  // A conditions object at the top of `exports` is the "." entry.
  if (entries.length > 0 && entries.every(([k]) => !k.startsWith(".") && !k.startsWith("#"))) {
    return key === "." ? targetsOf(map) : [];
  }
  const out: string[] = [];
  for (const [pattern, value] of entries) {
    const star = pattern.indexOf("*");
    if (star === -1) {
      if (pattern === key) out.push(...targetsOf(value));
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (key.length < prefix.length + suffix.length || !key.startsWith(prefix) || !key.endsWith(suffix)) continue;
    const hole = key.slice(prefix.length, key.length - suffix.length);
    out.push(...targetsOf(value).map((t) => t.split("*").join(hole)));
  }
  return out;
}

export interface TargetContext {
  /** Packages of B and C: C's map is what runs, B's is what reviewers trusted; both are checked. */
  packages: readonly PackageInfo[];
  aliases?: AliasSpec;
  /** Every path in the C tree, when known. */
  allFiles: ReadonlySet<string> | null;
  /** First path segments under baseUrl (files and directories). */
  baseUrlEntries: ReadonlySet<string>;
}

export interface Candidate {
  path: string;
  /** How sure we are the specifier means this repository path. */
  via: "relative" | "imports" | "self" | "alias" | "baseUrl";
}

function inPackage(file: string, pkg: PackageInfo): boolean {
  return pkg.dir === "" || file === pkg.dir || file.startsWith(`${pkg.dir}/`);
}

function nearestPackages(from: string, packages: readonly PackageInfo[]): PackageInfo[] {
  const owning = packages.filter((p) => inPackage(from, p));
  const deepest = Math.max(-1, ...owning.map((p) => (p.dir === "" ? 0 : p.dir.split("/").length)));
  return owning.filter((p) => (p.dir === "" ? 0 : p.dir.split("/").length) === deepest);
}

function inTree(p: string): string | null {
  const n = posix.normalize(p);
  return n.startsWith("../") || n === ".." || posix.isAbsolute(n) ? null : n.replace(/^\.\//, "");
}

/** Repository paths a specifier may load, by every resolution Node or a bundler applies. */
export function candidateTargets(from: string, specifier: string, ctx: TargetContext): Candidate[] {
  const out: Candidate[] = [];
  const push = (p: string | null, via: Candidate["via"]) => {
    if (p !== null && !out.some((c) => c.path === p)) out.push({ path: p, via });
  };
  if (/^\.{1,2}\//.test(specifier)) {
    push(inTree(posix.join(posix.dirname(from), specifier)), "relative");
    return out;
  }
  if (specifier.startsWith("#")) {
    for (const pkg of nearestPackages(from, ctx.packages)) {
      for (const t of matchSubpath(pkg.imports, specifier)) {
        if (t.startsWith("./")) push(inTree(posix.join(pkg.dir, t)), "imports");
      }
    }
  }
  for (const pkg of ctx.packages) {
    if (!pkg.name || !inPackage(from, pkg)) continue;
    if (specifier !== pkg.name && !specifier.startsWith(`${pkg.name}/`)) continue;
    const sub = specifier === pkg.name ? "." : `./${specifier.slice(pkg.name.length + 1)}`;
    for (const t of matchSubpath(pkg.exports, sub)) {
      if (t.startsWith("./")) push(inTree(posix.join(pkg.dir, t)), "self");
    }
  }
  const aliases = ctx.aliases;
  if (aliases) {
    for (const [key, target] of Object.entries(aliases.aliases)) {
      if (key.endsWith("$")) {
        if (specifier === key.slice(0, -1)) push(inTree(target), "alias");
      } else if (specifier === key || specifier.startsWith(`${key}/`)) {
        push(inTree(posix.join(target, specifier.slice(key.length))), "alias");
      }
    }
    if (aliases.baseUrl !== null && ctx.baseUrlEntries.has(specifier.split("/")[0]!)) {
      push(inTree(posix.join(aliases.baseUrl, specifier)), "baseUrl");
    }
  }
  return out;
}

/**
 * Data and asset formats that bundlers load as data. Anything else outside
 * the code extensions (.txt, .md, .html, .node, .wasm, extensionless) is
 * code the gate cannot measure.
 */
export const DATA_EXTENSIONS: ReadonlySet<string> = new Set([
  ".json", ".jsonc", ".json5", ".css", ".scss", ".sass", ".less", ".styl", ".pcss", ".postcss",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp", ".tif", ".tiff",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".mp4", ".webm", ".wav", ".ogg", ".m4a", ".mov",
  ".graphql", ".gql", ".yaml", ".yml", ".toml", ".csv", ".tsv",
]);
/** Bundler queries that import a file as a string or URL, never as code. */
const DATA_QUERY_RE = /[?&](raw|url|inline)\b/;

export type Verdict = { unmeasured: true; reason: string } | { unmeasured: false };

function byExtension(path: string): Verdict {
  const ext = posix.extname(path).toLowerCase();
  if (ext === "") return { unmeasured: false };
  if (CODE_EXTENSIONS.includes(ext) || DATA_EXTENSIONS.has(ext)) return { unmeasured: false };
  return { unmeasured: true, reason: ext };
}

/**
 * Classifies one candidate. A file that exists literally wins over any
 * reading of `?`/`#` as a query: CommonJS has no query syntax, so
 * `require("./x?raw")` runs a file named `x?raw`.
 */
export function classifyTarget(c: Candidate, allFiles: ReadonlySet<string> | null): Verdict {
  if (allFiles?.has(c.path)) {
    const base = posix.basename(c.path);
    if (/[?#]/.test(base)) return { unmeasured: true, reason: "file name contains ? or #" };
    const v = byExtension(c.path);
    if (v.unmeasured) return v;
    return posix.extname(c.path) === "" ? { unmeasured: true, reason: "no extension" } : { unmeasured: false };
  }
  // Not a literal file: a query or hash is the bundler's, applied to the path before it.
  const [bare] = c.path.split(/[?#]/);
  if (c.path !== bare && DATA_QUERY_RE.test(c.path.slice(bare!.length))) return { unmeasured: false };
  // Without a file listing, only internal-by-construction candidates are judged by extension.
  if (c.via === "baseUrl" && !allFiles) return { unmeasured: false };
  if (allFiles && !allFiles.has(bare!) && c.via !== "relative") return { unmeasured: false };
  return byExtension(bare!);
}
