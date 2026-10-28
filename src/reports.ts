import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GateRun, Snapshot } from './types.js';
function safe(s: unknown): string {
  return String(s)
    .replace(/[\r\n|`<>]/g, ' ')
    .slice(0, 2000);
}
export async function writeReports(out: string, run: GateRun, snapshot: Snapshot): Promise<void> {
  const failures = run.gates
    .flatMap((g) => g.violations.map((v) => ({ gate: g.gate, ...v })))
    .sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.reason.localeCompare(b.reason),
    );
  const lines = [
    `# Quality gate: ${run.state}`,
    '',
    `Authority: **${run.authority}**. ${run.authority === 'local' ? 'Local analysis is not an authoritative GitHub merge approval.' : ''}`,
    `Phase: ${run.phase}; ${run.would_block ? 'observed failures or incomplete evidence exist' : 'all applicable analysis passed'}.`,
    `Base: \`${safe(run.base_sha)}\` · Candidate: \`${safe(run.candidate_sha)}\` · Policy: \`${safe(run.policy_revision)}\``,
    '',
  ];
  for (const v of failures)
    lines.push(
      `- **${safe(v.reason)}** — ${safe(v.file)}:${v.line} ${safe(v.unit)}${v.after !== undefined ? `; ${v.metric ?? 'value'} ${v.after}, limit ${v.limit}` : ''}`,
    );
  lines.push('', '| Gate | Mode | State | Reasons |', '|---|---|---|---|');
  for (const g of run.gates)
    lines.push(`| ${safe(g.gate)} | ${g.mode} | ${g.state} | ${g.reasons.map(safe).join(', ')} |`);
  if (run.triggers.length) {
    lines.push('', '## Review evidence', '');
    for (const t of run.triggers)
      lines.push(
        `- ${t.id}${t.observe_only ? ' (observe)' : ''} ${safe(t.file)}: ${safe(t.evidence)}`,
      );
  }
  const issues = [...run.issues, ...run.gates.flatMap((g) => g.issues)];
  if (issues.length) {
    lines.push('', '## Incomplete evidence', '');
    for (const i of issues)
      lines.push(`- ${safe(i.code)} ${safe(i.file ?? '')}: ${safe(i.message)}`);
  }
  lines.push(
    '',
    'Statistics describe the changed files only. Existing complexity debt is an allowance, not a code health endorsement.',
    '',
  );
  await writeFile(
    path.join(out, 'manifest.json'),
    JSON.stringify(
      {
        schema_version: 1,
        base_sha: run.base_sha,
        candidate_sha: run.candidate_sha,
        files: snapshot.manifest,
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  await writeFile(path.join(out, 'gate-result.json'), JSON.stringify(run, null, 2) + '\n', {
    flag: 'wx',
  });
  await writeFile(path.join(out, 'gate-summary.md'), lines.join('\n'), { flag: 'wx' });
  const feedback = {
    schema_version: 1,
    base_sha: run.base_sha,
    candidate_sha: run.candidate_sha,
    state: run.state,
    violations: failures,
    triggers: run.triggers,
    max_automatic_retries: 2,
    stop_if: ['same violation set', 'new review trigger', 'test or policy weakening'],
    forbidden_changes: [
      'policy or gate configuration',
      'test deletion, focus, skipping or assertion weakening',
      'coverage/ignore suppression',
      'moving code outside measured scope',
    ],
    instruction:
      'Preserve requirements and behavior. Fix named units without deleting features or weakening other gates.',
  };
  await writeFile(path.join(out, 'gate-feedback.json'), JSON.stringify(feedback, null, 2) + '\n', {
    flag: 'wx',
  });
  await writeFile(path.join(out, 'agent-feedback.json'), JSON.stringify(feedback, null, 2) + '\n', {
    flag: 'wx',
  });
}
