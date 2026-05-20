import { Suspense, lazy } from 'react';
import { useRoute } from './router.ts';
import { Link } from './Link.tsx';
import { Plans } from './pages/Plans.tsx';
import { PlanDetail } from './pages/PlanDetail.tsx';
import { useTheme } from './theme.ts';

// Pages that aren't on the critical first-paint path are lazy-loaded so
// the initial bundle stays small.
const Workspace = lazy(() => import('./pages/Workspace.tsx').then((m) => ({ default: m.Workspace })));
const RunDetail = lazy(() => import('./pages/RunDetail.tsx').then((m) => ({ default: m.RunDetail })));
const PlanEdit = lazy(() => import('./pages/PlanEdit.tsx').then((m) => ({ default: m.PlanEdit })));
const PlanSource = lazy(() => import('./pages/PlanSource.tsx').then((m) => ({ default: m.PlanSource })));
const ConfigPage = lazy(() => import('./pages/Config.tsx').then((m) => ({ default: m.ConfigPage })));

export function App(): JSX.Element {
  const route = useRoute();
  return (
    <div className="app">
      <Nav routeName={route.name} />
      <main className="app__main">
        <Suspense fallback={<p className="muted">loading…</p>}>{routeView(route)}</Suspense>
      </main>
    </div>
  );
}

function Nav({ routeName }: { routeName: ReturnType<typeof useRoute>['name'] }): JSX.Element {
  const { theme, toggle } = useTheme();
  // Map each route name to the nav entry that should highlight; lets a
  // detail route (`plan-detail`) still highlight its parent nav (`plans`).
  const active: Record<string, string> = {
    workspace: 'workspace',
    plans: 'plans',
    'plan-detail': 'plans',
    'plan-edit': 'plans',
    'plan-source': 'plans',
    'run-detail': 'runs',
    'runs-latest': 'runs',
    config: 'config',
  };
  const current = active[routeName] ?? '';
  return (
    <header className="app__header">
      <div className="app__brand">yaao</div>
      <nav className="app__nav">
        <Link to="/workspace" aria-current={current === 'workspace' ? 'page' : undefined}>
          workspace
        </Link>
        <Link to="/plans" aria-current={current === 'plans' ? 'page' : undefined}>
          plans
        </Link>
        <Link to="/runs/latest" aria-current={current === 'runs' ? 'page' : undefined}>
          latest run
        </Link>
        <Link to="/config" aria-current={current === 'config' ? 'page' : undefined}>
          config
        </Link>
      </nav>
      <button
        className="btn btn--ghost btn--icon"
        onClick={toggle}
        title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
        aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
      >
        {theme === 'light' ? <MoonIcon /> : <SunIcon />}
      </button>
    </header>
  );
}

function SunIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
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
    case 'plan-source':
      return <PlanSource slug={route.params['slug'] ?? ''} />;
    case 'run-detail':
      // `key` forces a remount whenever the runId changes — including the
      // resolution from runs-latest → /runs/<id>. Without it, RunDetail's
      // useState initializer (which seeds resolvedId from the runId prop)
      // runs once and never picks up the resolved id, so the page stays
      // stuck on "resolving latest run…" forever.
      return <RunDetail key={route.params['runId'] ?? ''} runId={route.params['runId'] ?? ''} />;
    case 'runs-latest':
      return <RunDetail key="latest" runId="latest" />;
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
