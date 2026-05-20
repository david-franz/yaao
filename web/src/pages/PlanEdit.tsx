import { useEffect, useRef, useState } from 'react';
import { api, subscribe, type PutPlanResp } from '../api.ts';
import { Link } from '../Link.tsx';
import { navigate } from '../router.ts';
import { layoutDag } from '../dag-layout.ts';
import { CodeEditor } from '../CodeEditor.tsx';

/**
 * F13.5 plan editor. Pragmatic v1: a textarea, not Monaco. Saving
 * goes through PUT /api/plans/:slug/raw, which runs the full
 * validatePlan pipeline server-side, so structural validity is
 * always the server's verdict — what the editor renders client-side
 * is purely advisory.
 *
 * The right pane is a live DAG preview of the unsaved buffer. We
 * parse the YAML client-side just enough to extract task ids +
 * depends, then run the same `layoutDag` F13.2 uses. The preview
 * lags actual save validation (a structurally invalid YAML shows
 * no DAG; that's fine — fix the YAML first).
 *
 * `/api/plans/:slug/watch` fires when the file changes on disk
 * (e.g. the user edited in their IDE while the page was open). If
 * the textarea has unsaved changes we surface a non-modal banner
 * with three actions: reload from disk, keep editing, show diff.
 * If there are no unsaved changes we silently reload.
 */
export function PlanEdit({ slug }: { slug: string }): JSX.Element {
  const [diskBody, setDiskBody] = useState<string | null>(null);
  const [buffer, setBuffer] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [lastSaveResp, setLastSaveResp] = useState<PutPlanResp | null>(null);
  const [externalChange, setExternalChange] = useState<{ newDiskBody: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bufferDirtyRef = useRef(false);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    void api
      .planRaw(slug)
      .then((body) => {
        if (cancelled) return;
        setDiskBody(body);
        setBuffer(body);
        bufferDirtyRef.current = false;
      })
      .catch((e: unknown) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // Watch the file. On change, if the editor is clean reload silently;
  // if dirty, surface the banner.
  useEffect(() => {
    return subscribe(`/api/plans/${encodeURIComponent(slug)}/watch`, {
      change: async () => {
        try {
          const fresh = await api.planRaw(slug);
          if (!bufferDirtyRef.current) {
            setDiskBody(fresh);
            setBuffer(fresh);
            return;
          }
          if (fresh !== buffer) setExternalChange({ newDiskBody: fresh });
        } catch (e) {
          setError(String(e));
        }
      },
    });
    // We want this to fire once per slug, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const onChange = (val: string): void => {
    setBuffer(val);
    bufferDirtyRef.current = diskBody !== null && val !== diskBody;
    setLastSaveResp(null);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const resp = await api.putPlanRaw(slug, buffer);
      setLastSaveResp(resp);
      if (resp.ok) {
        setDiskBody(buffer);
        bufferDirtyRef.current = false;
      }
    } finally {
      setSaving(false);
    }
  };

  const reloadFromDisk = (): void => {
    if (externalChange) {
      setDiskBody(externalChange.newDiskBody);
      setBuffer(externalChange.newDiskBody);
      bufferDirtyRef.current = false;
      setExternalChange(null);
    }
  };
  const discardExternal = (): void => setExternalChange(null);

  if (error) return <div className="banner banner--danger">{error}</div>;
  if (diskBody === null) return <p className="muted">loading…</p>;

  const dirty = bufferDirtyRef.current;
  const preview = parsePreview(buffer);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 'var(--space-3)' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <strong style={{ fontSize: 'var(--fs-lg)' }}>{slug}</strong>
          <span className={`pill pill--${dirty ? 'warning' : 'success'}`}>
            {dirty ? '● unsaved' : '✓ saved'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
          <Link to={`/plans/${encodeURIComponent(slug)}`}>← back to DAG</Link>
          <button className="btn btn--primary" onClick={save} disabled={saving || !dirty}>
            {saving ? 'saving…' : 'Save'}
          </button>
        </div>
      </header>
      {externalChange ? (
        <div className="banner banner--warning">
          The plan file changed on disk while you were editing.{' '}
          <button className="btn" onClick={reloadFromDisk}>Reload from disk</button>
          <button className="btn btn--ghost" onClick={discardExternal}>Keep editing</button>
        </div>
      ) : null}
      {lastSaveResp && !lastSaveResp.ok ? (
        <div className="banner banner--danger" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <strong>Save rejected.</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: '1.25rem' }}>
            {lastSaveResp.errors?.map((e, i) => (
              <li key={i}><code>{e.code}</code>: {e.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {lastSaveResp && lastSaveResp.ok ? (
        <div className="banner banner--success">Saved to <code>{lastSaveResp.path ?? '(unknown)'}</code>.</div>
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-4)', flex: 1, minHeight: 0 }}>
        <CodeEditor value={buffer} onChange={onChange} language="yaml" />
        <div className="card card--padded card--scroll">
          {preview.error ? (
            <p className="muted" style={{ color: 'var(--warning)' }}>YAML preview: {preview.error}</p>
          ) : preview.tasks.length === 0 ? (
            <p className="muted">No tasks parsed.</p>
          ) : (
            <DagPreview tasks={preview.tasks} />
          )}
          <p className="subtle" style={{ fontSize: 'var(--fs-xs)', marginTop: 'var(--space-3)' }}>
            Preview is a structural sketch of the current buffer. Schema + DAG validity is checked
            server-side when you save.
          </p>
        </div>
      </div>
      <PlanEditFooter onNavigate={() => { if (dirty && !confirm('Discard unsaved changes?')) return; navigate(`/plans/${encodeURIComponent(slug)}`); }} />
    </div>
  );
}

function DagPreview({ tasks }: { tasks: { id: string; title: string; agent: string; depends: string[] }[] }): JSX.Element {
  const layout = layoutDag(tasks);
  return (
    // Render at native pixel size; the surrounding container's overflow:auto
    // gives a horizontal scrollbar for long plans instead of squashing labels.
    <div style={{ overflow: 'auto' }}>
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
        {layout.nodes.map((n) => (
          <g key={n.id} transform={`translate(${n.x}, ${n.y})`}>
            <title>{`${n.id} — ${n.title} (${n.agent})`}</title>
            <rect width={n.width} height={n.height} rx={6} />
            <text x={12} y={22} fontSize={13} fontWeight={600} className="dag-id">
              {n.id}
            </text>
            <text x={12} y={40} fontSize={11} className="dag-title">
              {(n.title || '').slice(0, 22)}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function PlanEditFooter({ onNavigate: _onNavigate }: { onNavigate: () => void }): JSX.Element {
  return (
    <small className="subtle">
      Save runs the full server-side validatePlan pipeline. Schema-valid plans with dependency
      cycles are caught before the file is written.
    </small>
  );
}

/**
 * Lightweight YAML parse: just enough to extract `tasks[*].id`,
 * `title`, `agent`, `depends`. Avoids pulling a YAML parser into the
 * browser bundle by being explicitly tolerant — anything malformed
 * collapses to `{ error, tasks: [] }`. The server-side validator is
 * the source of truth.
 */
function parsePreview(yaml: string): { error?: string; tasks: { id: string; title: string; agent: string; depends: string[] }[] } {
  // Find the tasks: block.
  const tasksIdx = yaml.search(/^tasks:\s*$/m);
  if (tasksIdx < 0) return { tasks: [] };
  const lines = yaml.slice(tasksIdx).split('\n').slice(1);
  const tasks: { id: string; title: string; agent: string; depends: string[] }[] = [];
  let cur: { id: string; title: string; agent: string; depends: string[] } | null = null;
  let inDepends = false;
  for (const rawLine of lines) {
    if (/^[A-Za-z]/.test(rawLine)) break; // back at top-level block
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (inDepends && cur && trimmed.startsWith('- ')) {
      // Block-list continuation under `depends:`. Each `- item` line is
      // a single dependency id, not a new task. Distinguished from the
      // new-task case by tracking inDepends across iterations.
      cur.depends.push(trimmed.slice(2).trim().replace(/^["']|["']$/g, ''));
      continue;
    }
    if (trimmed.startsWith('- ')) {
      if (cur) tasks.push(cur);
      cur = { id: '', title: '', agent: '', depends: [] };
      inDepends = false;
      const rest = trimmed.slice(2).trim();
      if (rest.startsWith('id:')) cur.id = rest.slice(3).trim().replace(/^["']|["']$/g, '');
    } else if (cur) {
      const m = /^([\w-]+):\s*(.*)$/.exec(trimmed);
      if (m) {
        const [, key, value] = m;
        const valTrim = (value ?? '').trim().replace(/^["']|["']$/g, '');
        if (key === 'id') cur.id = valTrim;
        else if (key === 'title') cur.title = valTrim;
        else if (key === 'agent') cur.agent = valTrim;
        else if (key === 'depends') {
          inDepends = true;
          // Inline form: depends: [a, b]
          if (valTrim.startsWith('[') && valTrim.endsWith(']')) {
            cur.depends = valTrim
              .slice(1, -1)
              .split(',')
              .map((s) => s.trim().replace(/^["']|["']$/g, ''))
              .filter(Boolean);
            inDepends = false;
          } else if (valTrim) {
            // single-value form
            cur.depends = [valTrim];
            inDepends = false;
          }
        } else if (inDepends && trimmed.startsWith('-')) {
          cur.depends.push(trimmed.slice(1).trim().replace(/^["']|["']$/g, ''));
        }
      } else if (inDepends && trimmed.startsWith('-')) {
        cur.depends.push(trimmed.slice(1).trim().replace(/^["']|["']$/g, ''));
      }
    }
  }
  if (cur) tasks.push(cur);
  return { tasks: tasks.filter((t) => t.id) };
}

export const __testing = { parsePreview };
