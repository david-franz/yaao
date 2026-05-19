import { useEffect, useState } from 'react';

interface Health {
  ok: boolean;
  version: string;
  cwd: string;
}

export function App(): JSX.Element {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch('/api/health')
      .then((r) => r.json() as Promise<Health>)
      .then(setHealth)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: '40rem' }}>
      <h1 style={{ fontSize: '1.5rem', margin: 0 }}>yaao web — wired up</h1>
      <p style={{ color: '#555', marginTop: '0.5rem' }}>
        Scaffold (F13.0). Feature surface lands in F13.1 onwards.
      </p>
      {error !== null ? (
        <pre style={{ color: '#a00' }}>error: {error}</pre>
      ) : health ? (
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 1rem' }}>
          <dt>version</dt>
          <dd>{health.version}</dd>
          <dt>cwd</dt>
          <dd>
            <code>{health.cwd}</code>
          </dd>
        </dl>
      ) : (
        <p>loading…</p>
      )}
    </main>
  );
}
