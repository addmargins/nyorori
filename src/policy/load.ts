// Loads policy P from the trusted gate repository. JSON only: a policy that
// could execute code (JS, YAML tags) would let whoever edits it run code in
// the gate service, so other formats are refused outright.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parsePolicy, type Policy } from "./schema.js";

export interface LoadedPolicy {
  policy: Policy;
  /** Gate-repo commit when the caller supplies it, otherwise sha256 of the canonical JSON. */
  revision: string;
}

/** JSON with object keys sorted recursively, so equal content hashes equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function policyDigest(policy: Policy): string {
  const { revision: _ignored, ...rest } = policy;
  return `sha256:${createHash("sha256").update(canonicalJson(rest)).digest("hex")}`;
}

export function loadPolicyFromText(text: string, opts: { revision?: string } = {}): LoadedPolicy {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`policy is not valid JSON: ${(e as Error).message}`, { cause: e });
  }
  const parsed = parsePolicy(raw);
  const revision = opts.revision ?? policyDigest(parsed);
  return { policy: { ...parsed, revision }, revision };
}

export async function loadPolicy(path: string, opts: { revision?: string } = {}): Promise<LoadedPolicy> {
  if (!path.endsWith(".json")) {
    throw new Error(`policy must be a .json file (got ${path}); executable formats are not accepted`);
  }
  return loadPolicyFromText(await readFile(path, "utf8"), opts);
}
