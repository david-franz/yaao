/**
 * Pure DAG-shape helpers. Used by both the validator (to flag overly-wide
 * fan-out vs `max-parallel`) and the converter (to nudge authors away from
 * fully-linear chains where parallelism is left on the table). Operates on a
 * minimal `{id, depends}` shape so callers can pass either parsed `Task`s or
 * resolved task entries without converting.
 */

export interface DagNode {
  id: string;
  depends: readonly string[];
}

/**
 * Per-layer task counts, where layer 0 = roots (no deps) and layer N =
 * tasks whose deepest dep chain is N-1. Returned in layer order. Cycles are
 * tolerated (treated as layer 0); the validator reports them separately.
 */
export function computeLayerWidths(tasks: readonly DagNode[]): number[] {
  const idToTask = new Map(tasks.map((t) => [t.id, t]));
  const layer = new Map<string, number>();
  const compute = (id: string, seen: Set<string>): number => {
    if (layer.has(id)) return layer.get(id) as number;
    if (seen.has(id)) return 0;
    seen.add(id);
    const t = idToTask.get(id);
    if (!t || t.depends.length === 0) {
      layer.set(id, 0);
      return 0;
    }
    let max = 0;
    for (const d of t.depends) {
      const dl = compute(d, seen);
      if (dl + 1 > max) max = dl + 1;
    }
    layer.set(id, max);
    return max;
  };
  for (const t of tasks) compute(t.id, new Set());
  const widthsByLayer = new Map<number, number>();
  for (const l of layer.values()) widthsByLayer.set(l, (widthsByLayer.get(l) ?? 0) + 1);
  const maxLayer = widthsByLayer.size === 0 ? -1 : Math.max(...widthsByLayer.keys());
  const out: number[] = [];
  for (let i = 0; i <= maxLayer; i++) out.push(widthsByLayer.get(i) ?? 0);
  return out;
}

/**
 * True when the plan is a strict chain wider than two tasks. yaao runs every
 * ready task in parallel up to `max-parallel`, so a fully-linear plan leaves
 * that capacity on the table — wall-clock cost scales with the longest
 * dependency chain, not the task count. The two-task floor avoids nagging
 * trivially-small plans where serial ordering is the natural shape.
 */
export function isNarrowDag(tasks: readonly DagNode[]): boolean {
  if (tasks.length <= 2) return false;
  const widths = computeLayerWidths(tasks);
  return widths.length > 0 && widths.every((w) => w <= 1);
}
