// Turns one cccc file report into the unit tree the gates reason about
// (spec 5.1): every function at every depth with its own score, the
// `<module>` residue, inclusive CogC and an approximate scope end line.

import {
  RESIDUE_NAME,
  type CcccFile,
  type CcccFunction,
  type FileMeasurement,
  type Side,
  type Unit,
} from "../types.js";

const ANONYMOUS = "<anonymous>";

/**
 * Escapes one name-chain element so a string-literal name such as `"g>f"`
 * or `"a::b"` cannot reproduce another unit's key (audit F1). Ordinary
 * identifiers stay readable; cccc's `<anonymous>` is the only raw `<`.
 */
export function escapeKeyPart(name: string): string {
  if (name === ANONYMOUS) return name;
  return name.replace(/[%<>#[\]:]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

export function unitKey(path: string, nameChain: string[], kind: string, ordinal: number): string {
  return `${path}::${nameChain.map(escapeKeyPart).join(">")}#${kind}[${ordinal}]`;
}

export function residueKey(path: string): string {
  return `${path}::${RESIDUE_NAME}`;
}

function isSignatureOnly(f: CcccFunction): boolean {
  return f.cyclomatic === 1 && f.cognitive === 0 && (f.children?.length ?? 0) === 0;
}

function build(
  path: string,
  fns: CcccFunction[],
  depth: number,
  chain: string[],
  parentKey: string | null,
): Unit[] {
  const sameName = new Map<string, number>();
  const sameLine = new Map<number, number>();
  const out: Unit[] = [];
  for (const f of fns) {
    const nameKind = `${f.name}\u0000${f.kind}`;
    const ordinal = sameName.get(nameKind) ?? 0;
    sameName.set(nameKind, ordinal + 1);
    const lineOrdinal = sameLine.get(f.line) ?? 0;
    sameLine.set(f.line, lineOrdinal + 1);
    const nameChain = [...chain, f.name];
    const key = unitKey(path, nameChain, f.kind, ordinal);
    const children = build(path, f.children ?? [], depth + 1, nameChain, key);
    const inclusive = f.cognitive + children.reduce((s, c) => s + c.inclusiveCognitive, 0);
    out.push({
      key,
      path,
      name: f.name,
      kind: f.kind,
      line: f.line,
      lineOrdinal,
      sameNameOrdinal: ordinal,
      depth,
      cognitive: f.cognitive,
      cyclomatic: f.cyclomatic,
      inclusiveCognitive: inclusive,
      endLine: 0, // filled by assignEndLines
      signatureOnly: isSignatureOnly(f),
      isResidue: false,
      parentKey,
      children,
    });
  }
  return out;
}

/** Depth-first, parents before children, source order. */
export function flattenUnits(units: Unit[]): Unit[] {
  const out: Unit[] = [];
  const walk = (us: Unit[]) => {
    for (const u of us) {
      out.push(u);
      walk(u.children);
    }
  };
  walk(units);
  return out;
}

/**
 * cccc gives no end position. A unit's scope is approximated as its start
 * line up to the line before the next unit (in document order) whose depth is
 * the same or shallower; the last such unit extends to the end of the file.
 */
function assignEndLines(units: Unit[], lineCount: number): void {
  const flat = flattenUnits(units);
  for (let i = 0; i < flat.length; i++) {
    const u = flat[i]!;
    let end = Math.max(lineCount, u.line);
    for (let j = i + 1; j < flat.length; j++) {
      const v = flat[j]!;
      if (v.depth <= u.depth) {
        end = Math.max(u.line, v.line - 1);
        break;
      }
    }
    u.endLine = end;
  }
}

export function sumCognitive(units: Unit[]): number {
  return flattenUnits(units).reduce((s, u) => s + u.cognitive, 0);
}

export function sumCyclomatic(units: Unit[]): number {
  return flattenUnits(units).reduce((s, u) => s + u.cyclomatic, 0);
}

export function buildFileMeasurement(
  side: Side,
  logicalPath: string,
  blob: string,
  file: CcccFile,
  lineCount: number,
): FileMeasurement {
  const units = build(logicalPath, file.functions, 0, [], null);
  assignEndLines(units, lineCount);
  const residueCog = file.cognitive - sumCognitive(units);
  const residueCyc = file.cyclomatic - sumCyclomatic(units);
  const residue: Unit = {
    key: residueKey(logicalPath),
    path: logicalPath,
    name: RESIDUE_NAME,
    kind: "module",
    line: 1,
    lineOrdinal: 0,
    sameNameOrdinal: 0,
    depth: -1,
    cognitive: residueCog,
    cyclomatic: residueCyc,
    inclusiveCognitive: file.cognitive,
    endLine: lineCount,
    signatureOnly: false,
    isResidue: true,
    parentKey: null,
    children: [],
  };
  return {
    side,
    path: logicalPath,
    blob,
    units,
    residue,
    parseErrors: file.parse_errors ?? [],
    lineCount,
    totalCognitive: file.cognitive,
    totalCyclomatic: file.cyclomatic,
  };
}

/** Visible branches V = Σ(unit CC − 1) + residue CC (spec 7.2). */
export function visibleBranches(m: FileMeasurement): number {
  const fnPart = flattenUnits(m.units).reduce((s, u) => s + (u.cyclomatic - 1), 0);
  return fnPart + Math.max(0, m.residue.cyclomatic);
}

/**
 * A signature-only row (CC 1, CogC 0, no children) is an overload signature
 * only when a later sibling of the same name and kind follows it. Trivial
 * helpers look identical, and they are exactly what mechanical splitting
 * produces, so they must stay countable. Arrows are excluded because cccc
 * reuses property names for them.
 */
export function isOverloadSignature(u: Unit, siblings: readonly Unit[]): boolean {
  if (!overloadCandidate(u)) return false;
  const idx = siblings.indexOf(u);
  return siblings.some((s, i) => i > idx && s.name === u.name && s.kind === u.kind);
}

function overloadCandidate(u: Unit): boolean {
  return u.signatureOnly && u.name !== ANONYMOUS && (u.kind === "function" || u.kind === "method");
}

/** Units that count for S1/S10 unit totals (overload signatures excluded). Linear time. */
export function countableUnits(m: FileMeasurement): Unit[] {
  const out: Unit[] = [];
  const walk = (us: readonly Unit[]) => {
    // Right to left: a row is an overload when its (name, kind) appears later.
    const later = new Set<string>();
    const overload = new Array<boolean>(us.length).fill(false);
    for (let i = us.length - 1; i >= 0; i--) {
      const u = us[i]!;
      const k = `${u.name}\u0000${u.kind}`;
      overload[i] = overloadCandidate(u) && later.has(k);
      later.add(k);
    }
    us.forEach((u, i) => {
      if (!overload[i]) out.push(u);
      walk(u.children);
    });
  };
  walk(m.units);
  return out;
}
