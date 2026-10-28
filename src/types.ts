export const GATES = [
  'complexity',
  'lint-structure',
  'deps',
  'tests',
  'coverage',
  'simplification-review',
  'mutation',
] as const;
export type GateId = (typeof GATES)[number];
export type State = 'PASS' | 'FAIL' | 'INCONCLUSIVE' | 'NOT_APPLICABLE' | 'ACCEPTED_WITH_WAIVER';
export type Mode = 'observe' | 'enforce';
export interface Issue {
  code: string;
  message: string;
  file?: string;
  line?: number;
}
export interface Trigger {
  id: string;
  file: string;
  evidence: string;
  observe_only?: boolean;
}
export interface Violation {
  unit: string;
  file: string;
  line: number;
  reason: string;
  metric?: string;
  before?: number | null;
  after?: number;
  limit?: number;
  blob_sha?: string;
  inclusive_cognitive?: number;
  cyclomatic_observe?: number;
}
export interface GateResult {
  gate: GateId;
  state: State;
  mode: Mode;
  reasons: string[];
  violations: Violation[];
  triggers: Trigger[];
  issues: Issue[];
  observe: Record<string, unknown>;
  waivers_applied?: string[];
}
export interface Policy {
  schema_version: 1;
  revision: string;
  phase: 'P0' | 'P1' | 'P2' | 'P3';
  gates: Record<GateId, Mode>;
  measurement: {
    binary: string;
    sha256: string;
    version: string;
    timeout_ms: number;
    jobs: number;
    max_file_bytes: number;
    jsx_in_js: boolean;
  };
  scope: {
    source_extensions: string[];
    unmeasured_extensions: string[];
    non_code_extensions: string[];
    test_globs: string[];
    exclude_globs: string[];
    protected_globs: string[];
  };
  limits: {
    cognitive: number;
    max_params: number;
    max_callbacks: number;
    max_function_lines: number;
    coverage_uncovered: number;
    coverage_fraction: number;
  };
  dependencies: { forbidden: { from: string; to: string }[] };
  identities: {
    simplification_reviewers: string[];
    waiver_approvers: string[];
    gate_owners: string[];
    bots: string[];
  };
  evidence?: { public_key: string; issuer: string; max_age_seconds: number };
  coverage: { provider: string; version: string };
  waiver: { max_per_pr: number; max_days: number };
}
export type Classification = 'source' | 'test' | 'excluded' | 'unmeasured' | 'non-code';
export interface SourceFile {
  path: string;
  blob_sha: string;
  mode: string;
  content: string;
  classification: Classification;
  reason?: string;
}
export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}
export interface FileChange {
  status: string;
  oldPath?: string;
  newPath?: string;
  before?: SourceFile;
  after?: SourceFile;
  hunks: Hunk[];
  lineMap: Map<number, number>;
}
export interface ManifestEntry {
  path: string;
  side: 'B' | 'C';
  mode: string;
  blob_sha: string;
  status: string;
  classification: Classification;
  reason?: string;
}
export interface Snapshot {
  base_sha: string;
  candidate_sha: string;
  files: FileChange[];
  manifest: ManifestEntry[];
  issues: Issue[];
}
export interface FunctionUnit {
  name: string;
  kind: string;
  line: number;
  cognitive: number;
  cyclomatic: number;
  children: FunctionUnit[];
}
export interface MeasuredFile {
  path: string;
  cognitive: number;
  cyclomatic: number;
  functions: FunctionUnit[];
  parse_errors: string[];
}
export interface Fingerprint {
  runtime?: string;
  cccc_version: string;
  cccc_sha256: string;
  runner_commit: string;
  policy_revision: string;
  arguments: string[];
  toolchain_sha256: string;
}
export interface Measurement {
  base: Record<string, MeasuredFile>;
  candidate: Record<string, MeasuredFile>;
  fingerprint: Fingerprint;
  issues: Issue[];
}
export interface Match {
  before: FunctionUnit;
  after: FunctionUnit;
  beforeFile: string;
  afterFile: string;
  method: 'anchor' | 'hunk' | 'name' | 'move' | 'module';
}
export interface TestCase {
  id: string;
  status: 'passed' | 'failed' | 'skipped' | 'todo';
  assertions: number;
}
export interface TestReport {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  tests: TestCase[];
}
export interface Review {
  id: string;
  actor: string;
  head_sha: string;
  decision: 'NO_SIMPLIFICATION_NEEDED' | 'SUGGESTED' | 'REQUIRED';
  rubric: { question: number; answer: boolean; evidence: string }[];
  expires_at: string;
}
export interface Waiver {
  id: string;
  actor: string;
  head_sha: string;
  unit: string;
  blob_sha: string;
  gate: 'complexity';
  metric: 'cognitive';
  ceiling: number;
  reason: string;
  expires_at: string;
  issued_at: string;
}
export interface Evidence {
  schema_version: 1;
  issuer: string;
  repository: string;
  base_sha: string;
  candidate_sha: string;
  policy_revision: string;
  policy_sha256: string;
  measurement_fingerprint: string;
  issued_at: string;
  actors: { author: string; participants: string[]; agent_initiators: string[] };
  tests?: { base: TestReport; candidate: TestReport };
  coverage?: { provider: string; version: string; files: Record<string, unknown> };
  mutation?: { killed: number; survived: number; timeout: number; no_coverage: number };
  reviews?: Review[];
  waivers?: Waiver[];
  protected_change_approvals?: { actor: string; head_sha: string; paths: string[] }[];
}
export interface EvidenceEnvelope {
  payload: Evidence;
  signature: string;
}
export interface GateRun {
  schema_version: 1;
  authority: 'local' | 'github-app';
  repository: string;
  base_sha: string;
  candidate_sha: string;
  policy_revision: string;
  phase: Policy['phase'];
  measurement_fingerprint: Fingerprint;
  policy_sha256?: string;
  state: State;
  exit_code: 0 | 1 | 2;
  check_conclusion: 'success' | 'failure';
  would_block: boolean;
  gates: GateResult[];
  triggers: Trigger[];
  evidence_verified: boolean;
  issues: Issue[];
}
export function gateResult(gate: GateId, policy: Policy, state: State = 'PASS'): GateResult {
  return {
    gate,
    state,
    mode: policy.gates[gate],
    reasons: [],
    violations: [],
    triggers: [],
    issues: [],
    observe: {},
  };
}
