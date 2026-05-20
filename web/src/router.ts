/**
 * Tiny history-API router. Pages match against `location.pathname` via
 * a regex; the matched object is `{ name, params }`. `useRoute()` returns
 * the current match and re-renders on `popstate` / `yaao:navigate`.
 * `navigate(path)` pushes + triggers a re-render. `<Link>` lives in
 * router.tsx because of the JSX.
 *
 * Deliberately not react-router. The router does three things — match,
 * navigate, subscribe — and pulling in 30 KB for that ratio is overkill
 * for an MVP that has six pages total.
 */
import { useEffect, useState } from 'react';

export type RouteName =
  | 'workspace'
  | 'plans'
  | 'plan-detail'
  | 'plan-edit'
  | 'plan-source'
  | 'runs-latest'
  | 'run-detail'
  | 'config'
  | 'not-found';

export interface RouteMatch {
  name: RouteName;
  params: Record<string, string>;
  path: string;
}

const ROUTES: { pattern: RegExp; name: RouteName; params?: string[] }[] = [
  { pattern: /^\/$/, name: 'workspace' },
  { pattern: /^\/workspace\/?$/, name: 'workspace' },
  { pattern: /^\/plans\/?$/, name: 'plans' },
  { pattern: /^\/plans\/([^/]+)\/edit\/?$/, name: 'plan-edit', params: ['slug'] },
  { pattern: /^\/plans\/([^/]+)\/source\/?$/, name: 'plan-source', params: ['slug'] },
  { pattern: /^\/plans\/([^/]+)\/?$/, name: 'plan-detail', params: ['slug'] },
  { pattern: /^\/runs\/latest\/?$/, name: 'runs-latest' },
  { pattern: /^\/runs\/([^/]+)\/?$/, name: 'run-detail', params: ['runId'] },
  { pattern: /^\/config\/?$/, name: 'config' },
];

export function matchRoute(pathname: string): RouteMatch {
  for (const r of ROUTES) {
    const m = pathname.match(r.pattern);
    if (!m) continue;
    const params: Record<string, string> = {};
    if (r.params) r.params.forEach((p, i) => (params[p] = decodeURIComponent(m[i + 1] ?? '')));
    return { name: r.name, params, path: pathname };
  }
  return { name: 'not-found', params: {}, path: pathname };
}

export function useRoute(): RouteMatch {
  const [route, setRoute] = useState<RouteMatch>(() => matchRoute(window.location.pathname));
  useEffect(() => {
    const onPop = (): void => setRoute(matchRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    window.addEventListener('yaao:navigate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('yaao:navigate', onPop);
    };
  }, []);
  return route;
}

export function navigate(path: string): void {
  if (window.location.pathname === path) return;
  window.history.pushState({}, '', path);
  window.dispatchEvent(new CustomEvent('yaao:navigate'));
}
