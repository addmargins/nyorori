// G4, G5, G7. Their static parts run here on git blobs; only the parts that
// need executed tests read artifacts from the untrusted Actions job, and those
// artifacts count only with verified workflow provenance (spec 10.1, 10.3).

import { posix } from "node:path";
import { evaluateCoverage } from "../gates/coverage/evaluate.js";
import { summarizeMutation } from "../gates/mutation/stryker.js";
import { evaluateTests } from "../gates/tests/evaluate.js";
import type { GateEvaluation } from "../gates/tests/evaluation.js";
import { parseTestReport } from "../gates/tests/report.js";
import { isAiLoopBot } from "../review/independence.js";
import type { Manifest } from "../types.js";
import { matchesAny } from "../util/glob.js";
import type { RunContext } from "./context.js";
import { emptyDraft, type GateDraft } from "./draft.js";
import { candidateProductCode, touchesMeasuredCode } from "./scope.js";


function touchesTestConfig(ctx: RunContext): boolean {
  return ctx.manifest.entries.some((e) =>
    [e.b?.path, e.c?.path].some(
      (p) => p !== undefined && (posix.basename(p) === "package.json" || matchesAny(p, ctx.policy.tests.protected_paths)),
    ),
  );
}

function fromEvaluation(draft: GateDraft, e: GateEvaluation): GateDraft {
  draft.violations = e.violations;
  draft.inconclusive = e.inconclusive;
  draft.triggers = e.triggers;
  draft.observe = { ...e.observe, summary: e.summary };
  draft.applicable = e.state !== "NOT_APPLICABLE";
  return draft;
}

function missingArtifact(draft: GateDraft, what: string): GateDraft {
  draft.inconclusive.push({ reason: "REPORT_MISSING", detail: `${what} artifact from the required workflow is missing`, authorFixable: false });
  return draft;
}

export function isAiLoopRun(ctx: RunContext): boolean {
  const author = ctx.opts.pr?.identity.prAuthor;
  return author !== undefined && author !== "" && isAiLoopBot(author, ctx.policy);
}

/** G4. Report-independent integrity checks always run, even when the artifact is missing. */
export async function testsGate(ctx: RunContext): Promise<GateDraft> {
  const { manifest, policy, opts } = ctx;
  const art = opts.artifacts?.tests;
  const applicable = touchesMeasuredCode(manifest) || touchesTestConfig(ctx);
  const draft = emptyDraft("tests", ctx.fingerprint, applicable);
  if (!applicable && !art) return draft;
  if (art?.provenance) draft.provenance = art.provenance;
  const knownFiles = [...ctx.treeC.keys()];
  const pathOpts = { knownFiles, ...(art?.rootDir ? { rootDir: art.rootDir } : {}) };
  const testPaths = (texts: Map<string, string>) =>
    new Map([...texts].filter(([p]) => manifest.entries.some((e) => e.isTest && (e.b?.path === p || e.c?.path === p))));
  const e = evaluateTests({
    manifest,
    reportB: art?.reportB ? parseTestReport(art.reportB, pathOpts) : null,
    reportC: art ? parseTestReport(art.reportC, pathOpts) : null,
    testSourcesB: testPaths(ctx.textsB),
    testSourcesC: testPaths(ctx.textsC),
    configSourcesB: ctx.textsB,
    configSourcesC: ctx.textsC,
    policy,
    isAiLoop: isAiLoopRun(ctx),
  });
  fromEvaluation(draft, e);
  draft.applicable = applicable || Boolean(art);
  return draft;
}


/** G5 (observe in v1). */
export async function coverageGate(ctx: RunContext): Promise<GateDraft> {
  const art = ctx.opts.artifacts?.coverage;
  const draft = emptyDraft("coverage", ctx.fingerprint, candidateProductCode(ctx.manifest));
  if (!art) return draft.applicable ? missingArtifact(draft, "coverage") : draft;
  if (art.provenance) draft.provenance = art.provenance;
  const e = evaluateCoverage({
    manifest: ctx.manifest,
    lineMaps: ctx.lineMaps,
    coverage: art.coverageFinal,
    meta: art.meta,
    ...(art.retryCoverageFinal !== undefined ? { retryCoverage: art.retryCoverageFinal } : {}),
    sourcesC: ctx.textsC,
    policy: ctx.policy,
    ...(art.rootDir ? { rootDir: art.rootDir } : {}),
  });
  return fromEvaluation(draft, e);
}

/** G7 (observe): surviving mutants on changed lines, for a PR comment. */
export async function mutationGate(ctx: RunContext): Promise<GateDraft> {
  const art = ctx.opts.artifacts?.mutation;
  const draft = emptyDraft("mutation", ctx.fingerprint, candidateProductCode(ctx.manifest));
  if (!art) return draft.applicable ? missingArtifact(draft, "mutation") : draft;
  if (art.provenance) draft.provenance = art.provenance;
  const added = ctx.manifest.entries.flatMap((e) => (e.status === "A" && e.c ? [e.c.path] : []));
  const parsed = summarizeMutation(art.report, ctx.lineMaps, added, {
    knownFiles: [...ctx.treeC.keys()],
    ...(art.rootDir ? { rootDir: art.rootDir } : {}),
  });
  if (!parsed.ok) draft.inconclusive.push(parsed.inconclusive);
  else draft.observe = { mutation: parsed.summary };
  return draft;
}
