import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Link } from '../Link.tsx';

export function Plans(): JSX.Element {
  const [plans, setPlans] = useState<{ slug: string; path: string; mtimeMs: number }[] | null>(null);
  useEffect(() => {
    void api.plans().then((r) => setPlans(r.plans));
  }, []);
  if (!plans) return <p>loading…</p>;
  if (plans.length === 0) {
    return (
      <p>
        No execution plans yet. Generate one with <code>yaao plan</code> and{' '}
        <code>yaao convert</code>.
      </p>
    );
  }
  return (
    <table style={{ borderCollapse: 'collapse', minWidth: 480 }}>
      <thead>
        <tr>
          <th style={th}>slug</th>
          <th style={th}>path</th>
          <th style={th}>modified</th>
        </tr>
      </thead>
      <tbody>
        {plans.map((p) => (
          <tr key={p.slug} style={{ borderBottom: '1px solid #eee' }}>
            <td style={td}>
              <Link to={`/plans/${encodeURIComponent(p.slug)}`}>{p.slug}</Link>
            </td>
            <td style={{ ...td, color: '#666', fontFamily: 'monospace', fontSize: 12 }}>{p.path}</td>
            <td style={td}>{new Date(p.mtimeMs).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const th = { padding: '0.25rem 0.5rem', textAlign: 'left' as const, borderBottom: '1px solid #ccc' };
const td = { padding: '0.25rem 0.5rem' };
