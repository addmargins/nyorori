// Inputs and outputs of one full gate run for (repo, B, C, P, M). Everything
// that comes from GitHub is plain data here so the pipeline stays testable and
// the service, the CLI and the tests all drive the same code.

import type { ArtifactProvenance, QualityGateVerdict } from "../aggregate/index.js";
import type { CcccRun } from "../measure/cccc.js";
import type { Policy } from "../policy/schema.js";
import type { GateFeedback } from "../report/feedback.js";
import type { CheckRunOutput } from "../report/checkrun.js";
import type { PrIdentityContext, TeamRosters } from "../review/independence.js";
import type { CarryOverInfo, LlmReview, ReviewComment } from "../review/simplification.js";
import type { GateResult, Manifest } from "../types.js";
import type { IssueComment, ValidWaiver } from "../waivers/index.js";

/** Pull-request context read from GitHub by the service (or a JSON file for the CLI). */
export interface PullRequestContext {
  /** Comments carrying gate commands. Review comments must record the head SHA they were posted on. */
  comments: ReviewComment[];
  identity: PrIdentityContext;
  teams?: TeamRosters;
  /** PR head the simplification review and waivers are bound to. Defaults to C. */
  headSha?: string;
  /** Keyed by the SHA a review was given on. */
  carryOver?: Record<string, CarryOverInfo>;
  llm?: LlmReview;
  /** Waivers already applied this quarter (from the ledger), for policy.waivers.per_quarter_budget. */
  quarterWaiversUsed?: number;
}

export interface ArtifactInput {
  /** Provenance resolved by the service from the GitHub API, never read from the artifact. */
  provenance?: ArtifactProvenance;
}

export interface TestArtifacts extends ArtifactInput {
  reportC: string;
  reportB?: string;
  /** Absolute checkout root recorded by the job, to map absolute paths back. */
  rootDir?: string;
}

export interface CoverageArtifacts extends ArtifactInput {
  coverageFinal: string;
  meta: string;
  retryCoverageFinal?: string;
  rootDir?: string;
}

export interface MutationArtifacts extends ArtifactInput {
  report: string;
  rootDir?: string;
}

export interface Artifacts {
  tests?: TestArtifacts;
  coverage?: CoverageArtifacts;
  mutation?: MutationArtifacts;
}

export interface RunGatesOptions {
  repoDir: string;
  base: string;
  candidate: string;
  policy: Policy;
  /** Revision of P (gate repository commit or content digest). */
  policyRevision: string;
  ccccBinary: string;
  workDir: string;
  /** Commit of the gate runner itself (part of the measurement fingerprint). */
  runnerCommit: string;
  pr?: PullRequestContext;
  artifacts?: Artifacts;
  /** Injectable for the determinism sample. */
  rng?: () => number;
  now?: Date;
  /** AI fix-loop attempt number, for gate-feedback.json. */
  attempt?: number;
  /**
   * AI fix loop only: the previous attempt C_{n-1}. S1/S9/S10 are also computed
   * against it for files that violated G1 there (ruling D17).
   */
  previousAttempt?: string;
}

export interface RunGatesOutput {
  verdict: QualityGateVerdict;
  /** Sub-gate results, G6 included. */
  results: GateResult[];
  manifest: Manifest;
  ccccRuns: CcccRun[];
  summaryMarkdown: string;
  checkRun: CheckRunOutput;
  feedback: GateFeedback;
  /** Waivers applied in this verdict, with the waived value; the ledger records them at merge. */
  appliedWaivers: AppliedWaiver[];
}

export interface AppliedWaiver {
  waiver: ValidWaiver;
  /** The violation's value at the time of the verdict (largest when several violations share the waiver). */
  value: number | null;
}
