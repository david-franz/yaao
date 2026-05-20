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
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: '1rem', height: '100%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <div>
            <strong>{runId}</strong>{' '}
            <StatusBadge status={state.status} />
            {state.planFile ? <span style={{ marginLeft: 12, color: '#666' }}>{state.planFile.split('/').slice(-2).join('/')}</span> : null}
          </div>
          <Controls runId={runId} runStatus={state.status} />
        </header>
        <TaskGrid tasks={state.tasks} onSelect={setSelectedTask} onFilter={setFilterTask} filter={filterTask} />
        {error ? <p style={{ color: '#a00' }}>{error}</p> : null}
        <ActivityStream rows={filtered} filter={filterTask} onClearFilter={() => setFilterTask(null)} />
        {filterTask ? (
          <p style={{ fontSize: 12, color: '#555', marginTop: 4 }}>
            Filtered to <code>{filterTask}</code>. <button onClick={() => setFilterTask(null)}>clear</button>
          </p>
        ) : null}
        <small style={{ color: '#666', marginTop: 4 }}>{allTaskIds.length} task{allTaskIds.length === 1 ? '' : 's'} · {state.activity.length} events</small>
      </div>
      <aside style={{ border: '1px solid #ddd', borderRadius: 4, padding: '0.75rem 1rem', overflow: 'auto' }}>
        {selectedTask && state.tasks[selectedTask] ? (
          <TaskPane id={selectedTask} task={state.tasks[selectedTask]} />
        ) : (
          <p style={{ color: '#666' }}>Click a task to see its detail.</p>
        )}
      </aside>
    </div>
  );
}

function StatusBadge({ status }: { status: RunState['status'] }): JSX.Element {
  const color: Record<RunState['status'], string> = {
    unknown: '#999',
    running: '#0066cc',
    success: '#0a7f2e',
    failed: '#a00',
    cancelled: '#666',
  };
  return (
    <span style={{ padding: '0.125rem 0.5rem', borderRadius: 8, color: '#fff', background: color[status], fontSize: 12 }}>
      {status}
    </span>
  );
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
    <div style={{ display: 'flex', gap: '0.5rem' }}>
      {runStatus === 'running' ? <button onClick={cancel} disabled={busy}>Cancel</button> : null}
      {(runStatus === 'failed' || runStatus === 'cancelled') ? <button onClick={resume} disabled={busy}>Resume</button> : null}
      <Link to="/workspace">← workspace</Link>
    </div>
  );
}

function TaskGrid({ tasks, onSelect, onFilter, filter }: { tasks: Record<string, RunSummaryTask>; onSelect: (id: string) => void; onFilter: (id: string) => void; filter: string | null }): JSX.Element {
  const ids = Object.keys(tasks).sort();
  if (ids.length === 0) return <p style={{ color: '#666' }}>Waiting for tasks…</p>;
  return (
    <div style={{ display: 'grid', gap: '0.25rem', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', marginBottom: '0.5rem' }}>
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
            style={{
              textAlign: 'left',
              padding: '0.4rem 0.6rem',
              border: `1.5px solid ${statusBorder(t.status)}`,
              background: isFiltered ? '#fffae5' : '#fff',
              borderRadius: 6,
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            <strong style={{ fontSize: 13 }}>{id}</strong>
            <span style={{ fontSize: 11, color: '#444' }}>
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

function statusBorder(status: string): string {
  switch (status) {
    case 'completed':
      return '#0a7f2e';
    case 'failed':
      return '#a00';
    case 'running':
      return '#0066cc';
    case 'skipped':
      return '#bbb';
    default:
      return '#888';
  }
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
    <div
      ref={ref}
      onScroll={onScroll}
      style={{ flex: 1, overflow: 'auto', border: '1px solid #ddd', borderRadius: 4, padding: '0.25rem 0.5rem', background: '#fafafa', fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: 1.5 }}
    >
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
  // mouse, which is friction for the common case. Click the row to collapse.
  const [open, setOpen] = useState(true);
  if (row.kind === 'lifecycle') {
    return <div style={{ color: '#444', padding: '1px 0' }}>{row.line}</div>;
  }
  if (row.kind === 'thinking') {
    return (
      <div style={{ color: '#5a5a5a', padding: '2px 0', borderLeft: '2px solid #d0d0d0', paddingLeft: 8, marginLeft: 2, marginTop: 2, marginBottom: 2 }}>
        <button onClick={() => setOpen(!open)} style={btnStyle}>
          {open ? '▾' : '▸'} {row.taskId} · thinking <span style={{ color: '#999' }}>({row.chars} chars)</span>
        </button>
        {open ? <pre style={preStyle}>{row.raw}</pre> : null}
      </div>
    );
  }
  if (row.kind === 'tool-use') {
    return (
      <div style={{ color: '#0066cc', padding: '2px 0' }}>
        <button onClick={() => setOpen(!open)} style={btnStyle}>
          {open ? '▾' : '▸'} {row.taskId} · 🔧 {row.name}
        </button>
        {open ? <pre style={preStyle}>{row.raw}</pre> : null}
      </div>
    );
  }
  if (row.kind === 'stderr') {
    return <div style={{ color: '#a00', padding: '1px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{row.taskId}: {row.data}</div>;
  }
  return <div style={{ padding: '1px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{row.taskId}: {row.data}</div>;
}

const btnStyle: React.CSSProperties = { border: 'none', background: 'transparent', cursor: 'pointer', padding: 0, fontFamily: 'inherit', fontSize: 'inherit' };
const preStyle: React.CSSProperties = { margin: '0.25rem 0 0.25rem 1rem', padding: '0.5rem', background: '#fff', border: '1px solid #eee', whiteSpace: 'pre-wrap', wordBreak: 'break-word' };

function TaskPane({ id, task }: { id: string; task: RunSummaryTask }): JSX.Element {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 0.75rem', margin: 0 }}>
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
            <span style={{ background: task.validation.exitCode === 0 ? '#dff2e0' : '#fde2e2', padding: '0.125rem 0.5rem', borderRadius: 4 }}>
              {task.validation.exitCode === 0 ? '✓ passed' : `✗ failed (exit ${task.validation.exitCode ?? '?'})`}
            </span>
            {task.validation.command ? (
              <pre style={{ margin: '0.25rem 0 0', fontSize: 11, background: '#f4f4f4', padding: '0.25rem 0.5rem' }}>{task.validation.command}</pre>
            ) : null}
          </dd>
        </>
      ) : null}
      {task.error ? (
        <>
          <dt>error</dt>
          <dd style={{ color: '#a00' }}>{task.error.code}: {task.error.message}</dd>
        </>
      ) : null}
    </dl>
  );
}
