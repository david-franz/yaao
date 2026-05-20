import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { api, subscribe, type RunSummaryShape, type RunSummaryTask } from '../api.ts';
import { Link } from '../Link.tsx';
import { navigate } from '../router.ts';

/**
 * F13.3 live run view. Subscribes to `/api/runs/:runId/events` (SSE) and
 * accumulates the journal events into a structured run state. Renders
 * three things:
 *
 *   - DAG-style status grid: every task with its current status
 *     (queued/ready/active/completed/failed/skipped/merged) and a
 *     validation pill when the task records one.
 *   - Activity stream: a scrolling feed of every event the run emits.
 *     Thinking events are collapsed by default; tool-use is a one-line
 *     summary; stdout/stderr is shown as-is. Filterable by clicking a
 *     task.
 *   - Detail pane: the task summary shape (commit, branch, files
 *     changed, merge status, validation outcome).
 *
 * Controls: cancel (POST /api/runs/:runId/cancel) when in-flight, resume
 * (POST /api/runs/:runId/resume) when failed.
 */
export function RunDetail({ runId }: { runId: string }): JSX.Element {
  // For /runs/latest we resolve to the most recent run client-side.
  const [resolvedId, setResolvedId] = useState<string | null>(runId === 'latest' ? null : runId);
  useEffect(() => {
    if (runId !== 'latest') return;
    void api.runs().then((r) => {
      const latest = r.runs[0];
      if (latest) navigate(`/runs/${encodeURIComponent(latest.runId)}`);
      else setResolvedId('');
    });
  }, [runId]);

  if (resolvedId === null) return <p>resolving latest run…</p>;
  if (resolvedId === '') return <p>No runs yet. Start one with <code>yaao run &lt;plan&gt;</code>.</p>;
  return <RunView runId={resolvedId} />;
}

export type ActivityRow =
  | { kind: 'lifecycle'; line: string; taskId?: string; eventId: number; t: string }
  | { kind: 'tool-use'; taskId: string; name: string; raw: string; eventId: number }
  | { kind: 'stdout'; taskId: string; data: string; eventId: number }
  | { kind: 'stderr'; taskId: string; data: string; eventId: number }
  | { kind: 'thinking'; taskId: string; chars: number; raw: string; eventId: number };

export interface RunState {
  status: 'unknown' | 'running' | 'success' | 'failed' | 'cancelled';
  planFile?: string;
  tasks: Record<string, RunSummaryTask>;
  activity: ActivityRow[];
}

export const initialState: RunState = { status: 'unknown', tasks: {}, activity: [] };

export interface JournalEvent {
  t: string;
  taskId?: string;
  [k: string]: unknown;
}

export function reducer(state: RunState, action: { id: number; ev: JournalEvent }): RunState {
  const { id, ev } = action;
  const tasks = { ...state.tasks };
  const activity = state.activity.slice();
  const upsert = (taskId: string, patch: Partial<RunSummaryTask>): void => {
    tasks[taskId] = { ...(tasks[taskId] ?? { status: 'pending' }), ...patch };
  };
  switch (ev.t) {
    case 'run:start':
      return { ...state, status: 'running', planFile: ev['planFile'] as string, activity: [...activity, lifecycleRow(id, ev)] };
    case 'run:end':
      return {
        ...state,
        status: (ev['status'] as RunState['status']) ?? state.status,
        activity: [...activity, lifecycleRow(id, ev)],
      };
    case 'task:queued':
    case 'task:ready':
    case 'task:skipped':
      if (ev.taskId) upsert(ev.taskId, { status: ev.t.replace('task:', '') as RunSummaryTask['status'] });
      activity.push(lifecycleRow(id, ev));
      return { ...state, tasks, activity };
    case 'task:running':
      if (ev.taskId)
        upsert(ev.taskId, {
          status: 'running',
          agent: ev['agent'] as string,
          branch: ev['branch'] as string,
          worktree: ev['worktree'] as string,
        });
      activity.push(lifecycleRow(id, ev));
      return { ...state, tasks, activity };
    case 'task:completed':
      if (ev.taskId) {
        const patch: Partial<RunSummaryTask> = {
          status: 'completed',
          durationMs: ev['durationMs'] as number,
          filesChanged: ev['filesChanged'] as number,
          commit: ev['commit'] as string,
        };
        if (ev['agent']) patch.agent = ev['agent'] as string;
        if (ev['validation']) patch.validation = ev['validation'] as RunSummaryTask['validation'];
        upsert(ev.taskId, patch);
      }
      activity.push(lifecycleRow(id, ev));
      return { ...state, tasks, activity };
    case 'task:failed':
      if (ev.taskId)
        upsert(ev.taskId, {
          status: 'failed',
          error: ev['error'] as RunSummaryTask['error'],
          ...(ev['validation'] ? { validation: ev['validation'] as RunSummaryTask['validation'] } : {}),
        });
      activity.push(lifecycleRow(id, ev));
      return { ...state, tasks, activity };
    case 'task:merged':
      if (ev.taskId)
        upsert(ev.taskId, {
          mergeStatus: 'merged',
          mergeInto: ev['into'] as string,
          mergeCommit: ev['mergeCommit'] as string,
        });
      activity.push(lifecycleRow(id, ev));
      return { ...state, tasks, activity };
    case 'task:merge-failed':
      if (ev.taskId)
        upsert(ev.taskId, {
          mergeStatus: 'merge-failed',
          mergeInto: ev['into'] as string,
          mergeConflicts: ev['conflicts'] as string[],
          mergeReason: ev['reason'] as string,
        });
      activity.push(lifecycleRow(id, ev));
      return { ...state, tasks, activity };
    case 'task:agent-event': {
      const inner = ev['ev'] as { type: string; data: string } | undefined;
      if (!inner || !ev.taskId) return { ...state, activity };
      const taskId = ev.taskId;
      if (inner.type === 'thinking') {
        activity.push({ kind: 'thinking', taskId, chars: inner.data.length, raw: inner.data, eventId: id });
      } else if (inner.type === 'tool-use') {
        let name = '(unknown)';
        try {
          name = (JSON.parse(inner.data) as { name?: string }).name ?? name;
        } catch {
          /* ignore */
        }
        activity.push({ kind: 'tool-use', taskId, name, raw: inner.data, eventId: id });
      } else if (inner.type === 'stdout') {
        activity.push({ kind: 'stdout', taskId, data: inner.data, eventId: id });
      } else if (inner.type === 'stderr') {
        activity.push({ kind: 'stderr', taskId, data: inner.data, eventId: id });
      }
      return { ...state, activity };
    }
    default:
      activity.push(lifecycleRow(id, ev));
      return { ...state, activity };
  }
}

function lifecycleRow(id: number, ev: JournalEvent): ActivityRow {
  const tail = ev.taskId ? ` · ${ev.taskId}` : '';
  return {
    kind: 'lifecycle',
    line: `${ev.t}${tail}`,
    eventId: id,
    t: ev.t,
    ...(ev.taskId ? { taskId: ev.taskId as string } : {}),
  };
}

function RunView({ runId }: { runId: string }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [filterTask, setFilterTask] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Initial summary fetch — the SSE stream replays the journal but the
  // summary view also displays merge state etc. that the reducer rebuilds
  // identically from the same events. Skip the seed fetch.
  useEffect(() => setSelectedTask(null), [runId]);

  // SSE subscription. Backend replays the journal then live-tails.
  useEffect(() => {
    // Listen for every known event name explicitly so the EventSource
    // dispatch picks them up. The router-level handler also gets the
    // default 'message' event for any 't' the server emits without an
    // explicit `event:` (shouldn't happen with F13.1's design, but be
    // defensive).
    const eventNames = [
      'run:start',
      'run:warning',
      'run:end',
      'task:queued',
      'task:ready',
      'task:running',
      'task:active',
      'task:agent-event',
      'task:diff',
      'task:committed',
      'task:retry-attempt',
      'task:completed',
      'task:failed',
      'task:skipped',
      'task:merged',
      'task:merge-failed',
    ];
    const handlers: Record<string, (data: unknown, lastId?: string) => void> = {};
    for (const name of eventNames) {
      handlers[name] = (data, lastId) => {
        const ev = data as JournalEvent;
        const id = Number(lastId ?? '0');
        dispatch({ id: Number.isFinite(id) ? id : 0, ev });
      };
    }
    handlers['message'] = handlers['run:start']!; // fallback
    handlers['error'] = () => setError('lost connection to /api/runs/<id>/events');
    return subscribe(`/api/runs/${encodeURIComponent(runId)}/events`, handlers);
  }, [runId]);

  const allTaskIds = useMemo(() => Object.keys(state.tasks).sort(), [state.tasks]);
  const filtered = filterTask ? state.activity.filter((r) => r.taskId === filterTask || (r.kind === 'lifecycle' && r.taskId === filterTask)) : state.activity;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: 'var(--space-4)', height: '100%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, gap: 'var(--space-2)' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <strong style={{ fontSize: 'var(--fs-lg)' }}>{runId}</strong>
            <StatusBadge status={state.status} />
            {state.planFile ? <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>{state.planFile.split('/').slice(-2).join('/')}</span> : null}
          </div>
          <Controls runId={runId} runStatus={state.status} />
        </header>
        <TaskGrid tasks={state.tasks} onSelect={setSelectedTask} onFilter={setFilterTask} filter={filterTask} />
        {error ? <div className="banner banner--danger">{error}</div> : null}
        <ActivityStream rows={filtered} filter={filterTask} onClearFilter={() => setFilterTask(null)} />
        {filterTask ? (
          <p className="muted" style={{ fontSize: 'var(--fs-xs)', margin: 0 }}>
            Filtered to <code>{filterTask}</code>. <button className="btn btn--ghost" onClick={() => setFilterTask(null)}>clear</button>
          </p>
        ) : null}
        <small className="subtle">{allTaskIds.length} task{allTaskIds.length === 1 ? '' : 's'} · {state.activity.length} events</small>
      </div>
      <aside className="card card--padded card--scroll">
        {selectedTask && state.tasks[selectedTask] ? (
          <TaskPane id={selectedTask} task={state.tasks[selectedTask]} />
        ) : (
          <p className="muted">Click a task to see its detail.</p>
        )}
      </aside>
    </div>
  );
}

function StatusBadge({ status }: { status: RunState['status'] }): JSX.Element {
  const variant: Record<RunState['status'], string> = {
    unknown: 'neutral',
    running: 'running',
    success: 'success',
    failed: 'danger',
    cancelled: 'neutral',
  };
  return <span className={`pill pill--${variant[status]}`}>{status}</span>;
}

function Controls({ runId, runStatus }: { runId: string; runStatus: RunState['status'] }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const cancel = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.cancel(runId);
    } finally {
      setBusy(false);
    }
  };
  const resume = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.resume(runId, { retryFailed: true, reskip: false });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
      {runStatus === 'running' ? <button className="btn btn--danger" onClick={cancel} disabled={busy}>Cancel</button> : null}
      {(runStatus === 'failed' || runStatus === 'cancelled') ? <button className="btn btn--primary" onClick={resume} disabled={busy}>Resume</button> : null}
      <Link to="/workspace">← workspace</Link>
    </div>
  );
}

function TaskGrid({ tasks, onSelect, onFilter, filter }: { tasks: Record<string, RunSummaryTask>; onSelect: (id: string) => void; onFilter: (id: string) => void; filter: string | null }): JSX.Element {
  const ids = Object.keys(tasks).sort();
  if (ids.length === 0) return <p className="muted">Waiting for tasks…</p>;
  return (
    <div style={{ display: 'grid', gap: 'var(--space-2)', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
      {ids.map((id) => {
        const t = tasks[id]!;
        const isFiltered = filter === id;
        return (
          <button
            key={id}
            onClick={() => {
              onSelect(id);
              onFilter(id);
            }}
            className={`task-card task-card--${t.status}${isFiltered ? ' task-card--filtered' : ''}`}
          >
            <strong className="task-card__id">{id}</strong>
            <span className="task-card__meta">
              {t.status}
              {t.agent ? ` · ${t.agent}` : ''}
              {t.mergeStatus === 'merged' ? ' · merged' : ''}
              {t.mergeStatus === 'merge-failed' ? ' · merge-failed' : ''}
              {t.validation ? ` · validation ${t.validation.exitCode === 0 ? '✓' : '✗'}` : ''}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ActivityStream({ rows, filter: _filter, onClearFilter: _onClearFilter }: { rows: ActivityRow[]; filter: string | null; onClearFilter: () => void }): JSX.Element {
  // Stick to bottom while the user is parked at the bottom; if they scroll
  // up to read history, *stop* auto-scrolling so we don't yank them around.
  // The threshold gives ~half-a-line of slack so micro-scrolls don't break
  // the stick.
  const ref = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [rows.length]);
  const onScroll = (): void => {
    const el = ref.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    stickToBottom.current = distanceFromBottom < 24;
  };
  return (
    <div ref={ref} onScroll={onScroll} className="activity">
      {rows.map((r) => (
        <ActivityRowView key={r.eventId} row={r} />
      ))}
    </div>
  );
}

function ActivityRowView({ row }: { row: ActivityRow }): JSX.Element {
  // Thinking and tool-use default open: the whole point of the activity
  // stream is to see what the agent is doing in real time. A collapsed
  // chevron next to "thinking (1842 chars)" makes everyone reach for the
  // mouse, which is friction for the common case. Click to collapse.
  const [open, setOpen] = useState(true);
  if (row.kind === 'lifecycle') {
    return <div className="activity-row activity-row--lifecycle">{row.line}</div>;
  }
  if (row.kind === 'thinking') {
    return (
      <div className="activity-row activity-row--thinking">
        <button onClick={() => setOpen(!open)} className="activity-row__toggle">
          {open ? '▾' : '▸'} {row.taskId} · thinking <span className="subtle">({row.chars} chars)</span>
        </button>
        {open ? <pre className="pre" style={{ margin: '4px 0 4px 14px' }}>{row.raw}</pre> : null}
      </div>
    );
  }
  if (row.kind === 'tool-use') {
    return (
      <div className="activity-row activity-row--tool-use">
        <button onClick={() => setOpen(!open)} className="activity-row__toggle">
          {open ? '▾' : '▸'} {row.taskId} · 🔧 {row.name}
        </button>
        {open ? <pre className="pre" style={{ margin: '4px 0 4px 14px' }}>{row.raw}</pre> : null}
      </div>
    );
  }
  if (row.kind === 'stderr') {
    return <div className="activity-row activity-row--stderr">{row.taskId}: {row.data}</div>;
  }
  return <div className="activity-row activity-row--stdout">{row.taskId}: {row.data}</div>;
}

function TaskPane({ id, task }: { id: string; task: RunSummaryTask }): JSX.Element {
  return (
    <dl className="dl-grid">
      <dt>id</dt><dd>{id}</dd>
      <dt>status</dt><dd>{task.status}</dd>
      {task.agent ? (<><dt>agent</dt><dd>{task.agent}</dd></>) : null}
      {task.branch ? (<><dt>branch</dt><dd><code>{task.branch}</code></dd></>) : null}
      {task.commit ? (<><dt>commit</dt><dd><code>{task.commit.slice(0, 12)}</code></dd></>) : null}
      {task.filesChanged !== undefined ? (<><dt>files changed</dt><dd>{task.filesChanged}</dd></>) : null}
      {task.mergeStatus ? (
        <>
          <dt>merge</dt>
          <dd>
            {task.mergeStatus === 'merged' ? '✓ merged' : '✗ failed'} → {task.mergeInto ?? '—'}
            {task.mergeCommit ? <> · <code>{task.mergeCommit.slice(0, 12)}</code></> : null}
          </dd>
        </>
      ) : null}
      {task.validation ? (
        <>
          <dt>validation</dt>
          <dd>
            <span className={`pill pill--${task.validation.exitCode === 0 ? 'success' : 'danger'}`}>
              {task.validation.exitCode === 0 ? '✓ passed' : `✗ failed (exit ${task.validation.exitCode ?? '?'})`}
            </span>
            {task.validation.command ? (
              <pre className="pre" style={{ marginTop: 6 }}>{task.validation.command}</pre>
            ) : null}
          </dd>
        </>
      ) : null}
      {task.error ? (
        <>
          <dt>error</dt>
          <dd className="danger">{task.error.code}: {task.error.message}</dd>
        </>
      ) : null}
    </dl>
  );
}
