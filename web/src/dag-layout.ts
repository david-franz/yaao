/**
 * Tiny topological-levels DAG layout. Each task sits in the column
 * `max(level(dep) for dep in depends) + 1`; siblings within a column
 * stack vertically in declared order. Good enough for the plan sizes
 * yaao plans naturally have (typically <40 tasks). For larger plans a
 * Sugiyama layouter is the right answer; ELK.js can land later behind
 * a checkbox in the DAG view without changing the data shape.
 */

export interface DagNode {
  id: string;
  title: string;
  agent: string;
  depends: string[];
}

export interface PositionedNode extends DagNode {
  x: number;
  y: number;
  width: number;
  height: number;
  level: number;
}

export interface DagEdge {
  fromId: string;
  toId: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

export interface DagLayout {
  nodes: PositionedNode[];
  edges: DagEdge[];
  width: number;
  height: number;
}

const NODE_WIDTH = 200;
const NODE_HEIGHT = 56;
const COL_GAP = 80;
const ROW_GAP = 24;
const MARGIN = 24;

export function layoutDag(nodes: DagNode[]): DagLayout {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const levels = new Map<string, number>();

  // Repeated relaxation: a node's level is max(dep level) + 1. Stop when
  // no level changes. The DAG is acyclic (yaao validates that before any
  // task ever runs) so this converges in O(nodes) iterations.
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes) {
      const depLevels = n.depends
        .map((d) => levels.get(d) ?? 0)
        .reduce((a, b) => Math.max(a, b), -1);
      const want = depLevels + 1;
      if ((levels.get(n.id) ?? -1) !== want) {
        // Only grow — never shrink, which avoids oscillation on diamond DAGs.
        if ((levels.get(n.id) ?? -1) < want) {
          levels.set(n.id, want);
          changed = true;
        }
      }
    }
  }

  // Bucket by level.
  const buckets = new Map<number, DagNode[]>();
  for (const n of nodes) {
    const lv = levels.get(n.id) ?? 0;
    const arr = buckets.get(lv) ?? [];
    arr.push(n);
    buckets.set(lv, arr);
  }

  const positioned: PositionedNode[] = [];
  let maxRows = 0;
  for (const [lv, group] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    maxRows = Math.max(maxRows, group.length);
    group.forEach((n, i) => {
      positioned.push({
        ...n,
        x: MARGIN + lv * (NODE_WIDTH + COL_GAP),
        y: MARGIN + i * (NODE_HEIGHT + ROW_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        level: lv,
      });
    });
  }

  const posById = new Map(positioned.map((n) => [n.id, n]));
  const edges: DagEdge[] = [];
  for (const n of positioned) {
    for (const dep of n.depends) {
      const from = posById.get(dep);
      if (!from || !byId.get(dep)) continue;
      edges.push({
        fromId: from.id,
        toId: n.id,
        fromX: from.x + from.width,
        fromY: from.y + from.height / 2,
        toX: n.x,
        toY: n.y + n.height / 2,
      });
    }
  }

  const totalLevels = buckets.size === 0 ? 0 : Math.max(...buckets.keys()) + 1;
  const width = MARGIN * 2 + totalLevels * NODE_WIDTH + Math.max(0, totalLevels - 1) * COL_GAP;
  const height = MARGIN * 2 + maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP;
  return { nodes: positioned, edges, width, height };
}
