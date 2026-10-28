import { describe, expect, it } from "vitest";
import { applyOverrides } from "../../src/override/index.js";
import type { Inconclusive } from "../../src/types.js";
import { BLOB, BLOB2, comment, identity, policy } from "./helpers.js";

const schema: Inconclusive = { reason: "SCHEMA", file: "src/a.ts", detail: "missing field cognitive", authorFixable: false };
const parse: Inconclusive = { reason: "PARSE_ERROR_CANDIDATE", file: "src/a.ts", detail: "Unexpected token `accessor`", authorFixable: false };
const syntax: Inconclusive = { reason: "PARSE_ERROR_CANDIDATE", file: "src/a.ts", detail: "Expected `;`", authorFixable: true };

const cmd = (reason: string, login = "owner-dave", blob = BLOB) =>
  comment(5, login, `/gate-override gate=complexity reason=${reason} file="src/a.ts" blob=${blob} note="oxc lag"`);

function run(items: Inconclusive[], comments: ReturnType<typeof comment>[], p = policy()) {
  return applyOverrides("complexity", items, comments, { policy: p, identity, candidateBlob: (f) => (f === "src/a.ts" ? BLOB : null) });
}

describe("measurement override", () => {
  it("turns a gate-owner reason into unmeasured + S6, never PASS-from-FAIL", () => {
    const r = run([schema], [cmd("SCHEMA")]);
    expect(r.inconclusive).toEqual([]);
    expect(r.unmeasured).toEqual([{ path: "src/a.ts", side: "C", reason: "MEASUREMENT_OVERRIDE" }]);
    expect(r.triggers[0]).toMatchObject({ id: "S6", routing: true });
    expect(r.fallbackMeasure).toEqual(["src/a.ts"]);
  });

  it("rejects non-owners, the author, changed files and author-fixable reasons", () => {
    expect(run([schema], [cmd("SCHEMA", "rev-alice")]).inconclusive).toHaveLength(1);
    const ownerAuthor = policy({ review: { gate_owners: ["author-erin"] } });
    expect(run([schema], [cmd("SCHEMA", "author-erin")], ownerAuthor).rejected[0]!.problem).toMatch(/author/);
    expect(run([schema], [cmd("SCHEMA", "owner-dave", BLOB2)]).inconclusive).toHaveLength(1);
    // An author-fixable syntax error that is not on the parser-lag list stays.
    expect(run([syntax], [cmd("PARSE_ERROR_CANDIDATE")], policy({ parser_lag_allowlist: ["`accessor`"] })).inconclusive).toHaveLength(1);
    expect(run([schema], [cmd("MANIFEST_MISMATCH")]).rejected[0]!.problem).toMatch(/cannot be overridden/);
  });

  it("allows PARSE_ERROR_CANDIDATE only for listed parser-lag syntax", () => {
    expect(run([parse], [cmd("PARSE_ERROR_CANDIDATE")]).inconclusive).toHaveLength(1);
    expect(run([parse], [cmd("PARSE_ERROR_CANDIDATE")], policy({ parser_lag_allowlist: ["`accessor`"] })).inconclusive).toHaveLength(0);
  });

  it("cannot override file-less (global) measurement failures", () => {
    const global: Inconclusive = { reason: "MEASURER_MISMATCH", detail: "sha256 mismatch", authorFixable: false };
    expect(run([global], [cmd("MEASURER_MISMATCH")]).inconclusive).toHaveLength(1);
  });
});
