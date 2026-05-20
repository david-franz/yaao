import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Link } from '../Link.tsx';

export function Plans(): JSX.Element {
  const [plans, setPlans] = useState<{ slug: string; path: string; mtimeMs: number }[] | null>(null);
  useEffect(() => {
    void api.plans().then((r) => setPlans(r.plans));
  }, []);
  if (!plans) return <p className="muted">loading…</p>;
  if (plans.length === 0) {
    return (
      <div className="card card--padded empty">
        No execution plans yet. Generate one with <code>yaao plan</code> and{' '}
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
            <th>path</th>
            <th>modified</th>
          </tr>
        </thead>
        <tbody>
          {plans.map((p) => (
            <tr key={p.slug}>
              <td>
                <Link to={`/plans/${encodeURIComponent(p.slug)}`}>{p.slug}</Link>
              </td>
              <td>
                <code>{p.path}</code>
              </td>
              <td className="muted">{new Date(p.mtimeMs).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
