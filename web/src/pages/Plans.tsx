import { useEffect, useState } from 'react';
import { api, subscribe, type InspectPayload } from '../api.ts';
import { Link } from '../Link.tsx';

/**
 * Plans index. Lists every plan in the workspace — both the
 * implementation-plan markdown (`.yaao/plans/*.md`) and its paired
 * execution-plan YAML (`.yaao/exec/*.yaml`). Both files share a slug,
 * so each row pairs them naturally; a plan can have just one side
 * (e.g. an exec YAML hand-rolled without a source md, or a draft md
 * that hasn't been converted yet).
 *
 * Backed by /api/inspect — same shape the Workspace page consumes —
 * and live-refreshes on /api/inspect/watch so adding a file in the
 * filesystem shows up without a page reload.
 */
export function Plans(): JSX.Element {
  const [data, setData] = useState<InspectPayload | null>(null);
  const reload = (): void => {
    void api.inspect().then((d) => setData(d));
  };
  useEffect(() => {
    reload();
  }, []);
  useEffect(() => subscribe('/api/inspect/watch', { change: () => reload() }), []);

  if (!data) return <p className="muted">loading…</p>;
  const plans = data.plans;
  if (plans.length === 0) {
    return (
      <div className="card card--padded empty">
        No plans yet. Generate one with <code>yaao plan "&lt;description&gt;"</code> and convert it with{' '}
        <code>yaao convert</code>.
      </div>
    );
  }
  return (
    <div className="card card--scroll">
      <table className="table">
        <thead>
          <tr>
            <th>slug</th>
            <th>implementation plan</th>
            <th>execution plan</th>
            <th>tracked</th>
            <th>last run</th>
            <th>actions</th>
          </tr>
        </thead>
        <tbody>
          {plans.map((p) => (
            <tr key={p.slug}>
              <td>
                <strong>{p.slug}</strong>
              </td>
              <td>
                {p.planPath ? (
                  <code>{p.planPath}</code>
                ) : (
                  <span className="subtle">—</span>
                )}
              </td>
              <td>
                {p.execPath ? (
                  <code>{p.execPath}</code>
                ) : (
                  <span className="subtle">—</span>
                )}
              </td>
              <td>
                {p.execPath ? (
                  p.tracked === undefined ? (
                    <span className="subtle">—</span>
                  ) : (
                    <TrackedPill tracked={p.tracked} dirty={p.dirty} />
                  )
                ) : (
                  <span className="subtle">—</span>
                )}
              </td>
              <td>
                {p.lastRunId ? (
                  <Link to={`/runs/${encodeURIComponent(p.lastRunId)}`}>
                    <code>{p.lastRunId}</code>{' '}
                    <span className="muted">({p.lastRunStatus})</span>
                  </Link>
                ) : (
                  <span className="subtle">—</span>
                )}
              </td>
              <td>
                <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  {p.execPath ? (
                    <>
                      <Link to={`/plans/${encodeURIComponent(p.slug)}`}>DAG</Link>
                      <Link to={`/plans/${encodeURIComponent(p.slug)}/edit`}>edit</Link>
                    </>
                  ) : (
                    <span className="subtle" title="run `yaao convert` to produce the execution plan">
                      no exec yet
                    </span>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TrackedPill({ tracked, dirty }: { tracked: boolean; dirty?: boolean }): JSX.Element {
  const variant = tracked && !dirty ? 'success' : dirty ? 'warning' : 'danger';
  const label = tracked && !dirty ? 'committed' : dirty ? 'dirty' : 'untracked';
  return <span className={`pill pill--${variant}`}>{label}</span>;
}
