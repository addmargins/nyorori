import { createRequire } from 'node:module';
import { gateResult } from './types.js';
import type {
  FileChange,
  FunctionUnit,
  GateResult,
  Match,
  MeasuredFile,
  Measurement,
  Policy,
  Snapshot,
  SourceFile,
  Trigger,
  Violation,
} from './types.js';

const require = createRequire(import.meta.url);
const unicode = require('unicode-confusables') as {
  rectifyConfusion(value: string): string;
  isConfusing(value: string): boolean;
};

interface Located {
  file: string;
  unit: FunctionUnit;
  parent?: FunctionUnit;
}
interface Statistics {
  count: number;
  cognitive: number;
  branches: number;
  maximum: number;
}

/** Traversal preserves cccc's source order and the original object identities. */
export function flattenUnits(file: MeasuredFile): FunctionUnit[] {
  const result: FunctionUnit[] = [];
  const pending = [...file.functions].reverse();
  while (pending.length) {
    const unit = pending.pop()!;
    result.push(unit);
    for (let index = unit.children.length - 1; index >= 0; index--)
      pending.push(unit.children[index]!);
  }
  return result;
}

function located(file: string, roots: FunctionUnit[]): Located[] {
  const result: Located[] = [];
  const visit = (units: FunctionUnit[], parent?: FunctionUnit): void => {
    for (const unit of units) {
      result.push({ file, unit, parent });
      visit(unit.children, unit);
    }
  };
  visit(roots);
  return result;
}

function segment(unit: FunctionUnit, siblings: FunctionUnit[]): string {
  const ordinal = siblings
    .slice(0, siblings.indexOf(unit))
    .filter((other) => other.name === unit.name).length;
  return `${encodeURIComponent(unit.name)}#${encodeURIComponent(unit.kind)}[${ordinal}]`;
}

function keys(path: string, roots: FunctionUnit[]): Map<FunctionUnit, string> {
  const result = new Map<FunctionUnit, string>();
  const visit = (siblings: FunctionUnit[], chain: string[]): void => {
    const counts = new Map<string, number>();
    for (const unit of siblings) {
      const ordinal = counts.get(unit.name) ?? 0;
      counts.set(unit.name, ordinal + 1);
      const next = [
        ...chain,
        `${encodeURIComponent(unit.name)}#${encodeURIComponent(unit.kind)}[${ordinal}]`,
      ];
      result.set(unit, `${path}::${next.join('>')}`);
      visit(unit.children, next);
    }
  };
  visit(roots, []);
  return result;
}

/** Stable within a candidate blob; lines deliberately do not participate in identity. */
export function unitKey(path: string, unit: FunctionUnit, roots: FunctionUnit[]): string {
  if (unit.kind === 'module') return `${path}::<module>#module[0]`;
  const find = (siblings: FunctionUnit[], chain: string[]): string[] | undefined => {
    for (const current of siblings) {
      const next = [...chain, segment(current, siblings)];
      if (current === unit) return next;
      const result = find(current.children, next);
      if (result) return result;
    }
    return undefined;
  };
  const chain = find(roots, []);
  if (!chain) throw new Error('Unit is not part of its measured file');
  return `${path}::${chain.join('>')}`;
}

function countLines(content: string): number {
  return content.split(/\r\n|\n|\r/u).length;
}
function overlaps(start: number, end: number, hunkStart: number, hunkCount: number): boolean {
  if (hunkCount === 0) return false;
  return start <= hunkStart + hunkCount - 1 && end >= hunkStart;
}

/** cccc omits end lines. Use the next same-or-shallower declaration as a conservative end. */
export function changedUnits(
  change: FileChange,
  measured: MeasuredFile,
  side: 'B' | 'C',
): Set<FunctionUnit> {
  const result = new Set<FunctionUnit>();
  const source = side === 'B' ? change.before : change.after;
  if (!source) return result;
  const entries = located(measured.path, measured.functions);
  const depth = new Map<FunctionUnit, number>();
  for (const entry of entries)
    depth.set(entry.unit, entry.parent ? (depth.get(entry.parent) ?? 0) + 1 : 0);
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    let end = countLines(source.content);
    for (let next = index + 1; next < entries.length; next++) {
      const candidate = entries[next]!;
      if ((depth.get(candidate.unit) ?? 0) <= (depth.get(entry.unit) ?? 0)) {
        // Same-line siblings cannot be separated using cccc's output; all are touched.
        end = Math.max(entry.unit.line, candidate.unit.line - 1);
        break;
      }
    }
    if (
      change.hunks.some((hunk) =>
        overlaps(
          entry.unit.line,
          end,
          side === 'B' ? hunk.oldStart : hunk.newStart,
          side === 'B' ? hunk.oldCount : hunk.newCount,
        ),
      )
    )
      result.add(entry.unit);
  }
  return result;
}

function normalized(name: string): string {
  return name.normalize('NFKC');
}
function sameName(before: FunctionUnit, after: FunctionUnit): boolean {
  return before.name === after.name && normalized(before.name) === before.name;
}
function safeRename(before: FunctionUnit, after: FunctionUnit): boolean {
  if (normalized(before.name) !== before.name || normalized(after.name) !== after.name)
    return false;
  if (before.name === after.name) return true;
  // Homoglyph edits must never inherit a previous function's larger debt allowance.
  if (unicode.rectifyConfusion(before.name) === unicode.rectifyConfusion(after.name)) return false;
  return !(/[^\x00-\x7f]/u.test(after.name) && unicode.isConfusing(after.name));
}
function named(unit: FunctionUnit): boolean {
  return unit.name !== '' && unit.name !== '<anonymous>';
}
function inRange(line: number, start: number, count: number): boolean {
  return count > 0 && line >= start && line < start + count;
}
function shape(unit: FunctionUnit): string {
  const tree = (current: FunctionUnit): unknown[] => [
    current.kind,
    current.cognitive,
    current.cyclomatic,
    current.children.map(tree),
  ];
  return JSON.stringify(tree(unit));
}
function residue(file: MeasuredFile): FunctionUnit {
  const units = flattenUnits(file);
  return {
    name: '<module>',
    kind: 'module',
    line: 1,
    cognitive: file.cognitive - units.reduce((sum, unit) => sum + unit.cognitive, 0),
    cyclomatic: file.cyclomatic - units.reduce((sum, unit) => sum + unit.cyclomatic, 0),
    children: [],
  };
}
function usable(file: MeasuredFile | undefined): file is MeasuredFile {
  return Boolean(file && file.parse_errors.length === 0);
}

/** Conservative, one-to-one correspondence. No score-nearest matching or debt copying. */
export function matchUnits(snapshot: Snapshot, measurement: Measurement): Match[] {
  const matches: Match[] = [];
  const usedBefore = new Set<FunctionUnit>();
  const usedAfter = new Set<FunctionUnit>();
  const beforeClasses = new Map(
    snapshot.files
      .filter((change) => change.before)
      .map((change) => [change.before!.path, change.before!.classification]),
  );
  const afterClasses = new Map(
    snapshot.files
      .filter((change) => change.after)
      .map((change) => [change.after!.path, change.after!.classification]),
  );
  const add = (
    before: FunctionUnit,
    after: FunctionUnit,
    beforeFile: string,
    afterFile: string,
    method: Match['method'],
  ): void => {
    if (usedBefore.has(before) || usedAfter.has(after)) return;
    usedBefore.add(before);
    usedAfter.add(after);
    matches.push({ before, after, beforeFile, afterFile, method });
  };
  const siblings = (
    before: FunctionUnit[],
    after: FunctionUnit[],
    beforeFile: string,
    afterFile: string,
    change?: FileChange,
  ): void => {
    const local: Match[] = [];
    const pair = (b: FunctionUnit, c: FunctionUnit, method: Match['method']): void => {
      add(b, c, beforeFile, afterFile, method);
      local.push(matches[matches.length - 1]!);
    };
    // Unchanged declaration anchors, including original same-row source ordinals.
    if (change) {
      const currentRows = new Map<number, number>(),
        oldRows = new Map<number, number>();
      const anchors = new Map<string, FunctionUnit>();
      for (const c of after) {
        const ordinal = currentRows.get(c.line) ?? 0;
        currentRows.set(c.line, ordinal + 1);
        anchors.set(JSON.stringify([c.name, c.kind, c.line, ordinal]), c);
      }
      for (const b of before) {
        const ordinal = oldRows.get(b.line) ?? 0;
        oldRows.set(b.line, ordinal + 1);
        const mapped = change.lineMap.get(b.line);
        if (mapped === undefined) continue;
        const c = anchors.get(JSON.stringify([b.name, b.kind, mapped, ordinal]));
        if (c && !usedAfter.has(c) && sameName(b, c)) pair(b, c, 'anchor');
      }
    }
    // A declaration-changing hunk may pass identity only when its kind is uniquely 1:1.
    if (change)
      for (const hunk of change.hunks) {
        const old = before.filter(
          (b) => !usedBefore.has(b) && inRange(b.line, hunk.oldStart, hunk.oldCount),
        );
        const current = after.filter(
          (c) => !usedAfter.has(c) && inRange(c.line, hunk.newStart, hunk.newCount),
        );
        for (const kind of new Set(old.map((unit) => unit.kind))) {
          const bs = old.filter((unit) => unit.kind === kind);
          const cs = current.filter((unit) => unit.kind === kind);
          if (bs.length === 1 && cs.length === 1 && safeRename(bs[0]!, cs[0]!))
            pair(bs[0]!, cs[0]!, 'hunk');
        }
      }
    // Reordering within an already matched parent is permitted only for a unique name.
    const names = (units: FunctionUnit[], used: Set<FunctionUnit>): Map<string, FunctionUnit[]> => {
      const grouped = new Map<string, FunctionUnit[]>();
      for (const unit of units)
        if (!used.has(unit) && named(unit) && normalized(unit.name) === unit.name) {
          const key = JSON.stringify([unit.name, unit.kind]);
          const group = grouped.get(key);
          if (group) group.push(unit);
          else grouped.set(key, [unit]);
        }
      return grouped;
    };
    const oldNames = names(before, usedBefore),
      newNames = names(after, usedAfter);
    for (const [name, bs] of oldNames) {
      const cs = newNames.get(name);
      if (bs.length === 1 && cs?.length === 1) pair(bs[0]!, cs[0]!, 'name');
    }
    // An unmatched parent grants no matching privileges to its children.
    for (const match of local)
      siblings(match.before.children, match.after.children, beforeFile, afterFile, change);
  };
  for (const change of snapshot.files) {
    if (
      !change.oldPath ||
      !change.newPath ||
      !change.before ||
      !change.after ||
      change.before.classification !== change.after.classification ||
      change.status.startsWith('T') ||
      change.status.startsWith('C')
    )
      continue;
    const b = measurement.base[change.oldPath];
    const c = measurement.candidate[change.newPath];
    if (!usable(b) || !usable(c)) continue;
    siblings(b.functions, c.functions, b.path, c.path, change);
    add(residue(b), residue(c), b.path, c.path, 'module');
  }
  // Whole top-level units can move across files, but signatures must be globally unique.
  const oldRoots = Object.values(measurement.base)
    .filter(usable)
    .flatMap((file) =>
      file.functions
        .filter((unit) => !usedBefore.has(unit) && named(unit))
        .map((unit) => ({ file: file.path, unit })),
    );
  const newRoots = Object.values(measurement.candidate)
    .filter(usable)
    .flatMap((file) =>
      file.functions
        .filter((unit) => !usedAfter.has(unit) && named(unit))
        .map((unit) => ({ file: file.path, unit })),
    );
  const signature = (unit: FunctionUnit): string => JSON.stringify([unit.name, shape(unit)]);
  const group = (
    items: { file: string; unit: FunctionUnit }[],
  ): Map<string, { file: string; unit: FunctionUnit }[]> => {
    const grouped = new Map<string, { file: string; unit: FunctionUnit }[]>();
    for (const item of items) {
      const key = signature(item.unit);
      const existing = grouped.get(key);
      if (existing) existing.push(item);
      else grouped.set(key, [item]);
    }
    return grouped;
  };
  const oldGroups = group(oldRoots),
    newGroups = group(newRoots);
  const movedChildren = (
    before: FunctionUnit[],
    after: FunctionUnit[],
    beforeFile: string,
    afterFile: string,
  ): void => {
    for (let index = 0; index < before.length; index++) {
      const b = before[index]!,
        c = after[index];
      if (!c || !sameName(b, c) || shape(b) !== shape(c)) continue;
      add(b, c, beforeFile, afterFile, 'move');
      movedChildren(b.children, c.children, beforeFile, afterFile);
    }
  };
  for (const old of oldRoots) {
    if (usedBefore.has(old.unit) || normalized(old.unit.name) !== old.unit.name) continue;
    const key = signature(old.unit);
    const bs = oldGroups.get(key)!;
    const cs = newGroups.get(key) ?? [];
    if (
      bs.length !== 1 ||
      cs.length !== 1 ||
      old.file === cs[0]!.file ||
      beforeClasses.get(old.file) !== afterClasses.get(cs[0]!.file) ||
      !sameName(old.unit, cs[0]!.unit)
    )
      continue;
    const current = cs[0]!;
    add(old.unit, current.unit, old.file, current.file, 'move');
    movedChildren(old.unit.children, current.unit.children, old.file, current.file);
  }
  return matches;
}

function stats(file: MeasuredFile | undefined): Statistics {
  if (!usable(file)) return { count: 0, cognitive: 0, branches: 0, maximum: 0 };
  const units = flattenUnits(file);
  return {
    count: units.filter(
      (unit) => !(unit.cyclomatic === 1 && unit.cognitive === 0 && unit.children.length === 0),
    ).length,
    cognitive: file.cognitive,
    branches: units.reduce((sum, unit) => sum + unit.cyclomatic - 1, 0) + residue(file).cyclomatic,
    maximum: units.reduce(
      (maximum, unit) => Math.max(maximum, unit.cognitive),
      Math.max(0, residue(file).cognitive),
    ),
  };
}
function inclusive(unit: FunctionUnit): number {
  return unit.cognitive + unit.children.reduce((sum, child) => sum + inclusive(child), 0);
}
function pushTrigger(triggers: Trigger[], trigger: Trigger): void {
  if (
    !triggers.some(
      (item) =>
        item.id === trigger.id && item.file === trigger.file && item.evidence === trigger.evidence,
    )
  )
    triggers.push(trigger);
}
function measuredSource(file: SourceFile | undefined): file is SourceFile {
  return file?.classification === 'source' || file?.classification === 'test';
}

export function evaluateComplexity(
  snapshot: Snapshot,
  measurement: Measurement,
  policy: Policy,
): GateResult {
  const result = gateResult('complexity', policy);
  result.issues = [...snapshot.issues, ...measurement.issues];
  if (
    measurement.fingerprint.cccc_sha256.toLowerCase() !== policy.measurement.sha256.toLowerCase() ||
    measurement.fingerprint.cccc_version !== policy.measurement.version ||
    measurement.fingerprint.policy_revision !== policy.revision
  )
    result.issues.push({
      code: 'MEASURER_MISMATCH',
      message: 'Measurement fingerprint does not match the selected policy',
    });
  const matches = matchUnits(snapshot, measurement);
  const byCandidate = new Map(
    matches.filter((match) => match.method !== 'module').map((match) => [match.after, match]),
  );
  const matchedBefore = new Set(matches.map((match) => match.before));
  const oldUnits = Object.values(measurement.base)
    .filter(usable)
    .flatMap((file) => located(file.path, file.functions));
  const reportUnits: Record<string, unknown>[] = [];
  const testViolations: Violation[] = [];
  const ccHigh: Record<string, unknown>[] = [];
  const nearLimit: Record<string, unknown>[] = [];
  const identifiers: Record<string, unknown>[] = [];
  const unmatched: Record<string, unknown>[] = [];
  const threshold = policy.limits.cognitive;
  let candidateCount = 0;
  const redistribution: (
    before: Statistics,
    after: Statistics,
    file: string,
    crossed: boolean,
    observeOnly: boolean,
  ) => void = (before, after, file, crossed, observeOnly) => {
    if (
      after.branches >= before.branches - 2 &&
      after.count - before.count >= 3 &&
      (before.maximum - after.maximum >= 5 || crossed)
    )
      pushTrigger(result.triggers, {
        id: 'S1',
        file,
        evidence: `Visible branches ${before.branches}→${after.branches}; nontrivial units ${before.count}→${after.count}; maximum CogC ${before.maximum}→${after.maximum}`,
        observe_only: observeOnly,
      });
  };
  const totalBefore: Statistics = {
    count: 0,
    cognitive: 0,
    branches: 0,
    maximum: 0,
  };
  const totalAfter: Statistics = {
    count: 0,
    cognitive: 0,
    branches: 0,
    maximum: 0,
  };
  let anyCrossed = false;
  const observedFiles = new Set<string>();
  for (const change of snapshot.files) {
    const before = change.oldPath ? measurement.base[change.oldPath] : undefined;
    const after = change.newPath ? measurement.candidate[change.newPath] : undefined;
    // The adapter deliberately reuses no output for identical bytes with unchanged scope.
    if (
      change.before &&
      change.after &&
      change.before.blob_sha === change.after.blob_sha &&
      change.before.classification === change.after.classification &&
      !before &&
      !after
    )
      continue;
    if (measuredSource(change.before) && !before)
      result.issues.push({
        code: 'MANIFEST_MISMATCH',
        file: change.before.path,
        message: 'Baseline source is missing from measurement',
      });
    if (measuredSource(change.after) && !after)
      result.issues.push({
        code: 'MANIFEST_MISMATCH',
        file: change.after.path,
        message: 'Candidate source is missing from measurement',
      });
    if (after?.parse_errors.length)
      result.issues.push({
        code: 'PARSE_ERROR_CANDIDATE',
        file: after.path,
        message: after.parse_errors.join('; '),
      });
    if (!measuredSource(change.after) || !usable(after)) continue;
    candidateCount++;
    const isTest = change.after.classification === 'test';
    const touched = changedUnits(change, after, 'C');
    const touchedBefore = usable(before)
      ? changedUnits(change, before, 'B')
      : new Set<FunctionUnit>();
    const roots = after.functions;
    const unitKeys = keys(after.path, roots);
    const children = new Set(
      located(after.path, roots)
        .filter((entry) => entry.parent)
        .map((entry) => entry.unit),
    );
    const units = flattenUnits(after);
    const module = residue(after);
    if (
      module.cognitive < 0 ||
      module.cyclomatic < 0 ||
      !Number.isSafeInteger(module.cognitive) ||
      !Number.isSafeInteger(module.cyclomatic)
    )
      result.issues.push({
        code: 'INVARIANT_VIOLATION',
        file: after.path,
        message:
          'Candidate file totals are smaller than the sum of its units or outside safe integer range',
      });
    if (usable(before)) {
      const oldResidue = residue(before);
      if (
        oldResidue.cognitive < 0 ||
        oldResidue.cyclomatic < 0 ||
        !Number.isSafeInteger(oldResidue.cognitive) ||
        !Number.isSafeInteger(oldResidue.cyclomatic)
      )
        result.issues.push({
          code: 'INVARIANT_VIOLATION',
          file: before.path,
          message: 'Baseline file totals violate nonnegative residue invariant',
        });
      if (
        flattenUnits(before).length >= 4 &&
        units.length === 0 &&
        change.before &&
        countLines(change.after.content) >= countLines(change.before.content) / 2
      )
        result.issues.push({
          code: 'UNITS_VANISHED',
          file: after.path,
          message:
            'At least four baseline units disappeared without the file becoming less than half as long',
        });
    }
    const moduleMatch = matches.find(
      (match) => match.method === 'module' && match.afterFile === after.path,
    );
    const all = [...units, module];
    for (const unit of all) {
      const match = unit === module ? moduleMatch : byCandidate.get(unit);
      const isChanged =
        unit === module
          ? !match || change.hunks.length > 0 || match.before.cognitive !== unit.cognitive
          : !match ||
            touched.has(unit) ||
            touchedBefore.has(match.before) ||
            match.before.cognitive !== unit.cognitive ||
            match.before.cyclomatic !== unit.cyclomatic;
      const key = unit === module ? unitKey(after.path, unit, roots) : unitKeys.get(unit)!;
      const baseline = match?.before.cognitive ?? null;
      const limit = baseline === null ? threshold : Math.max(threshold, baseline);
      const included = inclusive(unit);
      reportUnits.push({
        unit: key,
        file: after.path,
        line: unit.line,
        cognitive: unit.cognitive,
        cyclomatic_observe: unit.cyclomatic,
        inclusive_cognitive: included,
        before: baseline,
        limit,
        changed: isChanged,
        legacy_debt: baseline !== null && baseline > threshold,
        match_method: match?.method ?? null,
        test_only: isTest,
        blob_sha: change.after.blob_sha,
      });
      if (!isChanged) continue;
      if (unit.cyclomatic >= 20)
        ccHigh.push({
          unit: key,
          file: after.path,
          line: unit.line,
          cyclomatic: unit.cyclomatic,
        });
      if (unit.cognitive > limit) {
        const candidates = !match
          ? oldUnits.filter(
              (old) =>
                !matchedBefore.has(old.unit) &&
                old.unit.kind === unit.kind &&
                old.unit.cognitive > threshold &&
                (old.file === change.oldPath || old.unit.name === unit.name),
            )
          : [];
        const ambiguous = candidates.length > 0;
        const reason = match
          ? baseline! > threshold
            ? 'LEGACY_WORSENED'
            : 'OVER_LIMIT'
          : ambiguous
            ? 'UNMATCHED_OVER_BUDGET'
            : 'OVER_LIMIT_NEW';
        const violation: Violation = {
          unit: key,
          file: after.path,
          line: unit.line,
          metric: 'cognitive',
          before: baseline,
          after: unit.cognitive,
          limit,
          reason,
          blob_sha: change.after.blob_sha,
          inclusive_cognitive: included,
          cyclomatic_observe: unit.cyclomatic,
        };
        if (isTest) testViolations.push(violation);
        else result.violations.push(violation);
        if (ambiguous)
          unmatched.push({
            unit: key,
            candidate_count: candidates.length,
            candidates: candidates.slice(0, 20).map((old) => ({
              unit: unitKey(old.file, old.unit, measurement.base[old.file]!.functions),
              file: old.file,
              line: old.unit.line,
              cognitive: old.unit.cognitive,
            })),
          });
      }
      if (match && match.before.cognitive > threshold)
        pushTrigger(result.triggers, {
          id: 'S5',
          file: after.path,
          evidence: `${key}: legacy CogC ${match.before.cognitive}→${unit.cognitive}${match.method === 'hunk' || match.method === 'name' ? '; identity-changed' : ''}; changed unit range`,
          observe_only: isTest,
        });
      if (
        unit !== module &&
        ((unit.name === '<anonymous>' && children.has(unit) && unit.cognitive >= 8) ||
          (unit.cognitive <= threshold && included > 25))
      )
        pushTrigger(result.triggers, {
          id: 'S2',
          file: after.path,
          evidence: `${key}: own CogC ${unit.cognitive}, inclusive CogC ${included}`,
          observe_only: isTest,
        });
      if (
        !match &&
        unit !== module &&
        unit.cognitive >= Math.max(0, threshold - 3) &&
        unit.cognitive <= threshold
      ) {
        nearLimit.push({
          unit: key,
          file: after.path,
          line: unit.line,
          cognitive: unit.cognitive,
        });
        pushTrigger(result.triggers, {
          id: 'S8',
          file: after.path,
          evidence: `${key}: new CogC ${unit.cognitive} is near limit ${threshold}`,
          observe_only: true,
        });
      }
      if (
        unit !== module &&
        (normalized(unit.name) !== unit.name ||
          (/[^\x00-\x7f]/u.test(unit.name) && unicode.isConfusing(unit.name)))
      )
        identifiers.push({
          unit: key,
          file: after.path,
          name: unit.name,
          matched: Boolean(match),
          reason: 'IDENTIFIER_CONFUSABLE',
        });
    }
    const b = stats(before),
      c = stats(after);
    const crossed = matches.some(
      (match) =>
        match.afterFile === after.path &&
        match.before.cognitive > threshold &&
        match.after.cognitive <= threshold,
    );
    redistribution(b, c, after.path, crossed, isTest);
    const newCount = units.filter(
      (unit) =>
        !byCandidate.has(unit) &&
        !(unit.cyclomatic === 1 && unit.cognitive === 0 && unit.children.length === 0),
    ).length;
    if (c.count / (c.cognitive + 1) >= 0.6 && newCount >= 5)
      pushTrigger(result.triggers, {
        id: 'S10',
        file: after.path,
        evidence: `Nontrivial unit/CogC density ${(c.count / (c.cognitive + 1)).toFixed(3)}; ${newCount} new nontrivial units`,
        observe_only: isTest,
      });
    if (!isTest) {
      observedFiles.add(after.path);
      anyCrossed ||= crossed;
      for (const field of ['count', 'cognitive', 'branches'] as const) {
        totalBefore[field] += b[field];
        totalAfter[field] += c[field];
      }
      totalBefore.maximum = Math.max(totalBefore.maximum, b.maximum);
      totalAfter.maximum = Math.max(totalAfter.maximum, c.maximum);
    }
  }
  // Deleted files matter to PR-wide redistribution, including splitting one file into several.
  for (const change of snapshot.files)
    if (change.before?.classification === 'source' && !change.after && change.oldPath) {
      const b = stats(measurement.base[change.oldPath]);
      for (const field of ['count', 'cognitive', 'branches'] as const)
        totalBefore[field] += b[field];
      totalBefore.maximum = Math.max(totalBefore.maximum, b.maximum);
    }
  if (observedFiles.size > 1)
    redistribution(totalBefore, totalAfter, '<pull-request>', anyCrossed, false);
  result.observe = {
    units: reportUnits,
    cc_ge_20: ccHigh,
    s8_near_limit: nearLimit,
    test_over_budget: testViolations,
    identifier_warnings: identifiers,
    unmatched_candidates: unmatched,
    statistics: { before: totalBefore, after: totalAfter },
  };
  result.reasons = [
    ...new Set([
      ...result.violations.map((violation) => violation.reason),
      ...result.issues.map((issue) => issue.code),
    ]),
  ].sort();
  result.state = result.violations.length
    ? 'FAIL'
    : result.issues.length
      ? 'INCONCLUSIVE'
      : candidateCount
        ? 'PASS'
        : 'NOT_APPLICABLE';
  result.violations.sort(
    (a, b) =>
      a.file.localeCompare(b.file, 'en') || a.line - b.line || a.unit.localeCompare(b.unit, 'en'),
  );
  result.triggers.sort(
    (a, b) =>
      a.id.localeCompare(b.id, 'en', { numeric: true }) ||
      a.file.localeCompare(b.file, 'en') ||
      a.evidence.localeCompare(b.evidence, 'en'),
  );
  return result;
}
