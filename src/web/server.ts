/**
 * `yaao web` HTTP listener (F13.0 scaffold).
 *
 * Single hono server bound to loopback by default. F13.0 only exposes
 * `GET /` (the bundled React app) + `GET /api/health` so the build + bundle
 * resolution + listener wiring are exercisable end-to-end before any
 * feature surface lands. F13.1 onwards add the rest of `/api/*`.
 *
 * Static asset resolution is relative to the package's installed location
 * (`dist/bin/yaao.js` → `../web/index.html`), so global installs and `npm
 * link` both work without the user pointing at the bundle by hand.
 */

import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { serve as honoServe } from '@hono/node-server';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../version.js';
import type { AddressInfo } from 'node:net';

export interface StartWebServerOptions {
  cwd: string;
  /** Bind host. Default `127.0.0.1`. */
  host?: string;
  /** Bind port. Default `0` (kernel-assigned). */
  port?: number;
  /**
   * Override the bundled-frontend directory. Defaults to the path the
   * production binary would resolve. Tests inject a fixture dir so they
   * don't depend on a real Vite build.
   */
  distDir?: string;
}

export interface WebServerHandle {
  /** Actual bound port (relevant when `port: 0`). */
  port: number;
  /** Host the listener bound to. */
  host: string;
  /** Stop the listener and resolve when fully closed. */
  close(): Promise<void>;
}

/**
 * Build the hono app. Exposed separately from the listener so tests can
 * exercise the routes via fetch-without-network (hono's `app.fetch`) when
 * they need to.
 */
export function buildWebApp(opts: { cwd: string; distDir: string }): Hono {
  const app = new Hono();

  // F13.0 health endpoint. F13.1 expands this to the full `/api/*` surface
  // (plans, runs, inspect, prune, config, SSE).
  app.get('/api/health', (c) =>
    c.json({ ok: true, version: VERSION, cwd: opts.cwd }),
  );

  // Static asset path: serve every file under `distDir`. The
  // `@hono/node-server/serve-static` middleware is path-traversal safe and
  // respects the configured root, so requests like `/../../../etc/passwd`
  // are rejected without us needing extra checks here.
  //
  // `root` is computed relative to the process cwd at runtime, which is
  // the user's cwd at `yaao web` invocation — not what we want. Pass
  // an absolute path explicitly. (See hono docs: serveStatic `root` is
  // resolved relative to `process.cwd()` unless absolute.)
  if (existsSync(opts.distDir)) {
    app.use(
      '/*',
      serveStatic({
        root: opts.distDir,
        // Default index resolution: any request that doesn't match an asset
        // falls through to here; a client-side router in the React app
        // handles the rest.
        rewriteRequestPath: (path) =>
          path === '/' ? '/index.html' : path,
      }),
    );

    // Catch-all: when the static middleware misses, serve index.html so
    // client-side routing (deep-links like `/runs/run-xyz`) works.
    app.get('*', (c) => {
      const indexPath = join(opts.distDir, 'index.html');
      if (!existsSync(indexPath)) {
        return c.text('yaao web bundle missing — run `npm run build`', 500);
      }
      return c.html(readFileSync(indexPath, 'utf8'));
    });
  } else {
    // No bundle: typically a developer running `yaao web` without having
    // run `npm run build:web`. Surface a useful message instead of 404.
    app.get('*', (c) =>
      c.text(
        `yaao web bundle missing at ${opts.distDir}. Run \`npm run build:web\` (or \`npm run dev:web\` for hot-reload).`,
        500,
      ),
    );
  }

  return app;
}

/**
 * Start the HTTP listener and return a handle. The handle's `.close()`
 * shuts the server down cleanly; awaiting it resolves once the socket is
 * fully released, so callers (including tests) don't race a new server
 * binding the same port.
 */
export function startWebServer(opts: StartWebServerOptions): Promise<WebServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 0;
  const distDir = opts.distDir ?? resolveDefaultDistDir();
  const app = buildWebApp({ cwd: resolve(opts.cwd), distDir });

  return new Promise<WebServerHandle>((res, reject) => {
    let server: ReturnType<typeof honoServe>;
    try {
      server = honoServe({ fetch: app.fetch, hostname: host, port });
    } catch (e) {
      reject(e as Error);
      return;
    }
    server.once('listening', () => {
      const addr = server.address() as AddressInfo | string | null;
      if (!addr || typeof addr === 'string') {
        reject(new Error('failed to read bound address'));
        return;
      }
      res({
        port: addr.port,
        host,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
    server.once('error', (err) => reject(err));
  });
}

/**
 * Default location of the bundled frontend, resolved relative to this
 * module's compiled location. In production (`dist/web/server.js`) this
 * lands at `dist/web/web/...` — wait, that's wrong; production is
 * `dist/index.js`, so `../web/index.html` is `dist/web/index.html`. The
 * source path used in tests doesn't matter because tests inject `distDir`.
 */
function resolveDefaultDistDir(): string {
  // import.meta.url points at this file's compiled location. In the
  // production bundle the compiled file lives next to `dist/index.js`, so
  // `../web/` from there resolves to `dist/web/`. In source it lives at
  // `src/web/server.ts` so the same path resolves to `src/web/web/` which
  // doesn't exist — that's fine, the missing-bundle branch above handles it.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'web');
}
