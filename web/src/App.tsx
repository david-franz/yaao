import { Suspense, lazy } from 'react';
import { useRoute } from './router.ts';
import { Link } from './Link.tsx';
import { Plans } from './pages/Plans.tsx';
import { PlanDetail } from './pages/PlanDetail.tsx';

// Pages that aren't on the critical first-paint path are lazy-loaded so
// the initial bundle stays small.
const Workspace = lazy(() => import('./pages/Workspace.tsx').then((m) => ({ default: m.Workspace })));
const RunDetail = lazy(() => import('./pages/RunDetail.tsx').then((m) => ({ default: m.RunDetail })));
const PlanEdit = lazy(() => import('./pages/PlanEdit.tsx').then((m) => ({ default: m.PlanEdit })));
const ConfigPage = lazy(() => import('./pages/Config.tsx').then((m) => ({ default: m.ConfigPage })));

export function App(): JSX.Element {
  const route = useRoute();
  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Nav />
      <main style={{ padding: '1rem', flex: 1, overflow: 'auto' }}>
        <Suspense fallback={<p>loading…</p>}>{routeView(route)}</Suspense>
      </main>
    </div>
  );
}

function Nav(): JSX.Element {
  return (
    <nav
      style={{
        display: 'flex',
        gap: '1rem',
        padding: '0.5rem 1rem',
        borderBottom: '1px solid #ddd',
        alignItems: 'center',
      }}
    >
      <strong>yaao web</strong>
      <Link to="/workspace">workspace</Link>
      <Link to="/plans">plans</Link>
      <Link to="/runs/latest">latest run</Link>
      <Link to="/config">config</Link>
    </nav>
  );
}

function routeView(route: ReturnType<typeof useRoute>): JSX.Element {
  switch (route.name) {
    case 'workspace':
      return <Workspace />;
    case 'plans':
      return <Plans />;
    case 'plan-detail':
      return <PlanDetail slug={route.params['slug'] ?? ''} />;
    case 'plan-edit':
      return <PlanEdit slug={route.params['slug'] ?? ''} />;
    case 'run-detail':
      return <RunDetail runId={route.params['runId'] ?? ''} />;
    case 'runs-latest':
      return <RunDetail runId="latest" />;
    case 'config':
      return <ConfigPage />;
    case 'not-found':
    default:
      return (
        <p>
          404 · <Link to="/workspace">go home</Link>
        </p>
      );
  }
}
