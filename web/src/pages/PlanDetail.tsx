import { useEffect, useState } from 'react';
import { api, subscribe, type ResolvedPlanResp, type ResolvedTask } from '../api.ts';
import { layoutDag } from '../dag-layout.ts';
import { Link } from '../Link.tsx';

interface Props {
  slug: string;
}

/**
 * F13.2 DAG view. Renders the resolved plan as an SVG graph + a side
 * panel with the selected task's details. Subscribes to
 * `/api/plans/:slug/watch` for live reload on file change.
 */
export function PlanDetail({ slug }: Props): JSX.Element {
  const [data, setData] = useState<ResolvedPlanResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reloadCount, setReloadCount] = useState(0);

  // Initial load + reload on watch-event.
  useEffect(() => {
    let cancelled = false;
    void api
      .plan(slug)
      .then((d) => {
        if (cancelled) return;
        if (!d.ok) setError(`Plan failed to load: ${slug}`);
        setData(d);
      })
      .catch((e: unknown) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [slug, reloadCount]);

  // Live reload via SSE.
  useEffect(() => {
    const close = subscribe(`/api/plans/${encodeURIComponent(slug)}/watch`, {
      change: () => setReloadCount((n) => n + 1),
    });
    return close;
  }, [slug]);

  if (error) return <div className="banner banner--danger">{error}</div>;
  if (!data) return <p className="muted">loading…</p>;

  const tasks = data.plan.tasks;
  const layout = layoutDag(
    tasks.map((t) => ({ id: t.id, title: t.title, agent: t.agent, depends: t.depends })),
  );
  const selected = tasks.find((t) => t.id === selectedId) ?? null;

  return (
    // Mirror RunDetail's pattern: only allocate the side-pane column
    // when a task is actually selected. Otherwise the DAG gets the full
    // width and there's no "Click a node…" placeholder eating space.
    <div style={{
      display: 'grid',
      gridTemplateColumns: selected ? 'minmax(0, 1fr) minmax(320px, 400px)' : 'minmax(0, 1fr)',
      gap: 'var(--space-4)',
      height: '100%',
    }}>
      <div className="card card--scroll">
        <header style={{ padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 1 }}>
          <div>
            <strong>{data.plan.plan.name}</strong>{' '}
            <span className="muted">· {tasks.length} task{tasks.length === 1 ? '' : 's'}</span>
          </div>
          <Link to={`/plans/${encodeURIComponent(slug)}/edit`}>edit YAML →</Link>
        </header>
        <svg
          className="dag-svg"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          preserveAspectRatio="xMinYMin meet"
          style={{ display: 'block' }}
        >
          {layout.edges.map((e) => (
            <path
              key={`${e.fromId}->${e.toId}`}
              className="dag-edge"
              d={`M ${e.fromX} ${e.fromY} C ${e.fromX + 30} ${e.fromY}, ${e.toX - 30} ${e.toY}, ${e.toX} ${e.toY}`}
              strokeWidth={1.5}
            />
          ))}
          {layout.nodes.map((n) => {
            const isSel = n.id === selectedId;
            return (
              <g
                key={n.id}
                transform={`translate(${n.x}, ${n.y})`}
                style={{ cursor: 'pointer' }}
                onClick={() => setSelectedId(n.id)}
              >
                <title>{`${n.id} — ${n.title} (${n.agent})`}</title>
                <rect
                  width={n.width}
                  height={n.height}
                  rx={6}
                  className={isSel ? 'selected' : ''}
                  strokeWidth={isSel ? 2 : 1}
                />
                <text x={12} y={22} fontSize={13} fontWeight={600} className="dag-id">
                  {n.id}
                </text>
                <text x={12} y={40} fontSize={11} className="dag-title">
                  {truncate(n.title, 22)}
                </text>
                <text x={n.width - 12} y={22} fontSize={10} textAnchor="end" className="dag-agent">
                  {n.agent}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {selected ? (
        <aside className="card card--padded card--scroll">
          <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
            <strong>{selected.id}</strong>
            <button className="btn btn--ghost" onClick={() => setSelectedId(null)} aria-label="Close detail">×</button>
          </header>
          <TaskDetail task={selected} />
        </aside>
      ) : null}
    </div>
  );
}

function TaskDetail({ task }: { task: ResolvedTask }): JSX.Element {
  return (
    <dl className="dl-grid">
      <dt>id</dt>
      <dd>{task.id}</dd>
      <dt>title</dt>
      <dd>{task.title}</dd>
      <dt>agent</dt>
      <dd>{task.agent}{task.model ? ` · ${task.model}` : ''}</dd>
      <dt>depends</dt>
      <dd>{task.depends.length === 0 ? <em className="muted">none</em> : task.depends.join(', ')}</dd>
      <dt>skills</dt>
      <dd>{task.skills.length === 0 ? <em className="muted">none</em> : task.skills.join(', ')}</dd>
      {task.validation?.command ? (
        <>
          <dt>validation</dt>
          <dd>
            <code>{task.validation.command}</code>
          </dd>
        </>
      ) : null}
      <dt>prompt</dt>
      <dd>
        <pre className="pre">{task.prompt}</pre>
      </dd>
    </dl>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}
