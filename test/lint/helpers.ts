import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultPolicy, type Policy } from "../../src/policy/schema.js";
import { lintFiles } from "../../src/gates/lint/run.js";
import type { FileLintResult } from "../../src/gates/lint/types.js";

export function writeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "nyorori-lint-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

export async function lintSnippet(
  code: string,
  file = "src/x.ts",
  policy: Policy = defaultPolicy(),
): Promise<FileLintResult> {
  const root = writeTree({ [file]: code });
  const results = await lintFiles(root, [file], policy);
  return results.get(file)!;
}

/** `rule` or `rule:messageId` for every hit, in order. */
export function hitIds(r: FileLintResult): string[] {
  return r.messages.map((m) => (m.messageId && m.ruleId.startsWith("nyorori/") ? `${m.ruleId}:${m.messageId}` : m.ruleId));
}
