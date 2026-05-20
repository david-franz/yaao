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

  if (error) return <p style={{ color: '#a00' }}>{error}</p>;
  if (!data) return <p>loading…</p>;

  const tasks = data.plan.tasks;
  const layout = layoutDag(
    tasks.map((t) => ({ id: t.id, title: t.title, agent: t.agent, depends: t.depends })),
  );
  const selected = tasks.find((t) => t.id === selectedId) ?? null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 360px', gap: '1rem', height: '100%' }}>
      <div style={{ overflow: 'auto', border: '1px solid #ddd', borderRadius: 4 }}>
        <header style={{ padding: '0.5rem 1rem', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', left: 0, background: '#fff', zIndex: 1 }}>
          <div>
            <strong>{data.plan.plan.name}</strong>{' '}
            <span style={{ color: '#666' }}>· {tasks.length} task{tasks.length === 1 ? '' : 's'}</span>
          </div>
          <Link to={`/plans/${encodeURIComponent(slug)}/edit`}>edit YAML →</Link>
        </header>
        {/* Render the SVG at its native pixel size so long plans get a
            horizontal scrollbar from the parent overflow:auto rather than
            being squashed to fit the container. The previous viewBox +
            width:100% combo shrunk wide DAGs until labels were unreadable. */}
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          preserveAspectRatio="xMinYMin meet"
          style={{ display: 'block' }}
        >
          {/* edges */}
          {layout.edges.map((e) => (
            <path
              key={`${e.fromId}->${e.toId}`}
              d={`M ${e.fromX} ${e.fromY} C ${e.fromX + 30} ${e.fromY}, ${e.toX - 30} ${e.toY}, ${e.toX} ${e.toY}`}
              stroke="#999"
              fill="none"
              strokeWidth={1.5}
            />
          ))}
          {/* nodes */}
          {layout.nodes.map((n) => {
            const isSel = n.id === selectedId;
            return (
              <g
                key={n.id}
                transform={`translate(${n.x}, ${n.y})`}
                style={{ cursor: 'pointer' }}
                onClick={() => setSelectedId(n.id)}
              >
                {/* Full title surfaces on hover so truncation is recoverable
                    without a click; the side pane carries the canonical
                    expanded view. */}
                <title>{`${n.id} — ${n.title} (${n.agent})`}</title>
                <rect
                  width={n.width}
                  height={n.height}
                  rx={6}
                  fill={isSel ? '#cde7ff' : '#fff'}
                  stroke={isSel ? '#0066cc' : '#888'}
                  strokeWidth={isSel ? 2 : 1}
                />
                <text x={12} y={22} fontSize={13} fontWeight={600}>
                  {n.id}
                </text>
                <text x={12} y={40} fontSize={11} fill="#555">
                  {truncate(n.title, 22)}
                </text>
                <text x={n.width - 12} y={22} fontSize={10} fill="#777" textAnchor="end">
                  {n.agent}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <aside style={{ border: '1px solid #ddd', borderRadius: 4, padding: '0.75rem 1rem', overflow: 'auto' }}>
        {selected ? <TaskDetail task={selected} /> : <p style={{ color: '#666' }}>Click a node to see its details.</p>}
      </aside>
    </div>
  );
}

function TaskDetail({ task }: { task: ResolvedTask }): JSX.Element {
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 0.75rem', margin: 0 }}>
      <dt>id</dt>
      <dd>{task.id}</dd>
      <dt>title</dt>
      <dd>{task.title}</dd>
      <dt>agent</dt>
      <dd>{task.agent}{task.model ? ` · ${task.model}` : ''}</dd>
      <dt>depends</dt>
      <dd>{task.depends.length === 0 ? <em>none</em> : task.depends.join(', ')}</dd>
      <dt>skills</dt>
      <dd>{task.skills.length === 0 ? <em>none</em> : task.skills.join(', ')}</dd>
      {task.validation?.command ? (
        <>
          <dt>validation</dt>
          <dd>
            <code style={{ fontSize: 11, background: '#f4f4f4', padding: '0.125rem 0.25rem' }}>
              {task.validation.command}
            </code>
          </dd>
        </>
      ) : null}
      <dt>prompt</dt>
      <dd>
        <pre
          style={{
            margin: 0,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            fontSize: 12,
            background: '#fafafa',
            padding: '0.5rem',
            border: '1px solid #eee',
            borderRadius: 4,
          }}
        >
          {task.prompt}
        </pre>
      </dd>
    </dl>
  );
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}
