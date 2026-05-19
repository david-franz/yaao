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

  if (error) return <p style={{ color: '#a00' }}>{error}</p>;
  if (!data) return <p>loading…</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <WorkspaceCard data={data} />
      <section>
        <h3 style={{ marginBottom: '0.5rem' }}>Plans</h3>
        <PlansTable data={data} />
      </section>
      <section>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.5rem' }}>
          <h3 style={{ margin: 0 }}>Runs ({data.runs.length})</h3>
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
    <section style={card}>
      <h3 style={{ margin: 0 }}>Workspace</h3>
      <dl style={dl}>
        <dt>cwd</dt><dd><code>{w.cwd}</code></dd>
        <dt>base-branch</dt><dd>{w.baseBranch}</dd>
        <dt>default-agent</dt><dd>{w.defaultAgent}</dd>
        <dt>worktree-root</dt><dd><code>{w.worktreeRoot}</code></dd>
        <dt>config</dt><dd><Link to="/config">{w.configPath ?? '(none)'}</Link></dd>
      </dl>
      {!w.inRepo ? (
        <p style={{ background: '#fde2e2', color: '#a00', padding: '0.5rem 1rem', borderRadius: 4, marginTop: '0.5rem' }}>
          Not a git repository. The plan-tracking gate and worktree-stamp lineage are both off — runs are unguarded.
        </p>
      ) : null}
    </section>
  );
}

function PlansTable({ data }: { data: InspectPayload }): JSX.Element {
  if (data.plans.length === 0) return <p style={{ color: '#666' }}>No plans yet.</p>;
  return (
    <table style={tbl}>
      <thead>
        <tr>
          <th style={th}>slug</th>
          <th style={th}>plan file</th>
          <th style={th}>exec file</th>
          <th style={th}>tracked</th>
          <th style={th}>last run</th>
        </tr>
      </thead>
      <tbody>
        {data.plans.map((p) => (
          <tr key={p.slug} style={tr}>
            <td style={td}>
              {p.execPath ? <Link to={`/plans/${encodeURIComponent(p.slug)}`}>{p.slug}</Link> : p.slug}
            </td>
            <td style={tdMono}>{p.planPath ?? '—'}</td>
            <td style={tdMono}>{p.execPath ?? '—'}</td>
            <td style={td}>
              {p.tracked === undefined ? '—' : <TrackedDot tracked={p.tracked} dirty={p.dirty} />}
            </td>
            <td style={td}>
              {p.lastRunId ? (
                <Link to={`/runs/${encodeURIComponent(p.lastRunId)}`}>
                  {p.lastRunId} <em style={{ color: '#666' }}>({p.lastRunStatus})</em>
                </Link>
              ) : (
                '—'
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TrackedDot({ tracked, dirty }: { tracked: boolean; dirty?: boolean }): JSX.Element {
  const colour = tracked && !dirty ? '#0a7f2e' : dirty ? '#c98a00' : '#a00';
  const label = tracked && !dirty ? 'committed' : dirty ? 'dirty' : 'untracked';
  return (
    <span title={label}>
      <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: colour, marginRight: 6 }} />
      {label}
    </span>
  );
}

function RunsTable({ data, onPrune }: { data: InspectPayload; onPrune: (i: PruneRequest) => void }): JSX.Element {
  if (data.runs.length === 0) {
    return (
      <p style={{ color: '#666' }}>
        No runs yet. Start one with <code>yaao run &lt;plan.yaml&gt;</code> or via the <code>yaao_run</code>
        MCP tool.
      </p>
    );
  }
  return (
    <table style={tbl}>
      <thead>
        <tr>
          <th style={th}>run id</th>
          <th style={th}>plan</th>
          <th style={th}>status</th>
          <th style={th}>tasks</th>
          <th style={th}>branches alive</th>
          <th style={th}>started</th>
          <th style={th}>actions</th>
        </tr>
      </thead>
      <tbody>
        {data.runs.map((r) => (
          <tr key={r.runId} style={tr}>
            <td style={tdMono}>
              <Link to={`/runs/${encodeURIComponent(r.runId)}`}>{r.runId}</Link>
            </td>
            <td style={td}>{r.planSlug || '—'}</td>
            <td style={td}>{r.status}</td>
            <td style={td}>
              {r.tasksCompleted}✓ / {r.tasksFailed}✗ / {r.tasksSkipped}⊘ of {r.tasksTotal}
            </td>
            <td style={td} title={r.branchesAlive.join(', ')}>
              {r.branchesAlive.length}
            </td>
            <td style={td}>{new Date(r.startedAt).toLocaleString()}</td>
            <td style={td}>
              <RunPruneMenu runId={r.runId} onPick={onPrune} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RunPruneMenu({ runId, onPick }: { runId: string; onPick: (i: PruneRequest) => void }): JSX.Element {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      <button onClick={() => onPick({ target: 'run', runId, scope: ['worktrees'], dryRun: true })}>
        worktrees
      </button>
      <button onClick={() => onPick({ target: 'run', runId, scope: ['branches'], dryRun: true })}>
        branches
      </button>
      <button onClick={() => onPick({ target: 'run', runId, scope: ['worktrees', 'branches', 'runs'], dryRun: true })}>
        all
      </button>
    </div>
  );
}

function BulkPruneButton({ onPick }: { onPick: (i: PruneRequest) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen(!open)}>Clean up…</button>
      {open ? (
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: '100%',
            marginTop: 4,
            background: '#fff',
            border: '1px solid #ccc',
            borderRadius: 4,
            padding: '0.25rem',
            zIndex: 10,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 220,
          }}
        >
          <button style={menuBtn} onClick={() => { setOpen(false); onPick({ target: 'all-completed', scope: ['worktrees', 'branches', 'runs'], dryRun: true }); }}>
            All completed runs (worktrees + branches + journals)
          </button>
          <button style={menuBtn} onClick={() => { setOpen(false); onPick({ target: 'all-failed', scope: ['worktrees', 'branches', 'runs'], dryRun: true }); }}>
            All failed/cancelled runs
          </button>
          <button style={menuBtn} onClick={() => { setOpen(false); onPick({ target: 'older-than', olderThanDays: 7, scope: ['worktrees', 'branches', 'runs'], dryRun: true }); }}>
            Older than 7 days
          </button>
        </div>
      ) : null}
    </div>
  );
}

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
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <h3 style={{ margin: 0 }}>Prune preview</h3>
          <button onClick={onClose}>close</button>
        </header>
        <p style={{ fontSize: 13, color: '#555' }}>
          target: <code>{intent.target}</code>
          {intent.runId ? <> · run: <code>{intent.runId}</code></> : null}
          {intent.scope ? <> · scope: {intent.scope.join(', ')}</> : null}
        </p>
        {busy && !preview ? <p>computing dry-run…</p> : null}
        {final ? <PruneResult result={final} /> : preview ? <PruneResult result={preview} /> : null}
        {!final && preview ? (
          <footer style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', marginTop: '0.5rem' }}>
            <label style={{ fontSize: 13 }}>
              <input type="checkbox" checked={applyForce} onChange={(e) => setApplyForce(e.target.checked)} />
              {' '}Force (override safety checks on items below)
            </label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button onClick={onClose}>cancel</button>
              <button onClick={apply} disabled={busy} style={{ background: '#a00', color: '#fff', border: 'none', padding: '0.25rem 0.75rem', borderRadius: 4 }}>
                Apply
              </button>
            </div>
          </footer>
        ) : null}
      </div>
    </div>
  );
}

function PruneResult({ result }: { result: PruneResponse }): JSX.Element {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.5rem 1rem', fontSize: 13 }}>
      <dt>removed worktrees</dt>
      <dd>{result.removed.worktrees.length === 0 ? <em>none</em> : <ul style={ul}>{result.removed.worktrees.map((p) => <li key={p}><code>{p}</code></li>)}</ul>}</dd>
      <dt>removed branches</dt>
      <dd>{result.removed.branches.length === 0 ? <em>none</em> : <ul style={ul}>{result.removed.branches.map((p) => <li key={p}><code>{p}</code></li>)}</ul>}</dd>
      <dt>removed run dirs</dt>
      <dd>{result.removed.runDirs.length === 0 ? <em>none</em> : <ul style={ul}>{result.removed.runDirs.map((p) => <li key={p}><code>{p}</code></li>)}</ul>}</dd>
      {result.skipped.length > 0 ? (
        <>
          <dt>skipped</dt>
          <dd>
            <ul style={ul}>
              {result.skipped.map((s, i) => (
                <li key={i}>
                  {s.kind} <code>{s.path}</code> — <em style={{ color: '#a06000' }}>{s.reason}</em>
                </li>
              ))}
            </ul>
          </dd>
        </>
      ) : null}
      {result.errors.length > 0 ? (
        <>
          <dt>errors</dt>
          <dd style={{ color: '#a00' }}>
            <ul style={ul}>
              {result.errors.map((e, i) => (
                <li key={i}>{e.code}: {e.message}</li>
              ))}
            </ul>
          </dd>
        </>
      ) : null}
    </div>
  );
}

const card: React.CSSProperties = { border: '1px solid #ddd', borderRadius: 4, padding: '0.75rem 1rem' };
const dl: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.125rem 0.75rem', margin: '0.5rem 0 0' };
const tbl: React.CSSProperties = { borderCollapse: 'collapse', width: '100%' };
const th: React.CSSProperties = { padding: '0.25rem 0.5rem', textAlign: 'left', borderBottom: '1px solid #ccc', fontWeight: 600 };
const tr: React.CSSProperties = { borderBottom: '1px solid #eee' };
const td: React.CSSProperties = { padding: '0.25rem 0.5rem' };
const tdMono: React.CSSProperties = { ...td, fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#444' };
const menuBtn: React.CSSProperties = { textAlign: 'left', padding: '0.4rem 0.6rem', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 13 };
const ul: React.CSSProperties = { margin: 0, paddingLeft: '1.25rem' };
const modalOverlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'grid', placeItems: 'center', zIndex: 100 };
const modal: React.CSSProperties = { background: '#fff', borderRadius: 6, padding: '1rem 1.25rem', maxWidth: 720, width: '95vw', maxHeight: '85vh', overflow: 'auto' };
