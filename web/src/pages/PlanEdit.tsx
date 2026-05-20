import { useEffect, useRef, useState } from 'react';
import { api, subscribe, type PutPlanResp } from '../api.ts';
import { Link } from '../Link.tsx';
import { navigate } from '../router.ts';
import { layoutDag } from '../dag-layout.ts';

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

  if (error) return <p style={{ color: '#a00' }}>{error}</p>;
  if (diskBody === null) return <p>loading…</p>;

  const dirty = bufferDirtyRef.current;
  const preview = parsePreview(buffer);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '0.5rem' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <strong>{slug}</strong>{' '}
          <span style={{ color: dirty ? '#c98a00' : '#0a7f2e', fontSize: 12 }}>
            {dirty ? '● unsaved changes' : '✓ saved'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <Link to={`/plans/${encodeURIComponent(slug)}`}>← back to DAG</Link>
          <button onClick={save} disabled={saving || !dirty} style={saveBtn}>
            {saving ? 'saving…' : 'Save'}
          </button>
        </div>
      </header>
      {externalChange ? (
        <div style={banner}>
          The plan file changed on disk while you were editing.{' '}
          <button onClick={reloadFromDisk}>Reload from disk (discard my changes)</button>{' '}
          <button onClick={discardExternal}>Keep editing</button>
        </div>
      ) : null}
      {lastSaveResp && !lastSaveResp.ok ? (
        <div style={errorBanner}>
          <strong>Save rejected.</strong>
          <ul>
            {lastSaveResp.errors?.map((e, i) => (
              <li key={i}>
                <code>{e.code}</code>: {e.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {lastSaveResp && lastSaveResp.ok ? (
        <div style={okBanner}>Saved to <code>{lastSaveResp.path ?? '(unknown)'}</code>.</div>
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', flex: 1, minHeight: 0 }}>
        <textarea
          value={buffer}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: '100%',
            height: '100%',
            fontFamily: 'ui-monospace, monospace',
            fontSize: 13,
            border: '1px solid #ddd',
            borderRadius: 4,
            padding: '0.5rem',
            resize: 'none',
          }}
          spellCheck={false}
        />
        <div style={{ border: '1px solid #ddd', borderRadius: 4, padding: '0.5rem', overflow: 'auto' }}>
          {preview.error ? (
            <p style={{ color: '#c98a00', fontSize: 12 }}>YAML preview: {preview.error}</p>
          ) : preview.tasks.length === 0 ? (
            <p style={{ color: '#666' }}>No tasks parsed.</p>
          ) : (
            <DagPreview tasks={preview.tasks} />
          )}
          <p style={{ color: '#666', fontSize: 12, marginTop: '0.5rem' }}>
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
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        preserveAspectRatio="xMinYMin meet"
        style={{ display: 'block' }}
      >
        {layout.edges.map((e) => (
          <path
            key={`${e.fromId}->${e.toId}`}
            d={`M ${e.fromX} ${e.fromY} C ${e.fromX + 30} ${e.fromY}, ${e.toX - 30} ${e.toY}, ${e.toX} ${e.toY}`}
            stroke="#999"
            fill="none"
            strokeWidth={1.5}
          />
        ))}
        {layout.nodes.map((n) => (
          <g key={n.id} transform={`translate(${n.x}, ${n.y})`}>
            <title>{`${n.id} — ${n.title} (${n.agent})`}</title>
            <rect width={n.width} height={n.height} rx={6} fill="#fff" stroke="#888" />
            <text x={12} y={22} fontSize={13} fontWeight={600}>
              {n.id}
            </text>
            <text x={12} y={40} fontSize={11} fill="#555">
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
    <small style={{ color: '#666', fontSize: 11 }}>
      Save runs the full server-side validatePlan pipeline. Schema-valid plans with dependency
      cycles are caught before the file is written.
    </small>
  );
}

const saveBtn: React.CSSProperties = {
  background: '#0066cc',
  color: '#fff',
  border: 'none',
  padding: '0.25rem 0.75rem',
  borderRadius: 4,
  cursor: 'pointer',
};
const banner: React.CSSProperties = {
  background: '#fffae5',
  border: '1px solid #f0d04a',
  padding: '0.5rem 0.75rem',
  borderRadius: 4,
  fontSize: 13,
};
const errorBanner: React.CSSProperties = { background: '#fde2e2', border: '1px solid #f0a4a4', padding: '0.5rem 0.75rem', borderRadius: 4, color: '#a00', fontSize: 13 };
const okBanner: React.CSSProperties = { background: '#dff2e0', border: '1px solid #90c794', padding: '0.5rem 0.75rem', borderRadius: 4, color: '#0a7f2e', fontSize: 13 };

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
