import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import { api } from '../api.ts';
import { Link } from '../Link.tsx';

/**
 * View the implementation-plan source for a slug — the human-readable
 * `.yaao/plans/<slug>.md` that authored the execution plan. Rendered
 * via the `marked` library; the parsed HTML is dropped into a
 * `prose`-styled container so headings, code blocks, lists, and
 * tables all look like a real read-the-docs page rather than raw
 * pre-formatted text.
 *
 * marked is configured with GFM (tables, fenced code blocks, strike)
 * and breaks=false so soft line breaks don't litter the output. We
 * don't render user-supplied HTML — `marked` escapes by default.
 */
export function PlanSource({ slug }: { slug: string }): JSX.Element {
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api
      .planSource(slug)
      .then((b) => {
        if (cancelled) return;
        setBody(b);
      })
      .catch((e: unknown) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [slug]);

  const html = useMemo(() => {
    if (body === null) return '';
    marked.setOptions({ gfm: true, breaks: false });
    return marked.parse(body, { async: false }) as string;
  }, [body]);

  if (error) return <div className="banner banner--danger">{error}</div>;
  if (body === null) return <p className="muted">loading…</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', height: '100%' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <Link to="/plans">← plans</Link>
          <strong style={{ fontSize: 'var(--fs-lg)' }}>{slug}</strong>
          <span className="muted">· implementation plan</span>
        </div>
        <Link to={`/plans/${encodeURIComponent(slug)}`}>DAG view →</Link>
      </header>
      <article
        className="card card--padded card--scroll prose"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
