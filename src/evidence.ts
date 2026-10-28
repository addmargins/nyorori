import { createPublicKey, verify } from 'node:crypto';
import { canonical, readJson } from './policy.js';
import {
  gateResult,
  type Evidence,
  type GateResult,
  type Issue,
  type Policy,
  type Review,
  type Waiver,
} from './types.js';
export interface EvidenceContext {
  repository: string;
  base_sha: string;
  candidate_sha: string;
  policy_revision: string;
  policy_sha256: string;
  measurement_fingerprint: string;
}
export interface VerifiedEvidence {
  evidence?: Evidence;
  verified: boolean;
  issues: Issue[];
}
export async function verifyEvidence(
  path: string | undefined,
  context: EvidenceContext,
  policy: Policy,
): Promise<VerifiedEvidence> {
  if (!path) return { verified: false, issues: [] };
  try {
    if (!policy.evidence) throw new Error('No trusted evidence issuer configured');
    const env = (await readJson(path, 10_000_000)) as { payload: Evidence; signature: string };
    if (
      !env ||
      typeof env !== 'object' ||
      !env.payload ||
      typeof env.signature !== 'string' ||
      env.signature.length > 256
    )
      throw new Error('Invalid signed envelope');
    const publicKey = createPublicKey(policy.evidence.public_key);
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Evidence key must be Ed25519');
    if (
      !verify(
        null,
        Buffer.from(canonical(env.payload)),
        publicKey,
        Buffer.from(env.signature, 'base64'),
      )
    )
      throw new Error('Evidence signature rejected');
    const e = env.payload;
    if (e.schema_version !== 1 || e.issuer !== policy.evidence.issuer)
      throw new Error('Evidence issuer/schema mismatch');
    for (const [key, value] of Object.entries(context))
      if (e[key as keyof Evidence] !== value)
        throw new Error(`Stale or mismatched evidence: ${key}`);
    const age = Date.now() - Date.parse(e.issued_at);
    if (!Number.isFinite(age) || age < -30000 || age > policy.evidence.max_age_seconds * 1000)
      throw new Error('Evidence expired or issued in future');
    if (
      !e.actors ||
      typeof e.actors.author !== 'string' ||
      !Array.isArray(e.actors.participants) ||
      !Array.isArray(e.actors.agent_initiators) ||
      [...e.actors.participants, ...e.actors.agent_initiators].some((x) => typeof x !== 'string')
    )
      throw new Error('Incomplete actor authority evidence');
    for (const k of ['reviews', 'waivers', 'protected_change_approvals'] as const)
      if (e[k] !== undefined && (!Array.isArray(e[k]) || e[k]!.length > 1000))
        throw new Error('Invalid approval collection');
    return { evidence: e, verified: true, issues: [] };
  } catch (error) {
    return {
      verified: false,
      issues: [
        {
          code: 'EVIDENCE_REJECTED',
          message: error instanceof Error ? error.message : 'Evidence rejected',
        },
      ],
    };
  }
}
export function independent(
  actor: unknown,
  e: Evidence,
  p: Policy,
  role: keyof Policy['identities'],
): boolean {
  if (typeof actor !== 'string' || !actor.trim()) return false;
  const id = actor.toLowerCase();
  return (
    p.identities[role].some((x) => x.toLowerCase() === id) &&
    ![
      e.actors.author,
      ...e.actors.participants,
      ...e.actors.agent_initiators,
      ...p.identities.bots,
    ].some((x) => x.toLowerCase() === id) &&
    !id.endsWith('[bot]')
  );
}
function validDate(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : NaN;
}
export function validReview(r: Review, e: Evidence, p: Policy): boolean {
  return (
    !!r &&
    typeof r.id === 'string' &&
    r.id.length > 0 &&
    independent(r.actor, e, p, 'simplification_reviewers') &&
    r.head_sha === e.candidate_sha &&
    validDate(r.expires_at) > Date.now() &&
    ['NO_SIMPLIFICATION_NEEDED', 'SUGGESTED', 'REQUIRED'].includes(r.decision) &&
    Array.isArray(r.rubric) &&
    r.rubric.length === 5 &&
    r.rubric.every((x) => x && typeof x === 'object') &&
    new Set(r.rubric.map((x) => x.question)).size === 5 &&
    r.rubric.every(
      (x) =>
        Number.isInteger(x.question) &&
        x.question >= 1 &&
        x.question <= 5 &&
        typeof x.answer === 'boolean' &&
        typeof x.evidence === 'string' &&
        x.evidence.trim().length > 0,
    )
  );
}
export function evaluateReview(
  triggers: GateResult['triggers'],
  e: Evidence | undefined,
  p: Policy,
): GateResult {
  const result = gateResult('simplification-review', p);
  const routed = triggers.filter((x) => x.id !== 'S8' && !x.observe_only);
  result.triggers = routed;
  if (!routed.length) {
    result.state = 'NOT_APPLICABLE';
    result.reasons = ['NO_REVIEW_TRIGGERS'];
    return result;
  }
  const reviews = (e?.reviews ?? []).filter((r) => e && validReview(r, e, p));
  result.observe.valid_reviews = reviews.map((x) => x.id);
  if (reviews.some((x) => x.decision === 'REQUIRED')) {
    result.state = 'FAIL';
    result.reasons = ['SIMPLIFICATION_REQUIRED'];
  } else if (!reviews.length) {
    result.state = 'FAIL';
    result.reasons = ['SIMPLIFICATION_REVIEW_REQUIRED'];
  } else result.reasons = ['INDEPENDENT_REVIEW_ACCEPTED'];
  return result;
}
export function applyWaivers(result: GateResult, e: Evidence | undefined, p: Policy): GateResult {
  if (result.gate !== 'complexity' || !e?.waivers?.length || !result.violations.length)
    return result;
  const candidates = e.waivers.filter((w) => validWaiver(w, e, p));
  if (new Set(candidates.map((w) => w.id)).size !== candidates.length) {
    result.issues.push({ code: 'WAIVER_SCHEMA', message: 'Duplicate waiver IDs' });
    return result;
  }
  if (candidates.length > p.waiver.max_per_pr) {
    result.issues.push({ code: 'WAIVER_BUDGET', message: 'PR waiver budget exceeded' });
    return result;
  }
  const applied = new Set<string>();
  const remaining = result.violations.filter((v) => {
    const w = candidates.find(
      (w) =>
        w.unit === v.unit &&
        w.blob_sha === v.blob_sha &&
        typeof v.after === 'number' &&
        v.after <= w.ceiling,
    );
    if (w) {
      applied.add(w.id);
      return false;
    }
    return true;
  });
  result.waivers_applied = [...applied].sort();
  if (applied.size) {
    result.triggers.push({
      id: 'S6',
      file: '',
      evidence: `Waiver risk acceptance: ${[...applied].join(', ')}`,
    });
    result.observe.waived_violations = result.violations.filter((x) => !remaining.includes(x));
    result.violations = remaining;
    if (!remaining.length && !result.issues.length) result.state = 'ACCEPTED_WITH_WAIVER';
  }
  return result;
}
function validWaiver(w: Waiver, e: Evidence, p: Policy): boolean {
  if (
    !w ||
    typeof w.unit !== 'string' ||
    w.unit.includes('*') ||
    w.unit.length > 2048 ||
    typeof w.reason !== 'string' ||
    !w.reason.trim() ||
    typeof w.id !== 'string' ||
    !w.id.trim()
  )
    return false;
  const issued = validDate(w.issued_at),
    expiry = validDate(w.expires_at);
  return (
    w.gate === 'complexity' &&
    w.metric === 'cognitive' &&
    independent(w.actor, e, p, 'waiver_approvers') &&
    w.head_sha === e.candidate_sha &&
    /^[a-f0-9]{40,64}$/.test(w.blob_sha) &&
    Number.isSafeInteger(w.ceiling) &&
    w.ceiling >= 0 &&
    expiry > Date.now() &&
    issued <= Date.now() + 30000 &&
    expiry - issued <= p.waiver.max_days * 86400000 &&
    expiry > issued
  );
}
