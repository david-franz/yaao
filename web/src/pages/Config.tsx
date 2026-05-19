import { useEffect, useRef, useState } from 'react';
import { api, subscribe, type PutConfigResp } from '../api.ts';
import { Link } from '../Link.tsx';

/**
 * F13.6 config editor. Two tabs over the same on-disk JSON:
 *
 *   - Form view: schema-driven settings UI for the highest-traffic
 *     fields (defaults, merge strategy, run gate, agent enable/bin
 *     toggles, API providers, mcp-servers). Renders as a structured
 *     form so the user doesn't need to know the JSON shape.
 *
 *   - Raw view: textarea over the full JSON document. Same shape as
 *     the F13.5 plan editor's raw pane. Useful for advanced fields
 *     that don't have a form representation.
 *
 * Both tabs save through PUT /api/config/raw, which runs
 * ConfigSchema.safeParse + the literal-secret detector
 * server-side. The editor never sees resolved secret values; only
 * `${ENV_VAR}` placeholders flow through.
 *
 * Live reload via /api/config/watch — same pattern as the plan
 * editor's file-change banner. yaao init / yaao doctor --fix can
 * rewrite the file from the CLI without clobbering an open editor.
 */
export function ConfigPage(): JSX.Element {
  const [tab, setTab] = useState<'form' | 'raw'>('form');
  const [diskBody, setDiskBody] = useState<string | null>(null);
  const [buffer, setBuffer] = useState('');
  const [saving, setSaving] = useState(false);
  const [resp, setResp] = useState<PutConfigResp | null>(null);
  const [externalChange, setExternalChange] = useState<{ newDiskBody: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void api.configRaw().then((body) => {
      if (cancelled) return;
      setDiskBody(body);
      setBuffer(body);
      dirtyRef.current = false;
    }).catch((e: unknown) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return subscribe('/api/config/watch', {
      change: async () => {
        try {
          const fresh = await api.configRaw();
          if (!dirtyRef.current) {
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
    // intentionally subscribe once per mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onBufferChange = (val: string): void => {
    setBuffer(val);
    dirtyRef.current = diskBody !== null && val !== diskBody;
    setResp(null);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      const r = await api.putConfigRaw(buffer);
      setResp(r);
      if (r.ok) {
        setDiskBody(buffer);
        dirtyRef.current = false;
      }
    } finally {
      setSaving(false);
    }
  };

  const reloadFromDisk = (): void => {
    if (externalChange) {
      setDiskBody(externalChange.newDiskBody);
      setBuffer(externalChange.newDiskBody);
      dirtyRef.current = false;
      setExternalChange(null);
    }
  };

  if (error) return <p style={{ color: '#a00' }}>{error}</p>;
  if (diskBody === null) return <p>loading…</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', height: '100%' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <strong>yaao.config.json</strong>{' '}
          <span style={{ color: dirtyRef.current ? '#c98a00' : '#0a7f2e', fontSize: 12 }}>
            {dirtyRef.current ? '● unsaved changes' : '✓ saved'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <Link to="/workspace">← workspace</Link>
          <button onClick={save} disabled={saving || !dirtyRef.current} style={saveBtn}>
            {saving ? 'saving…' : 'Save'}
          </button>
        </div>
      </header>
      {externalChange ? (
        <div style={banner}>
          The config changed on disk while you were editing.{' '}
          <button onClick={reloadFromDisk}>Reload from disk (discard my changes)</button>{' '}
          <button onClick={() => setExternalChange(null)}>Keep editing</button>
        </div>
      ) : null}
      {resp && !resp.ok ? (
        <div style={errorBanner}>
          <strong>Save rejected.</strong>
          <ul>
            {resp.errors?.map((e, i) => (
              <li key={i}>
                <code>{e.code}</code>: {e.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {resp && resp.ok ? (
        <div style={okBanner}>
          Saved. <em>This applies to runs that start from now on; in-flight runs use the
          previous config.</em>
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <Tab name="Form" active={tab === 'form'} onClick={() => setTab('form')} />
        <Tab name="Raw" active={tab === 'raw'} onClick={() => setTab('raw')} />
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 'form' ? (
          <FormView buffer={buffer} onBufferChange={onBufferChange} />
        ) : (
          <RawView buffer={buffer} onBufferChange={onBufferChange} />
        )}
      </div>
      <small style={{ color: '#666', fontSize: 11 }}>
        Saves run ConfigSchema.safeParse + a literal-secret detector. API keys must reference
        environment variables with the <code>${'${VAR}'}</code> form; literal keys are rejected.
      </small>
    </div>
  );
}

function Tab({ name, active, onClick }: { name: string; active: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? '#fff' : '#f4f4f4',
        border: '1px solid #ccc',
        borderBottomColor: active ? '#fff' : '#ccc',
        padding: '0.25rem 1rem',
        cursor: 'pointer',
        fontWeight: active ? 600 : 400,
      }}
    >
      {name}
    </button>
  );
}

function RawView({ buffer, onBufferChange }: { buffer: string; onBufferChange: (v: string) => void }): JSX.Element {
  return (
    <textarea
      value={buffer}
      onChange={(e) => onBufferChange(e.target.value)}
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
  );
}

function FormView({ buffer, onBufferChange }: { buffer: string; onBufferChange: (v: string) => void }): JSX.Element {
  // Parse the buffer client-side. On a parse error we fall back to the
  // raw view's behaviour: render a notice and let the user fix it via
  // the Raw tab.
  let parsed: Record<string, unknown> | null = null;
  let parseError: string | null = null;
  try {
    parsed = JSON.parse(buffer) as Record<string, unknown>;
  } catch (e) {
    parseError = (e as Error).message;
  }
  if (parseError !== null) {
    return (
      <p style={{ color: '#a00', fontSize: 13 }}>
        Config isn't valid JSON ({parseError}). Switch to the Raw tab to fix.
      </p>
    );
  }
  if (!parsed) return <p>—</p>;

  // Render a structured form. Every change writes back through
  // `update` which re-serialises the whole document. We do the
  // re-serialise rather than mutating in place so the displayed
  // buffer always matches what would actually be saved.
  const cfg = parsed;
  const update = (mut: (c: Record<string, unknown>) => void): void => {
    const next = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>;
    mut(next);
    onBufferChange(JSON.stringify(next, null, 2));
  };
  const defaults = (cfg['defaults'] ?? {}) as Record<string, unknown>;
  const merge = (cfg['merge'] ?? {}) as Record<string, unknown>;
  const run = (cfg['run'] ?? {}) as Record<string, unknown>;
  const agentsBlock = (cfg['agents'] ?? {}) as Record<string, unknown>;
  const apiCfg = (agentsBlock['api'] ?? {}) as Record<string, unknown>;
  const providers = (apiCfg['providers'] ?? {}) as Record<string, { 'api-key'?: string }>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <Section title="Defaults">
        <Row label="agent">
          <SelectField
            value={String(defaults['agent'] ?? '')}
            options={['claude-code', 'cursor', 'copilot', 'codex', 'api']}
            onChange={(v) => update((c) => assignAt(c, ['defaults', 'agent'], v))}
          />
        </Row>
        <Row label="model"><TextField value={String(defaults['model'] ?? '')} onChange={(v) => update((c) => assignAt(c, ['defaults', 'model'], v))} /></Row>
        <Row label="max-parallel"><TextField value={String(defaults['max-parallel'] ?? '')} onChange={(v) => update((c) => assignAt(c, ['defaults', 'max-parallel'], Number(v) || v))} /></Row>
        <Row label="base-branch"><TextField value={String(defaults['base-branch'] ?? '')} onChange={(v) => update((c) => assignAt(c, ['defaults', 'base-branch'], v))} /></Row>
        <Row label="worktree-root"><TextField value={String(defaults['worktree-root'] ?? '')} onChange={(v) => update((c) => assignAt(c, ['defaults', 'worktree-root'], v))} /></Row>
      </Section>
      <Section title="Merge">
        <Row label="strategy">
          <SelectField value={String(merge['strategy'] ?? 'auto')} options={['auto', 'pr', 'manual']} onChange={(v) => update((c) => assignAt(c, ['merge', 'strategy'], v))} />
        </Row>
        <Row label="on-conflict">
          <SelectField value={String(merge['on-conflict'] ?? 'agent')} options={['agent', 'manual']} onChange={(v) => update((c) => assignAt(c, ['merge', 'on-conflict'], v))} />
        </Row>
        <Row label="history">
          <SelectField value={String(merge['history'] ?? 'merge')} options={['merge', 'rebase']} onChange={(v) => update((c) => assignAt(c, ['merge', 'history'], v))} />
        </Row>
      </Section>
      <Section title="Run gates">
        <Row label="require-tracked-plan">
          <SelectField value={String(run['require-tracked-plan'] ?? 'error')} options={['error', 'warn', 'off']} onChange={(v) => update((c) => assignAt(c, ['run', 'require-tracked-plan'], v))} />
        </Row>
      </Section>
      <Section title="API providers">
        {Object.keys(providers).length === 0 ? (
          <p style={{ color: '#666', fontSize: 13 }}>No providers configured.</p>
        ) : (
          Object.entries(providers).map(([name, prov]) => (
            <Row key={name} label={name}>
              <TextField
                value={String(prov['api-key'] ?? '')}
                onChange={(v) => update((c) => assignAt(c, ['agents', 'api', 'providers', name, 'api-key'], v))}
                placeholder="${PROVIDER_API_KEY}"
              />
              <p style={{ fontSize: 11, color: '#666', margin: '0.125rem 0 0' }}>
                Must be a <code>${'${ENV_VAR}'}</code> reference; literal keys are rejected on save.
              </p>
            </Row>
          ))
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section style={{ border: '1px solid #ddd', borderRadius: 4, padding: '0.75rem 1rem' }}>
      <h4 style={{ margin: '0 0 0.5rem' }}>{title}</h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label style={{ display: 'grid', gridTemplateColumns: '160px 1fr', alignItems: 'center', gap: '0.5rem', fontSize: 13 }}>
      <span>{label}</span>
      <span>{children}</span>
    </label>
  );
}

function TextField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }): JSX.Element {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{ width: '100%', padding: '0.25rem 0.5rem', border: '1px solid #ccc', borderRadius: 4 }}
    />
  );
}

function SelectField({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }): JSX.Element {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ padding: '0.25rem 0.5rem' }}>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
}

function assignAt(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    if (typeof cur[key] !== 'object' || cur[key] === null) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[path[path.length - 1]!] = value;
}

const saveBtn: React.CSSProperties = {
  background: '#0066cc',
  color: '#fff',
  border: 'none',
  padding: '0.25rem 0.75rem',
  borderRadius: 4,
  cursor: 'pointer',
};
const banner: React.CSSProperties = { background: '#fffae5', border: '1px solid #f0d04a', padding: '0.5rem 0.75rem', borderRadius: 4, fontSize: 13 };
const errorBanner: React.CSSProperties = { background: '#fde2e2', border: '1px solid #f0a4a4', padding: '0.5rem 0.75rem', borderRadius: 4, color: '#a00', fontSize: 13 };
const okBanner: React.CSSProperties = { background: '#dff2e0', border: '1px solid #90c794', padding: '0.5rem 0.75rem', borderRadius: 4, color: '#0a7f2e', fontSize: 13 };

export const __testing = { assignAt };
