/**
 * Tarjan's strongly-connected-components for the task graph. Returns SCCs of size > 1
 * and any self-edges. Each entry is a list of task IDs in the cycle order.
 */
export function findCycles(graph: Map<string, string[]>): string[][] {
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let index = 0;

  const strongconnect = (v: string): void => {
    indices.set(v, index);
    lowlinks.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);

    const succ = graph.get(v) ?? [];
    for (const w of succ) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v) ?? 0, lowlinks.get(w) ?? 0));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v) ?? 0, indices.get(w) ?? 0));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        if (w === undefined) break;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) sccs.push(scc.reverse());
      else if (scc.length === 1 && (graph.get(scc[0] as string) ?? []).includes(scc[0] as string)) {
        sccs.push([scc[0] as string, scc[0] as string]);
      }
    }
  };

  for (const v of graph.keys()) {
    if (!indices.has(v)) strongconnect(v);
  }

  return sccs;
}
