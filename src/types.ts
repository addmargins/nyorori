// Shared contracts between the measurement, policy, gate and reporting layers.
// Every module imports its cross-cutting types from here so the pieces stay
// interchangeable and the JSON artifacts keep one schema.

// ---------------------------------------------------------------------------
// cccc raw output (v1.8.5, `crates/cccc-core/src/report.rs`)
// ---------------------------------------------------------------------------

export interface CcccFunction {
  name: string;
  /** "function" | "method" | "arrow" | "getter" | "setter" | "constructor" */
  kind: string;
  /** 1-based start line. */
  line: number;
  cognitive: number;
  cyclomatic: number;
  /** Omitted by cccc when empty. */
  children?: CcccFunction[];
}

export interface CcccFile {
  path: string;
  /** File total = module-level code + every function at every depth. */
  cognitive: number;
  cyclomatic: number;
  functions: CcccFunction[];
  /** Omitted by cccc when empty. */
  parse_errors?: string[];
}

export interface CcccMetricSummary {
  sum: number;
  max: number;
  median: number;
  p90: number;
  p95: number;
}

export interface CcccSummary {
  file_count: number;
  function_count: number;
  parse_error_count: number;
  parse_error_file_count: number;
  parse_error_files?: string[];
  cognitive: CcccMetricSummary;
  cyclomatic: CcccMetricSummary;
}

export interface CcccReport {
  files: CcccFile[];
  summary: CcccSummary;
}

// ---------------------------------------------------------------------------
// States and identifiers
// ---------------------------------------------------------------------------

export type Side = "B" | "C";

/** Ordered from most to least severe for aggregation (spec 4.2). */
export const GATE_STATES = [
  "FAIL",
  "INCONCLUSIVE",
  "ACCEPTED_WITH_WAIVER",
  "PASS",
  "NOT_APPLICABLE",
] as const;
export type GateState = (typeof GATE_STATES)[number];

/**
 * enforce: blocks. observe: recorded only (shadow). degraded: set by the 13.4
 * incident procedure; FAILs and routing triggers become required G6 review.
 */
export type GateMode = "enforce" | "observe" | "degraded";

export const GATE_IDS = [
  "complexity",
  "lint-structure",
  "deps",
  "tests",
  "coverage",
  "simplification-review",
  "mutation",
] as const;
export type GateId = (typeof GATE_IDS)[number];

/** Runner exit codes (spec 9.1). Independent of cccc's own exit codes. */
export const EXIT_CODE: Record<GateState, 0 | 1 | 2> = {
  PASS: 0,
  NOT_APPLICABLE: 0,
  ACCEPTED_WITH_WAIVER: 0,
  FAIL: 1,
  INCONCLUSIVE: 2,
};

/** Reason codes for INCONCLUSIVE (measurement could not be trusted). */
export type InconclusiveReason =
  | "MEASURER_MISMATCH"
  | "MEASURER_EXIT"
  | "EMPTY_OUTPUT"
  | "SCHEMA"
  | "MANIFEST_MISMATCH"
  | "MEASURER_STDERR"
  | "PARSE_ERROR_CANDIDATE"
  | "INVARIANT_VIOLATION"
  | "TIMEOUT"
  | "UNITS_VANISHED"
  | "NONDETERMINISM"
  | "CASE_COLLISION"
  | "LFS_POINTER"
  | "FILE_TOO_LARGE"
  | "UNREGISTERED_EXTENSION"
  | "JSX_IN_JS"
  | "INVALID_ENCODING"
  | "PATH_TOO_LONG"
  | "FINGERPRINT_MISMATCH"
  | "TOOL_ERROR"
  | "NO_TESTS_EXECUTED"
  | "REPORT_MISSING"
  | "UNTRUSTED_ARTIFACT";

/** Reason codes for FAIL (policy violation the author can act on). */
export type FailReason =
  | "OVER_LIMIT_NEW"
  | "OVER_LIMIT"
  | "LEGACY_WORSENED"
  | "UNMATCHED_OVER_BUDGET"
  | "LINT_NEW_VIOLATION"
  | "DYNAMIC_CODE"
  | "BIDI_CONTROL"
  | "SUPPRESSION_ADDED"
  /** `@ts-ignore` added by a human: waivable (rulings D9). */
  | "SUPPRESSION_ADDED_WAIVABLE"
  | "DEP_NEW_CYCLE"
  | "DEP_FORBIDDEN_EDGE"
  | "TESTS_FAILED"
  /** Failing tests that also failed on B: waivable (rulings D14). */
  | "TESTS_FAILED_ON_BASE"
  | "TEST_REMOVED"
  | "TEST_FOCUS_OR_SKIP"
  | "TEST_NO_ASSERTION"
  | "TEST_CONFIG_WEAKENED"
  | "PROTECTED_PATH_MODIFIED"
  | "POLICY_PATH_MODIFIED"
  | "COVERAGE_UNEXECUTED"
  | "REVIEW_REQUIRED"
  | "REVIEW_CHANGES_REQUESTED";

export type ReasonCode = InconclusiveReason | FailReason;

export type TriggerId =
  | "S1"
  | "S2"
  | "S3"
  | "S4"
  | "S5"
  | "S6"
  | "S7"
  | "S8"
  | "S9"
  | "S10"
  | "S11"
  | "S12";

/** S8 is observe-only; every other trigger routes to G6 when it fires. */
/** Triggers that route even from observe-mode gates (rulings D16). */
export const ALWAYS_ROUTING_TRIGGERS: ReadonlySet<TriggerId> = new Set(["S6", "S11"]);
export const NON_ROUTING_TRIGGERS: ReadonlySet<TriggerId> = new Set(["S8"]);

// ---------------------------------------------------------------------------
// Manifest (spec 6.2)
// ---------------------------------------------------------------------------

export type ChangeStatus = "A" | "M" | "D" | "R" | "C" | "T";

export type UnmeasuredReason =
  | "SYMLINK"
  | "SUBMODULE"
  | "TYPE_CHANGE"
  | "UNSUPPORTED_FORMAT" // .vue .svelte .astro .mdx ...
  | "FOREIGN_LANGUAGE" // .py .sh .go ... (rulings D5/D6)
  | "MEASUREMENT_OVERRIDE";

export type ExcludedReason = "DECLARATION_FILE" | "POLICY_EXCLUDE" | "NOT_CODE";

export interface ManifestSide {
  /** Repository-relative path on this side. */
  path: string;
  blob: string;
  mode: string;
  /**
   * Path handed to cccc, relative to the tree root. Usually equal to `path`;
   * JSX-in-.js files get a `.jsx` suffix (spec 6.2).
   */
  measuredPath: string;
}

export interface ManifestEntry {
  status: ChangeStatus;
  /** Rename/copy similarity score (0-100), when git reports one. */
  similarity?: number;
  b: ManifestSide | null;
  c: ManifestSide | null;
  /** Which sides are handed to cccc. */
  measure: { B: boolean; C: boolean };
  unmeasured?: UnmeasuredReason;
  excluded?: ExcludedReason;
  /** True when the C side lives under an excluded path and is newly added (S11). */
  newInExcludedPath?: boolean;
  /** True when either side's path matches policy.scope.test_globs (see isTestB / isTestC). */
  isTest?: boolean;
  /** Whether the B path matches policy.scope.test_globs (absent when there is no B side). */
  isTestB?: boolean;
  /** Whether the C path matches policy.scope.test_globs (absent when there is no C side). */
  isTestC?: boolean;
}

export interface Manifest {
  baseSha: string;
  candidateSha: string;
  entries: ManifestEntry[];
  /** Manifest-level problems (case collisions, LFS pointers, size caps...). */
  problems: Array<{ reason: InconclusiveReason; path: string; detail: string }>;
  /** Paths outside the measured scope that still matter (e.g. .gitattributes). */
  sensitivePathsChanged: string[];
}

// ---------------------------------------------------------------------------
// Line mapping from `git diff -U0` (spec 5.4)
// ---------------------------------------------------------------------------

export interface Hunk {
  /** First removed line in B (1-based). When bCount is 0, the line after which C lines were inserted. */
  bStart: number;
  bCount: number;
  cStart: number;
  cCount: number;
}

export interface FileLineMap {
  pathB: string;
  pathC: string;
  hunks: Hunk[];
}

// ---------------------------------------------------------------------------
// Measured units (spec 5.1)
// ---------------------------------------------------------------------------

export const RESIDUE_NAME = "<module>";

export interface Unit {
  /** `${path}::${nameChain.join(">")}#${kind}[${ordinal}]`, or `${path}::<module>`. */
  key: string;
  path: string;
  name: string;
  kind: string;
  line: number;
  /** Position among units starting on the same line, in source order. */
  lineOrdinal: number;
  /** Ordinal among siblings with the same (name, kind). */
  sameNameOrdinal: number;
  depth: number;
  cognitive: number;
  cyclomatic: number;
  /** Own CogC + every descendant's CogC. */
  inclusiveCognitive: number;
  /** Last line (inclusive) of the scope approximation: up to the next unit at same or shallower depth. */
  endLine: number;
  /** Overload signatures, `declare function`, abstract methods: CC 1, CogC 0, no children. */
  signatureOnly: boolean;
  isResidue: boolean;
  parentKey: string | null;
  children: Unit[];
}

export interface FileMeasurement {
  side: Side;
  path: string;
  blob: string;
  /** Top-level units in source order; children nested. Residue is separate. */
  units: Unit[];
  residue: Unit;
  parseErrors: string[];
  lineCount: number;
  /** Raw file totals from cccc. */
  totalCognitive: number;
  totalCyclomatic: number;
}

export type MatchStage = 1 | 2 | 3 | 4;

export interface UnitMatch {
  bKey: string;
  cKey: string;
  stage: MatchStage;
  /** Stage 2 or 3 matches: declaration line changed or unit moved within file. */
  identityChanged: boolean;
}

// ---------------------------------------------------------------------------
// Findings and results (spec 9.2)
// ---------------------------------------------------------------------------

export interface Violation {
  gate: GateId;
  reason: ReasonCode;
  file: string;
  unit?: string;
  line?: number;
  metric?: string;
  before?: number | null;
  after?: number | null;
  limit?: number | null;
  message: string;
  /** Extra structured evidence (inclusive_cognitive, cyclomatic_observe, B candidates, rule id...). */
  details?: Record<string, unknown>;
  /** Set by waiver application. */
  waivedBy?: string;
}

export interface TriggerHit {
  id: TriggerId;
  gate: GateId;
  file?: string;
  unit?: string;
  evidence: string;
  /** False for observe-only triggers (S8) and for P1-only signals such as moving baselines. */
  routing: boolean;
}

export interface Inconclusive {
  reason: InconclusiveReason;
  file?: string;
  detail: string;
  /** True when the author can fix it (syntax error, encoding...). Such reasons are never overridable. */
  authorFixable: boolean;
}

export interface MeasurementFingerprint {
  cccc_version?: string;
  cccc_sha256?: string;
  runner_commit: string;
  policy_revision: string;
  args_template?: string[];
  tools?: Record<string, string>;
}

export interface UnmeasuredRecord {
  path: string;
  side: Side;
  reason: UnmeasuredReason;
}

export interface WaiverApplied {
  id: string;
  unit: string;
  metric: string;
  ceiling: number;
  approver: string;
}

export interface GateResult {
  schema_version: 1;
  gate: GateId;
  state: GateState;
  mode: GateMode;
  base_sha: string;
  candidate_sha: string;
  policy_revision: string;
  measurement_fingerprint: MeasurementFingerprint;
  reasons: ReasonCode[];
  violations: Violation[];
  inconclusive: Inconclusive[];
  triggers: TriggerHit[];
  waivers_applied: WaiverApplied[];
  unmeasured: UnmeasuredRecord[];
  observe: Record<string, unknown>;
  /** One-line headline for the check run title. */
  summary: string;
}

/** Severity order for aggregation: lower index wins. */
export function worstState(states: Iterable<GateState>): GateState {
  let best: GateState = "NOT_APPLICABLE";
  for (const s of states) {
    if (GATE_STATES.indexOf(s) < GATE_STATES.indexOf(best)) best = s;
  }
  return best;
}
