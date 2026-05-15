import type { ResolvedPlan, ResolvedTask } from '../plan/schema/types.js';

export type TaskStatusIcon = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'skipped';

export interface RenderDagOptions {
  /** Per-task status (defaults to `pending`). */
  statuses?: Map<string, TaskStatusIcon>;
  /** Max width to wrap layers at. Default 100. */
  maxWidth?: number;
  /** Disable Unicode box-drawing characters (for terminals that mangle them). */
  ascii?: boolean;
}

export interface RenderDagResult {
  text: string;
  layers: string[][];
}

const ICONS: Record<TaskStatusIcon, string> = {
  pending: '⏸',
  ready: '▶',
  running: '⠦',
  completed: '✔',
  failed: '✘',
  skipped: '⊘',
};

const ASCII_ICONS: Record<TaskStatusIcon, string> = {
  pending: '.',
  ready: '>',
  running: '~',
  completed: 'v',
  failed: 'x',
  skipped: '/',
};

/**
 * Lay out a `ResolvedPlan` as a text DAG. The output is a stack of layers, one per
 * topological depth, with each task rendered as a compact card. Pure — no IO.
 */
export function renderDag(plan: ResolvedPlan, opts: RenderDagOptions = {}): RenderDagResult {
  const layers = layerTasks(plan.tasks);
  const statuses = opts.statuses ?? new Map<string, TaskStatusIcon>();
  const icons = opts.ascii ? ASCII_ICONS : ICONS;
  const maxWidth = opts.maxWidth ?? 100;

  const lines: string[] = [];
  lines.push(`${plan.plan.name}    ${plan.tasks.length} tasks · ${layers.length} layer(s) · max-parallel ${plan.config['max-parallel']}`);
  lines.push('');
  layers.forEach((layer, i) => {
    lines.push(`  layer ${i + 1} [${layer.length}]:`);
    const cards: string[] = [];
    for (const id of layer) {
      const task = plan.tasks.find((t) => t.id === id);
      if (!task) continue;
      cards.push(renderCard(task, icons[statuses.get(id) ?? 'pending']));
    }
    // Group cards horizontally within maxWidth.
    let row: string[] = [];
    let rowWidth = 0;
    for (const card of cards) {
      const cardWidth = visualWidth(card.split('\n')[0] ?? '');
      if (rowWidth + cardWidth + 2 > maxWidth && row.length > 0) {
        lines.push(...joinCardsHorizontal(row));
        lines.push('');
        row = [];
        rowWidth = 0;
      }
      row.push(card);
      rowWidth += cardWidth + 2;
    }
    if (row.length > 0) {
      lines.push(...joinCardsHorizontal(row));
      lines.push('');
    }
  });
  return { text: lines.join('\n'), layers };
}

function renderCard(task: ResolvedTask, icon: string): string {
  const idLine = task.id;
  const agentLine = `${task.agent}${task.model ? `/${task.model}` : ''}`;
  const statusLine = `${icon} ${task.title.slice(0, 26)}`;
  const width = Math.max(idLine.length, agentLine.length, statusLine.length) + 2;
  const pad = (s: string) => s + ' '.repeat(Math.max(0, width - s.length));
  const top = `┌${'─'.repeat(width)}┐`;
  const bot = `└${'─'.repeat(width)}┘`;
  return [
    top,
    `│ ${pad(idLine)}│`,
    `│ ${pad(agentLine)}│`,
    `│ ${pad(statusLine)}│`,
    bot,
  ].join('\n');
}

function joinCardsHorizontal(cards: string[]): string[] {
  const split = cards.map((c) => c.split('\n'));
  const height = Math.max(...split.map((s) => s.length));
  const out: string[] = [];
  for (let i = 0; i < height; i++) {
    out.push('  ' + split.map((s) => s[i] ?? '').join('  '));
  }
  return out;
}

function visualWidth(line: string): number {
  return line.length;
}

function layerTasks(tasks: ResolvedTask[]): string[][] {
  const layer = new Map<string, number>();
  const idToTask = new Map(tasks.map((t) => [t.id, t]));
  const compute = (id: string, seen: Set<string>): number => {
    if (layer.has(id)) return layer.get(id) as number;
    if (seen.has(id)) return 0;
    seen.add(id);
    const task = idToTask.get(id);
    if (!task || task.depends.length === 0) {
      layer.set(id, 0);
      return 0;
    }
    let max = 0;
    for (const d of task.depends) {
      const dl = compute(d, seen);
      if (dl + 1 > max) max = dl + 1;
    }
    layer.set(id, max);
    return max;
  };
  for (const t of tasks) compute(t.id, new Set());
  const buckets = new Map<number, string[]>();
  for (const [id, l] of layer) {
    const arr = buckets.get(l) ?? [];
    arr.push(id);
    buckets.set(l, arr);
  }
  const layers: string[][] = [];
  const maxL = Math.max(0, ...buckets.keys());
  for (let i = 0; i <= maxL; i++) {
    const arr = (buckets.get(i) ?? []).slice().sort();
    layers.push(arr);
  }
  return layers;
}
