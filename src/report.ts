import path from 'node:path'
import type { Report } from './run.ts'
import type { Mutant, MutantResult, MutantStatus, NotJudgedFile, NotJudgedReason } from './types.ts'

const FAILING: ReadonlySet<MutantStatus> = new Set(['Survived', 'NoCoverage'])

export function failures(report: Report): MutantResult[] {
  return report.results.filter((r) => FAILING.has(r.status))
}

export function exitCode(report: Report): 0 | 1 | 2 {
  if (report.dryRun) return 0
  if (unsupported(report).length > 0) return 2
  return failures(report).length > 0 || report.problems.length > 0 ? 1 : 0
}

/** Why each changed file was not judged, as the step summary lists them. */
const WHY: Readonly<Record<NotJudgedReason, string>> = {
  unsupported: 'a file type nyorori cannot mutate',
  'outside-root': 'outside the Vitest root',
  'coverage-include': 'not in coverage.include',
  'coverage-exclude': 'in coverage.exclude',
  excluded: 'matches --exclude',
  test: 'test, type test, benchmark or setup file',
  config: 'Vitest or Vite config',
  declaration: 'type declaration',
  node_modules: 'in node_modules',
  deleted: 'deleted',
}

/** The reasons that are only counted in the text: nyorori never mutates such files, or was told not to. */
const COUNTED: ReadonlyArray<[NotJudgedReason, (n: number) => string]> = [
  ['test', (n) => plural(n, 'test file')],
  ['config', (n) => plural(n, 'config file')],
  ['declaration', (n) => plural(n, 'type declaration')],
  ['excluded', (n) => `${plural(n, 'file')} matching --exclude`],
  ['deleted', (n) => plural(n, 'deleted file')],
  ['node_modules', (n) => `${plural(n, 'file')} in node_modules`],
]

/** Changed files of a type nyorori cannot mutate. Unless --exclude leaves them out, the run judges nothing and exits with 2. */
function unsupported(report: Report): NotJudgedFile[] {
  return report.notJudged.filter((f) => f.reason === 'unsupported')
}

/** Globs that leave the unsupported files out: one for each extension. */
function excludeGlobs(files: NotJudgedFile[]): string[] {
  return [...new Set(files.map((f) => `**/*${path.extname(f.file)}`))]
}

function unsupportedAdvice(files: NotJudgedFile[], markdown = false): string {
  const globs = excludeGlobs(files)
  const how = markdown
    ? `the \`exclude\` input (${globs.map((glob) => `\`${glob}\``).join(', ')})`
    : `${globs.map((glob) => `--exclude '${glob}'`).join(' ')} (the Action's \`exclude\` input)`
  return `nyorori mutates only JavaScript and TypeScript. Leave these files out with ${how} to judge the rest.`
}

/** Some of the files, so that a monorepo's other packages do not fill the output. */
function someOf(files: NotJudgedFile[]): string {
  const shown = files.slice(0, 5).map((f) => f.file).join(', ')
  return files.length > 5 ? `${shown} and ${files.length - 5} more` : shown
}

/**
 * Changed source files the Vitest config leaves out. They do not fail the
 * run: a monorepo job sees the other packages' changes outside its root. But
 * a coverage.include that matches nothing passes every PR without a word.
 */
export function notJudgedWarnings(report: Report): string[] {
  const of = (reason: NotJudgedReason) => report.notJudged.filter((f) => f.reason === reason)
  const was = (files: unknown[]) => (files.length === 1 ? 'was' : 'were')
  const warnings: string[] = []
  const outside = of('outside-root')
  if (outside.length > 0) {
    warnings.push(`${plural(outside.length, 'changed source file')} outside the Vitest root ${was(outside)} not judged: ${someOf(outside)}`)
  }
  const notIncluded = of('coverage-include')
  // No other file got past coverage.include: judged, in coverage.exclude, or a component.
  const matchesNone = report.judged.length === 0 && !report.notJudged.some((f) => f.reason === 'coverage-exclude' || f.reason === 'unsupported')
  if (notIncluded.length > 0 && matchesNone) {
    warnings.push(`coverage.include in the Vitest config matches none of the changed source files, so none was judged: ${someOf(notIncluded)}`)
  } else if (notIncluded.length > 0) {
    warnings.push(`${plural(notIncluded.length, 'changed source file')} not in coverage.include of the Vitest config ${was(notIncluded)} not judged: ${someOf(notIncluded)}`)
  }
  const excluded = of('coverage-exclude')
  if (excluded.length > 0) {
    warnings.push(`${plural(excluded.length, 'changed source file')} in coverage.exclude of the Vitest config ${was(excluded)} not judged: ${someOf(excluded)}`)
  }
  return warnings
}

/** One line that counts the rest, e.g. "Not judged: 2 test files, 1 deleted file". */
function notJudgedCount(report: Report): string | undefined {
  const parts = COUNTED.map(([reason, count]) => [report.notJudged.filter((f) => f.reason === reason).length, count] as const)
    .filter(([n]) => n > 0)
    .map(([n, count]) => count(n))
  return parts.length > 0 ? `Not judged: ${parts.join(', ')}` : undefined
}

/** Why there are no results, or undefined when there are. */
function noResults(report: Report): string | undefined {
  const stopped = unsupported(report)
  if (stopped.length > 0 && !report.dryRun) return `${plural(stopped.length, 'changed file')} of a type nyorori cannot mutate, so nothing was judged`
  if (report.results.length > 0) return undefined
  if (report.judged.length > 0) return `no mutants in the changed code of ${plural(report.judged.length, 'judged file')}`
  return report.notJudged.length > 0 ? 'no changed source files were judged' : 'no changed source files to judge'
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
  const none = noResults(report)
  if (none !== undefined) {
    lines.push(`nyorori: ${none}.`)
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
  const stopped = unsupported(report)
  for (const f of stopped) lines.push(`  NOT JUDGED ${f.file}  (${WHY.unsupported})`)
  if (stopped.length > 0) lines.push(`  ${unsupportedAdvice(stopped)}`)
  for (const warning of notJudgedWarnings(report)) lines.push(`  WARNING    ${warning}`)
  const counted = notJudgedCount(report)
  if (counted) lines.push(`  ${counted}`)
  return lines.join('\n')
}

function escapeData(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
}

function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C')
}

function command(kind: 'error' | 'warning', report: Report, file: string | undefined, line: number | undefined, column: number | undefined, title: string, message: string): string {
  const props: string[] = []
  if (file !== undefined) props.push(`file=${escapeProperty(path.relative(report.gitRoot, file))}`)
  if (line !== undefined) props.push(`line=${line}`)
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
  for (const f of unsupported(report)) {
    const [glob] = excludeGlobs([f])
    const message = `nyorori cannot mutate ${path.extname(f.file)} files, so this change was not judged. Leave such files out with the exclude input (for example ${glob}) to judge the rest.`
    out.push(command('error', report, path.join(report.gitRoot, f.file), undefined, undefined, 'nyorori: file type not supported', message))
  }
  // One for each kind, without a file: a monorepo's other packages are not this job's to fix.
  for (const warning of notJudgedWarnings(report)) out.push(command('warning', report, undefined, undefined, undefined, 'nyorori: changed files not judged', warning))
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
  const none = noResults(report)
  const stopped = unsupported(report)
  if (none !== undefined) {
    lines.push(`${none[0]!.toUpperCase()}${none.slice(1)}.`)
    if (stopped.length > 0 && !report.dryRun) lines.push('', unsupportedAdvice(stopped, true))
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
  if (report.notJudged.length > 0) {
    lines.push('', '### Not judged', '')
    for (const warning of notJudgedWarnings(report)) lines.push('> [!WARNING]', `> ${warning}`, '')
    // Test files and the like are counted, as in the text: a large PR would list every spec.
    const listed = report.notJudged.filter((f) => !COUNTED.some(([reason]) => reason === f.reason))
    if (listed.length > 0) lines.push('| File | Why |', '|---|---|')
    for (const f of listed) lines.push(`| \`${cell(f.file)}\` | ${f.reason === 'unsupported' ? `**${WHY[f.reason]}**` : WHY[f.reason]} |`)
    const counted = notJudgedCount(report)
    if (counted) lines.push(...(listed.length > 0 ? [''] : []), `${counted}.`)
  }
  return `${lines.join('\n')}\n`
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}
