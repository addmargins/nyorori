import { defaultPolicy, type PolicyInput } from "../../src/policy/schema.js";
import type { ChangeStatus, Manifest, ManifestEntry } from "../../src/types.js";

export function entry(status: ChangeStatus, pathB: string | null, pathC: string | null, extra: Partial<ManifestEntry> = {}): ManifestEntry {
  const side = (p: string | null) => (p ? { path: p, blob: "0".repeat(40), mode: "100644", measuredPath: p } : null);
  return {
    status,
    b: side(pathB),
    c: side(pathC),
    measure: { B: pathB !== null && status !== "A", C: pathC !== null && status !== "D" },
    ...extra,
  };
}

export function manifest(entries: ManifestEntry[]): Manifest {
  return { baseSha: "b".repeat(40), candidateSha: "c".repeat(40), entries, problems: [], sensitivePathsChanged: [] };
}

export function policy(overrides: Partial<PolicyInput> = {}) {
  return defaultPolicy(overrides);
}

interface T {
  file: string;
  ancestors?: string[];
  title: string;
  status?: "passed" | "failed" | "skipped" | "pending" | "todo";
}

/** A report in the exact shape vitest 4.1 `--reporter=json` writes (see fixtures/vitest-4.1-report.json). */
export function jestReport(tests: T[], extra: Record<string, unknown> = {}): string {
  const files = [...new Set(tests.map((t) => t.file))];
  const numFailed = tests.filter((t) => t.status === "failed").length;
  return JSON.stringify({
    numTotalTests: tests.length,
    numFailedTests: numFailed,
    numPassedTests: tests.filter((t) => (t.status ?? "passed") === "passed").length,
    success: numFailed === 0,
    snapshot: { added: 0, updated: 0, filesUpdated: 0, didUpdate: false },
    testResults: files.map((f) => ({
      name: `/home/runner/work/app/app/${f}`,
      status: tests.some((t) => t.file === f && t.status === "failed") ? "failed" : "passed",
      message: "",
      assertionResults: tests
        .filter((t) => t.file === f)
        .map((t) => ({
          ancestorTitles: t.ancestors ?? [],
          fullName: [...(t.ancestors ?? []), t.title].join(" "),
          title: t.title,
          status: t.status ?? "passed",
          failureMessages: [],
        })),
    })),
    ...extra,
  });
}
