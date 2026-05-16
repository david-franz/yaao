import type { RunSummary } from '../git/journal.js';

const ICONS: Record<string, string> = {
  pending: '⏸',
  ready: '▶',
  running: '⠦',
  completed: '✔',
  failed: '✘',
  skipped: '⊘',
  blocked: '⛔',
};

export interface StatusTableOptions {
  ascii?: boolean;
  /** Optional column override. Defaults: id, status, agent, branch, duration. */
  columns?: Array<'id' | 'status' | 'agent' | 'branch' | 'duration'>;
}

export function renderStatusTable(summary: RunSummary, opts: StatusTableOptions = {}): string {
  const columns = opts.columns ?? ['id', 'status', 'agent', 'branch', 'duration'];
  const rows: Record<string, string>[] = [];
  for (const [id, t] of Object.entries(summary.tasks)) {
    // A cascade-skip ("blocked") is semantically different from a user-skip:
    // it means an upstream task failed and this one never got a chance, not
    // that the user told us to leave it out. Surface that distinction in the
    // status column so it's obvious why something didn't run.
    const isBlocked = t.status === 'skipped' && t.skipReason === 'depFailed';
    const display = isBlocked ? 'blocked' : t.status;
    rows.push({
      id,
      status: (opts.ascii ? '' : (ICONS[display] ?? '')) + ' ' + display,
      agent: t.agent ?? '',
      branch: t.branch ?? '',
      duration: formatDuration(t.durationMs),
    });
  }
  // Stable sort: running > ready > pending > completed > skipped > failed, then by id.
  const order: Record<string, number> = {
    running: 0,
    ready: 1,
    pending: 2,
    completed: 3,
    skipped: 4,
    blocked: 5,
    failed: 6,
  };
  const displayStatusOf = (id: string): string => {
    const t = summary.tasks[id];
    if (!t) return 'pending';
    return t.status === 'skipped' && t.skipReason === 'depFailed' ? 'blocked' : t.status;
  };
  rows.sort((a, b) => {
    const at = displayStatusOf(a['id'] as string);
    const bt = displayStatusOf(b['id'] as string);
    return (order[at] ?? 9) - (order[bt] ?? 9) || (a['id'] ?? '').localeCompare(b['id'] ?? '');
  });

  const widths = new Map<string, number>();
  for (const col of columns) widths.set(col, col.length);
  for (const r of rows) {
    for (const col of columns) widths.set(col, Math.max(widths.get(col) ?? 0, (r[col] ?? '').length));
  }
  const pad = (col: string, val: string): string => val.padEnd(widths.get(col) ?? 0);
  const lines: string[] = [];
  lines.push(`run ${summary.runId} · status: ${summary.status} · ${Object.keys(summary.tasks).length} task(s)`);
  lines.push('');
  lines.push(columns.map((c) => pad(c, c)).join('  '));
  lines.push(columns.map((c) => '-'.repeat(widths.get(c) ?? 0)).join('  '));
  for (const r of rows) lines.push(columns.map((c) => pad(c, r[c] ?? '')).join('  '));
  return lines.join('\n');
}

function formatDuration(ms: number | undefined): string {
  if (typeof ms !== 'number') return '';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem.toString().padStart(2, '0')}s`;
}
