import { useEffect, useState } from 'react';
import {
  api,
  subscribe,
  type InspectPayload,
  type PruneRequest,
  type PruneResponse,
} from '../api.ts';
import { Link } from '../Link.tsx';

/**
 * F13.4 workspace page. One-call snapshot via /api/inspect plus live
 * refresh on /api/inspect/watch. Prune actions live in a modal that
 * always runs dryRun=true first; the apply button re-issues the same
 * request with dryRun=false (and force=true if the operator opted in
 * on any skipped item). The structural safety rails carry through from
 * the MCP tool — base-branch never deleted, etc.
 */
export function Workspace(): JSX.Element {
  const [data, setData] = useState<InspectPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pruneIntent, setPruneIntent] = useState<PruneRequest | null>(null);

  const reload = (): void => {
    void api
      .inspect()
      .then((d) => setData(d))
      .catch((e: unknown) => setError(String(e)));
  };

  useEffect(() => {
    reload();
  }, []);

  useEffect(() => subscribe('/api/inspect/watch', { change: () => reload() }), []);

  if (error) return <div className="banner banner--danger">{error}</div>;
  if (!data) return <p className="muted">loading…</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
      <WorkspaceCard data={data} />
      <section>
        <h3 className="section-heading">Plans</h3>
        <PlansTable data={data} />
      </section>
      <section>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 'var(--space-2)' }}>
          <h3 className="section-heading" style={{ margin: 0 }}>Runs ({data.runs.length})</h3>
          <BulkPruneButton onPick={setPruneIntent} />
        </header>
        <RunsTable data={data} onPrune={setPruneIntent} />
      </section>
      {pruneIntent ? <PruneModal intent={pruneIntent} onClose={() => { setPruneIntent(null); reload(); }} /> : null}
    </div>
  );
}

function WorkspaceCard({ data }: { data: InspectPayload }): JSX.Element {
  const w = data.workspace;
  return (
    <section className="card card--padded">
      <h3 className="section-heading" style={{ marginTop: 0 }}>Workspace</h3>
      <dl className="dl-grid">
        <dt>cwd</dt><dd><code>{w.cwd}</code></dd>
        <dt>base-branch</dt><dd>{w.baseBranch}</dd>
        <dt>default-agent</dt><dd>{w.defaultAgent}</dd>
        <dt>worktree-root</dt><dd><code>{w.worktreeRoot}</code></dd>
        <dt>config</dt><dd><Link to="/config">{w.configPath ?? '(none)'}</Link></dd>
      </dl>
      {!w.inRepo ? (
        <div className="banner banner--danger" style={{ marginTop: 'var(--space-3)' }}>
          Not a git repository. The plan-tracking gate and worktree-stamp lineage are both off — runs are unguarded.
        </div>
      ) : null}
    </section>
  );
}

function PlansTable({ data }: { data: InspectPayload }): JSX.Element {
  if (data.plans.length === 0) return <p className="muted">No plans yet.</p>;
  return (
    <div className="card card--scroll">
      <table className="table">
        <thead>
          <tr>
            <th>slug</th>
            <th>plan file</th>
            <th>exec file</th>
            <th>tracked</th>
            <th>last run</th>
          </tr>
        </thead>
        <tbody>
          {data.plans.map((p) => (
            <tr key={p.slug}>
              <td>
                {p.execPath ? <Link to={`/plans/${encodeURIComponent(p.slug)}`}>{p.slug}</Link> : p.slug}
              </td>
              <td><code>{p.planPath ?? '—'}</code></td>
              <td><code>{p.execPath ?? '—'}</code></td>
              <td>
                {p.tracked === undefined ? '—' : <TrackedDot tracked={p.tracked} dirty={p.dirty} />}
              </td>
              <td>
                {p.lastRunId ? (
                  <Link to={`/runs/${encodeURIComponent(p.lastRunId)}`}>
                    {p.lastRunId} <span className="muted">({p.lastRunStatus})</span>
                  </Link>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TrackedDot({ tracked, dirty }: { tracked: boolean; dirty?: boolean }): JSX.Element {
  const variant = tracked && !dirty ? 'success' : dirty ? 'warning' : 'danger';
  const label = tracked && !dirty ? 'committed' : dirty ? 'dirty' : 'untracked';
  return <span className={`pill pill--${variant}`}>{label}</span>;
}

function RunsTable({ data, onPrune }: { data: InspectPayload; onPrune: (i: PruneRequest) => void }): JSX.Element {
  if (data.runs.length === 0) {
    return (
      <p className="muted">
        No runs yet. Start one with <code>yaao run &lt;plan.yaml&gt;</code> or via the{' '}
        <code>yaao_run</code> MCP tool.
      </p>
    );
  }
  return (
    <div className="card card--scroll">
      <table className="table">
        <thead>
          <tr>
            <th>run id</th>
            <th>plan</th>
            <th>status</th>
            <th>tasks</th>
            <th>branches alive</th>
            <th>started</th>
            <th>actions</th>
          </tr>
        </thead>
        <tbody>
          {data.runs.map((r) => (
            <tr key={r.runId}>
              <td><Link to={`/runs/${encodeURIComponent(r.runId)}`}><code>{r.runId}</code></Link></td>
              <td>{r.planSlug || '—'}</td>
              <td><RunStatusPill status={r.status} /></td>
              <td className="muted">
                {r.tasksCompleted}✓ / {r.tasksFailed}✗ / {r.tasksSkipped}⊘ of {r.tasksTotal}
              </td>
              <td className="muted" title={r.branchesAlive.join(', ')}>{r.branchesAlive.length}</td>
              <td className="muted">{new Date(r.startedAt).toLocaleString()}</td>
              <td><RunPruneMenu runId={r.runId} onPick={onPrune} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RunStatusPill({ status }: { status: string }): JSX.Element {
  const variant =
    status === 'success' ? 'success' :
    status === 'failed' ? 'danger' :
    status === 'cancelled' ? 'neutral' :
    status === 'running' ? 'running' : 'neutral';
  return <span className={`pill pill--${variant}`}>{status}</span>;
}

function RunPruneMenu({ runId, onPick }: { runId: string; onPick: (i: PruneRequest) => void }): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      <button className="btn" onClick={() => onPick({ target: 'run', runId, scope: ['worktrees'], dryRun: true })}>
        worktrees
      </button>
      <button className="btn" onClick={() => onPick({ target: 'run', runId, scope: ['branches'], dryRun: true })}>
        branches
      </button>
      <button className="btn" onClick={() => onPick({ target: 'run', runId, scope: ['worktrees', 'branches', 'runs'], dryRun: true })}>
        all
      </button>
    </div>
  );
}

function BulkPruneButton({ onPick }: { onPick: (i: PruneRequest) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button className="btn" onClick={() => setOpen(!open)}>Clean up…</button>
      {open ? (
        <div className="card" style={{ position: 'absolute', right: 0, top: '100%', marginTop: 4, padding: 4, zIndex: 10, display: 'flex', flexDirection: 'column', minWidth: 260 }}>
          <button className="btn btn--ghost" style={menuItemStyle} onClick={() => { setOpen(false); onPick({ target: 'all-completed', scope: ['worktrees', 'branches', 'runs'], dryRun: true }); }}>
            All completed runs
          </button>
          <button className="btn btn--ghost" style={menuItemStyle} onClick={() => { setOpen(false); onPick({ target: 'all-failed', scope: ['worktrees', 'branches', 'runs'], dryRun: true }); }}>
            All failed / cancelled runs
          </button>
          <button className="btn btn--ghost" style={menuItemStyle} onClick={() => { setOpen(false); onPick({ target: 'older-than', olderThanDays: 7, scope: ['worktrees', 'branches', 'runs'], dryRun: true }); }}>
            Older than 7 days
          </button>
        </div>
      ) : null}
    </div>
  );
}

const menuItemStyle: React.CSSProperties = { justifyContent: 'flex-start', width: '100%' };

function PruneModal({ intent, onClose }: { intent: PruneRequest; onClose: () => void }): JSX.Element {
  const [preview, setPreview] = useState<PruneResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [applyForce, setApplyForce] = useState(false);
  const [final, setFinal] = useState<PruneResponse | null>(null);

  useEffect(() => {
    setBusy(true);
    void api
      .prune({ ...intent, dryRun: true })
      .then((r) => setPreview(r))
      .finally(() => setBusy(false));
  }, [intent]);

  const apply = async (): Promise<void> => {
    setBusy(true);
    const r = await api.prune({ ...intent, dryRun: false, force: applyForce });
    setFinal(r);
    setBusy(false);
  };

  return (
    <div style={modalOverlay} onClick={onClose}>
      <div className="card card--padded" style={modal} onClick={(e) => e.stopPropagation()}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-3)' }}>
          <h3>Prune preview</h3>
          <button className="btn btn--ghost" onClick={onClose}>close</button>
        </header>
        <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
          target: <code>{intent.target}</code>
          {intent.runId ? <> · run: <code>{intent.runId}</code></> : null}
          {intent.scope ? <> · scope: {intent.scope.join(', ')}</> : null}
        </p>
        {busy && !preview ? <p className="muted">computing dry-run…</p> : null}
        {final ? <PruneResult result={final} /> : preview ? <PruneResult result={preview} /> : null}
        {!final && preview ? (
          <footer style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-3)', marginTop: 'var(--space-4)' }}>
            <label style={{ fontSize: 'var(--fs-sm)' }}>
              <input type="checkbox" checked={applyForce} onChange={(e) => setApplyForce(e.target.checked)} style={{ marginRight: 6 }} />
              Force (override safety checks)
            </label>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <button className="btn" onClick={onClose}>cancel</button>
              <button className="btn btn--danger" onClick={apply} disabled={busy}>Apply</button>
            </div>
          </footer>
        ) : null}
      </div>
    </div>
  );
}

function PruneResult({ result }: { result: PruneResponse }): JSX.Element {
  return (
    <dl className="dl-grid">
      <dt>removed worktrees</dt>
      <dd>{result.removed.worktrees.length === 0 ? <em className="muted">none</em> : <ul style={ulStyle}>{result.removed.worktrees.map((p) => <li key={p}><code>{p}</code></li>)}</ul>}</dd>
      <dt>removed branches</dt>
      <dd>{result.removed.branches.length === 0 ? <em className="muted">none</em> : <ul style={ulStyle}>{result.removed.branches.map((p) => <li key={p}><code>{p}</code></li>)}</ul>}</dd>
      <dt>removed run dirs</dt>
      <dd>{result.removed.runDirs.length === 0 ? <em className="muted">none</em> : <ul style={ulStyle}>{result.removed.runDirs.map((p) => <li key={p}><code>{p}</code></li>)}</ul>}</dd>
      {result.skipped.length > 0 ? (
        <>
          <dt>skipped</dt>
          <dd>
            <ul style={ulStyle}>
              {result.skipped.map((s, i) => (
                <li key={i}>
                  {s.kind} <code>{s.path}</code> — <span className="warning" style={{ color: 'var(--warning)' }}>{s.reason}</span>
                </li>
              ))}
            </ul>
          </dd>
        </>
      ) : null}
      {result.errors.length > 0 ? (
        <>
          <dt>errors</dt>
          <dd className="danger">
            <ul style={ulStyle}>
              {result.errors.map((e, i) => (
                <li key={i}>{e.code}: {e.message}</li>
              ))}
            </ul>
          </dd>
        </>
      ) : null}
    </dl>
  );
}

const ulStyle: React.CSSProperties = { margin: 0, paddingLeft: '1.25rem' };
const modalOverlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'grid', placeItems: 'center', zIndex: 100 };
const modal: React.CSSProperties = { minWidth: 'min(640px, 90vw)', maxWidth: '90vw', maxHeight: '90vh', overflow: 'auto' };
