// Cycle detection on runtime module edges.
//
// "New cycle" is decided per edge rather than by comparing cycle lists:
// every edge inside a strongly connected component lies on some cycle, and a
// cycle made only of edges that already existed in B already existed in B.
// So C has a new elementary cycle exactly when an edge absent from B lies
// inside a cyclic SCC of C. This is polynomial (elementary cycles are not)
// and needs no rotation normalisation.

export type Adjacency = ReadonlyMap<string, readonly string[]>;

export function adjacency(edges: Iterable<{ from: string; to: string }>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const list = out.get(e.from) ?? [];
    if (!list.includes(e.to)) list.push(e.to);
    out.set(e.from, list);
  }
  return out;
}

/** Tarjan's algorithm, iterative so deep import chains cannot overflow the stack. */
export function stronglyConnectedComponents(nodes: Iterable<string>, adj: Adjacency): Map<string, number> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const component = new Map<string, number>();
  let counter = 0;
  let componentId = 0;

  for (const root of [...nodes].sort()) {
    if (index.has(root)) continue;
    const work: Array<{ node: string; next: number }> = [{ node: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const succ = adj.get(frame.node) ?? [];
      if (frame.next < succ.length) {
        const w = succ[frame.next++]!;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter++);
          stack.push(w);
          onStack.add(w);
          work.push({ node: w, next: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(w)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) === index.get(frame.node)) {
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.set(w, componentId);
        } while (w !== frame.node);
        componentId++;
      }
    }
  }
  return component;
}

export interface NewCycle {
  /** Sorted members of the C component the new edges belong to. */
  members: string[];
  /** Edges of C inside the component that B did not have. */
  newEdges: Array<{ from: string; to: string }>;
  /** One concrete cycle through the first new edge, starting and ending at its source. */
  witness: string[];
}

/** Shortest path from `start` to `goal` using only nodes in `allowed`. */
function shortestPath(adj: Adjacency, start: string, goal: string, allowed: ReadonlySet<string>): string[] | null {
  const prev = new Map<string, string | null>([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const n = queue.shift()!;
    if (n === goal) {
      const path: string[] = [];
      for (let c: string | null = n; c !== null; c = prev.get(c) ?? null) path.unshift(c);
      return path;
    }
    for (const m of adj.get(n) ?? []) {
      if (allowed.has(m) && !prev.has(m)) {
        prev.set(m, n);
        queue.push(m);
      }
    }
  }
  return null;
}

/**
 * @param toB maps a C path to its B path (identity for unchanged files,
 *            rename source for renames, undefined for added files).
 */
export function findNewCycles(
  nodesC: Iterable<string>,
  edgesC: ReadonlyArray<{ from: string; to: string }>,
  edgesB: ReadonlyArray<{ from: string; to: string }>,
  toB: (cPath: string) => string | undefined,
): NewCycle[] {
  const adjC = adjacency(edgesC);
  const comp = stronglyConnectedComponents(nodesC, adjC);
  const size = new Map<number, number>();
  for (const id of comp.values()) size.set(id, (size.get(id) ?? 0) + 1);
  const bEdges = new Set(edgesB.map((e) => `${e.from}\u0000${e.to}`));

  const byComponent = new Map<number, Array<{ from: string; to: string }>>();
  for (const [from, tos] of adjC) {
    for (const to of tos) {
      const id = comp.get(from);
      if (id === undefined || id !== comp.get(to)) continue;
      if (from !== to && size.get(id)! < 2) continue;
      const bf = toB(from);
      const bt = toB(to);
      if (bf !== undefined && bt !== undefined && bEdges.has(`${bf}\u0000${bt}`)) continue;
      const list = byComponent.get(id) ?? [];
      list.push({ from, to });
      byComponent.set(id, list);
    }
  }

  const out: NewCycle[] = [];
  for (const [id, newEdges] of byComponent) {
    const members = [...comp].filter(([, c]) => c === id).map(([n]) => n).sort();
    newEdges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    const first = newEdges[0]!;
    const back = first.from === first.to ? [first.to] : shortestPath(adjC, first.to, first.from, new Set(members));
    out.push({ members, newEdges, witness: [first.from, ...(back ?? [first.to])] });
  }
  return out.sort((a, b) => a.members[0]!.localeCompare(b.members[0]!));
}

/** Members of every cyclic SCC (size ≥ 2, or a self-import), each sorted. */
export function cyclicComponents(nodes: Iterable<string>, edges: ReadonlyArray<{ from: string; to: string }>): string[][] {
  const adj = adjacency(edges);
  const comp = stronglyConnectedComponents(nodes, adj);
  const members = new Map<number, string[]>();
  for (const [n, id] of comp) {
    const list = members.get(id) ?? [];
    list.push(n);
    members.set(id, list);
  }
  return [...members.values()]
    .filter((m) => m.length > 1 || (adj.get(m[0]!) ?? []).includes(m[0]!))
    .map((m) => m.sort())
    .sort((a, b) => a[0]!.localeCompare(b[0]!));
}

/**
 * Ruling D7: the cyclic part of the graph changed when a C component holds a
 * module that is new, was acyclic in B, or came from a different B component
 * (a merge). A component that equals or shrank from a B component did not.
 */
export function changedComponents(
  componentsC: readonly string[][],
  componentsB: readonly string[][],
  toB: (cPath: string) => string | undefined,
): string[][] {
  const bComponentOf = new Map<string, number>();
  componentsB.forEach((members, i) => members.forEach((m) => bComponentOf.set(m, i)));
  return componentsC.filter((members) => {
    const ids = new Set<number | undefined>(members.map((m) => {
      const b = toB(m);
      return b === undefined ? undefined : bComponentOf.get(b);
    }));
    return ids.size !== 1 || ids.has(undefined);
  });
}
