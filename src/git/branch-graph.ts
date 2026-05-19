import type { ResolvedPlan, ResolvedTask } from '../plan/schema/resolve.js';
import { resolveBranchPolicy } from '../plan/schema/resolve.js';

export interface TaskBranchEntry {
  branch: string;
  baseBranch: string;
  parentBranches: string[];
}

export interface BranchPlan {
  byTask: Map<string, TaskBranchEntry>;
  baseBranch: string;
  /** Topological order, or empty if the plan has cycles (validator should have caught those). */
  topoOrder: string[];
}

export function planBranches(plan: ResolvedPlan): BranchPlan {
  const byTask = new Map<string, TaskBranchEntry>();
  const policy = resolveBranchPolicy(plan);
  // Layer-0 tasks branch off `featureBranch` when set, so the plan's prior
  // integration commits flow into every task; otherwise they branch off the
  // workspace base-branch (status-quo behaviour).
  const layer0Source = policy.featureBranch ?? policy.baseBranch;
  const baseBranch = policy.baseBranch;
  const idToTask = new Map(plan.tasks.map((t) => [t.id, t]));

  const descendants = computeDescendantCounts(plan.tasks);

  for (const t of plan.tasks) {
    const branch = t.branch;
    if (t.depends.length === 0) {
      byTask.set(t.id, { branch, baseBranch: layer0Source, parentBranches: [] });
      continue;
    }
    if (t.depends.length === 1) {
      const sole = t.depends[0] as string;
      const dep = idToTask.get(sole);
      const depBranch = dep?.branch ?? `${plan.plan.name}/${sole}`;
      byTask.set(t.id, { branch, baseBranch: depBranch, parentBranches: [] });
      continue;
    }
    // Multiple deps: pick primary by most descendants; tiebreak lex on task id.
    const ranked = t.depends.slice().sort((a, b) => {
      const da = descendants.get(a) ?? 0;
      const db = descendants.get(b) ?? 0;
      if (da !== db) return db - da;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const [primaryId, ...others] = ranked;
    const primary = primaryId ? idToTask.get(primaryId) : undefined;
    const primaryBranch = primary?.branch ?? `${plan.plan.name}/${primaryId ?? 'unknown'}`;
    const parentBranches = others.map((id) => idToTask.get(id)?.branch ?? `${plan.plan.name}/${id}`);
    byTask.set(t.id, { branch, baseBranch: primaryBranch, parentBranches });
  }

  const topoOrder = topologicalOrder(plan.tasks);
  return { byTask, baseBranch, topoOrder };
}

function computeDescendantCounts(tasks: ResolvedTask[]): Map<string, number> {
  // children[parent] = list of immediate downstream task ids
  const children = new Map<string, string[]>();
  for (const t of tasks) {
    for (const dep of t.depends) {
      const arr = children.get(dep) ?? [];
      arr.push(t.id);
      children.set(dep, arr);
    }
  }
  const cache = new Map<string, number>();
  const count = (id: string, seen: Set<string>): number => {
    if (cache.has(id)) return cache.get(id) as number;
    if (seen.has(id)) return 0; // cycle: validator handles
    seen.add(id);
    let total = 0;
    for (const c of children.get(id) ?? []) total += 1 + count(c, seen);
    seen.delete(id);
    cache.set(id, total);
    return total;
  };
  const out = new Map<string, number>();
  for (const t of tasks) out.set(t.id, count(t.id, new Set()));
  return out;
}

function topologicalOrder(tasks: ResolvedTask[]): string[] {
  const indeg = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const t of tasks) {
    indeg.set(t.id, t.depends.length);
    for (const dep of t.depends) {
      const arr = children.get(dep) ?? [];
      arr.push(t.id);
      children.set(dep, arr);
    }
  }
  const queue: string[] = [];
  for (const t of tasks) {
    if ((indeg.get(t.id) ?? 0) === 0) queue.push(t.id);
  }
  queue.sort();
  const out: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    out.push(id);
    for (const c of children.get(id) ?? []) {
      const next = (indeg.get(c) ?? 0) - 1;
      indeg.set(c, next);
      if (next === 0) {
        queue.push(c);
        queue.sort();
      }
    }
  }
  return out.length === tasks.length ? out : [];
}
