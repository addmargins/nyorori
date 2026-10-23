import path from 'node:path'
import type { Report } from './run.ts'
import type { Mutant, MutantResult, MutantStatus } from './types.ts'

const FAILING: ReadonlySet<MutantStatus> = new Set(['Survived', 'NoCoverage'])

export function failures(report: Report): MutantResult[] {
  return report.results.filter((r) => FAILING.has(r.status))
}

export function exitCode(report: Report): 0 | 1 {
  if (report.dryRun) return 0
  return failures(report).length > 0 || report.problems.length > 0 ? 1 : 0
}

function counts(report: Report): string {
  const order: MutantStatus[] = ['Killed', 'Timeout', 'Survived', 'NoCoverage', 'Ignored']
  return order
    .map((status) => [status, report.results.filter((r) => r.status === status).length] as const)
    .filter(([, n]) => n > 0)
    .map(([status, n]) => `${n} ${status}`)
    .join(', ')
}

function droppedAsEquivalent(report: Report): string {
  return `${plural(report.equivalent.length, 'mutant')} dropped as equivalent (TCE)`
}

/** One line per reason, e.g. "2 mutants skipped: string concatenation in every observed evaluation". */
function skipped(report: Report): string[] {
  const byReason = new Map<string, number>()
  for (const m of report.skipped) byReason.set(m.reason, (byReason.get(m.reason) ?? 0) + 1)
  return [...byReason].map(([reason, n]) => `${plural(n, 'mutant')} skipped: ${reason}`)
}

/** One line for the `?.` and `??` that guard nothing, by their types and the tests; the step summary lists them. */
function unnecessary(report: Report): string {
  return `${plural(report.unnecessary.length, 'mutant')} unnecessary by types: \`?.\` or \`??\` where the type can't be null or undefined and no test made it so`
}

interface Misprediction {
  mutant: Mutant
  /** What the profile said, e.g. "predicted to survive". */
  claim: string
  reason: string
  status: MutantStatus
}

/** Only with --no-predict: mutants the profile said would survive, but did not. */
function mispredicted(report: Report): Misprediction[] {
  const wrong: Misprediction[] = []
  for (const r of report.results) {
    if (r.mispredicted) wrong.push({ mutant: r, claim: 'predicted to survive', reason: r.reason!, status: r.mispredicted })
  }
  for (const m of report.unnecessary) {
    if (m.mispredicted) wrong.push({ mutant: m, claim: 'unnecessary by types', reason: m.reason, status: m.mispredicted })
  }
  return wrong
}

/** Only when TypeScript files needed types and went without: a string `+` there may have become a mutant. */
function withoutTypes(report: Report): string | undefined {
  const { untyped } = report.types
  if (untyped.length === 0) return undefined
  return `${plural(untyped.length, 'TypeScript file')} without type information for \`+\` (${untyped[0]!.reason}); string concatenation there may be mutated`
}

function where(report: Report, file: string, line: number, column?: number): string {
  const relative = path.relative(report.gitRoot, file)
  return column === undefined ? `${relative}:${line}` : `${relative}:${line}:${column}`
}

/** Why a failing mutant goes unnoticed, when the profile says nothing more. run() gives it as the `reason`. */
export const EXPLAIN: Readonly<Record<'Survived' | 'NoCoverage', string>> = {
  Survived: 'every test still passes with this change',
  NoCoverage: 'no test runs this code',
}

/** Why a suppressed mutant still fails as untested: a suppression only ignores survivors. */
export const UNTESTED_SUPPRESSION = 'no test runs this code, and a suppression does not apply to untested code'

/** The profile's reason when it has one: it says what the tests never do. */
function explain(r: MutantResult): string {
  return r.reason ?? EXPLAIN[r.status as keyof typeof EXPLAIN]
}

export function formatText(report: Report): string {
  const lines: string[] = []
  const n = report.results.length
  if (n === 0) {
    lines.push('nyorori: no mutants in the changed code.')
  } else if (report.dryRun) {
    lines.push(`nyorori: ${plural(n, 'mutant')} in ${plural(report.files.length, 'changed file')} (dry run)`)
    for (const r of report.results) lines.push(`  ${where(report, r.file, r.line, r.column)}  ${r.operator}  ${r.description}`)
  } else {
    lines.push(`nyorori: ${plural(n, 'mutant')} in ${plural(report.files.length, 'changed file')}: ${counts(report)}`)
    for (const r of failures(report)) {
      lines.push(`  ${r.status.padEnd(10)} ${where(report, r.file, r.line, r.column)}  ${r.operator}  ${r.description}  (${explain(r)})`)
    }
  }
  if (report.equivalent.length > 0) lines.push(`  ${droppedAsEquivalent(report)}`)
  for (const line of skipped(report)) lines.push(`  ${line}`)
  if (report.unnecessary.length > 0) lines.push(`  ${unnecessary(report)}`)
  for (const { mutant: m, claim, reason, status } of mispredicted(report)) {
    lines.push(`  MISPREDICT ${where(report, m.file, m.line, m.column)}  ${m.operator}  ${m.description}  (${claim}: ${reason}; ${status} when run)`)
  }
  const untyped = withoutTypes(report)
  if (untyped) lines.push(`  ${untyped}`)
  for (const s of report.suppressions.filter((s) => s.isNew)) {
    lines.push(`  NEW IGNORE ${where(report, s.file, s.line)}  ${s.operators.join(', ')} -- ${s.reason}`)
  }
  for (const p of report.problems) lines.push(`  PROBLEM    ${where(report, p.file, p.line)}  ${p.message}`)
  return lines.join('\n')
}

function escapeData(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C')
}

function command(kind: 'error' | 'warning', report: Report, file: string, line: number, column: number | undefined, title: string, message: string): string {
  const props = [`file=${escapeProperty(path.relative(report.gitRoot, file))}`, `line=${line}`]
  if (column !== undefined) props.push(`col=${column}`)
  props.push(`title=${escapeProperty(title)}`)
  return `::${kind} ${props.join(',')}::${escapeData(message)}`
}

/**
 * GitHub workflow commands; they show up on the PR diff without any token.
 * Unnecessary `?.` and `??` get none: they ask for nothing, and a mark on every
 * defensive `?.` a PR touches would bury the errors that do. The step summary lists them.
 */
export function formatAnnotations(report: Report): string[] {
  if (report.dryRun) return []
  const out: string[] = []
  for (const r of failures(report)) {
    const title = r.status === 'Survived' ? 'nyorori: mutant survived' : 'nyorori: changed code is not tested'
    const advice = r.status === 'NoCoverage'
      ? `No test runs this code, so the ${r.operator} mutant (${r.description}) goes unnoticed${r.suppression ? ', and its suppression does not apply to untested code' : ''}. Add a test that exercises it.`
      : r.reason !== undefined && r.reason !== EXPLAIN.Survived
        ? `No test fails when ${r.operator} changes this code (${r.description}): ${r.reason}. Add a test that checks this behavior.`
        : `No test fails when ${r.operator} changes this code (${r.description}). Add or strengthen a test that checks this behavior.`
    out.push(command('error', report, r.file, r.line, r.column, title, advice))
  }
  for (const s of report.suppressions.filter((s) => s.isNew)) {
    out.push(command('warning', report, s.file, s.line, undefined, 'nyorori: new suppression', `${s.operators.join(', ')} -- ${s.reason}`))
  }
  for (const p of report.problems) out.push(command('error', report, p.file, p.line, undefined, 'nyorori: suppression', p.message))
  return out
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

export function formatSummary(report: Report): string {
  const lines = ['## nyorori', '']
  const newSuppressions = report.suppressions.filter((s) => s.isNew)
  if (newSuppressions.length > 0) {
    lines.push(`> [!WARNING]`, `> This PR adds ${newSuppressions.length} suppression(s). Check that each reason holds.`, '')
    lines.push('| Location | Operators | Reason |', '|---|---|---|')
    for (const s of newSuppressions) {
      lines.push(`| \`${where(report, s.file, s.line)}\` | ${s.operators.join(', ')} | ${cell(s.reason)} |`)
    }
    lines.push('')
  }
  const failed = failures(report)
  if (report.results.length === 0) {
    lines.push('No mutants in the changed code.')
  } else if (failed.length === 0) {
    lines.push(`All ${report.results.length} mutants in the changed code are detected by tests (${counts(report)}).`)
  } else {
    lines.push(`**${failed.length} of ${report.results.length} mutants in the changed code go unnoticed by tests** (${counts(report)}).`, '')
    lines.push('| Status | Location | Operator | Change | Why |', '|---|---|---|---|---|')
    for (const r of failed) {
      lines.push(`| ${r.status} | \`${where(report, r.file, r.line, r.column)}\` | ${r.operator} | ${cell(r.description)} | ${cell(explain(r))} |`)
    }
  }
  if (report.equivalent.length > 0) lines.push('', `${droppedAsEquivalent(report)}.`)
  for (const line of skipped(report)) lines.push('', `${line}.`)
  if (report.unnecessary.length > 0) {
    lines.push('', '### Unnecessary by types', '')
    lines.push(
      "These `?.` and `??` guard values whose types say they can't be null or undefined, and no test passed null or undefined. " +
        'They are probably redundant defensive code: consider removing the `?.` or `??`. ' +
        'If the value really can be null or undefined (data from outside, `as`, `!`), add a test that passes it. They do not fail the check.',
      '',
    )
    lines.push('| Location | Operator | Change | Why |', '|---|---|---|---|')
    for (const m of report.unnecessary) {
      lines.push(`| \`${where(report, m.file, m.line, m.column)}\` | ${m.operator} | ${cell(m.description)} | ${cell(m.reason)} |`)
    }
  }
  const wrong = mispredicted(report)
  if (wrong.length > 0) {
    lines.push('', '### Wrong predictions', '', 'These mutants were run with `--no-predict`. The baseline profile said they would survive; tests may not be deterministic.', '')
    for (const { mutant: m, claim, reason, status } of wrong) {
      lines.push(`- \`${where(report, m.file, m.line, m.column)}\` ${m.operator} ${m.description}: ${status}, ${claim} (${reason})`)
    }
  }
  if (report.problems.length > 0) {
    lines.push('', '### Suppression problems', '')
    for (const p of report.problems) lines.push(`- \`${where(report, p.file, p.line)}\`: ${p.message}`)
  }
  return `${lines.join('\n')}\n`
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}
