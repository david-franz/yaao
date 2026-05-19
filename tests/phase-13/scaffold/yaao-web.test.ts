import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startWebServer, type WebServerHandle } from '../../../src/web/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDist = join(here, 'fixture-dist');

describe('F13.0 yaao web scaffold', () => {
  let handle: WebServerHandle | undefined;
  afterEach(async () => {
    if (handle) await handle.close();
    handle = undefined;
  });

  it('binds a loopback listener on a kernel-assigned port and reports the port', async () => {
    handle = await startWebServer({
      cwd: process.cwd(),
      host: '127.0.0.1',
      port: 0,
      distDir: fixtureDist,
    });
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.host).toBe('127.0.0.1');
  });

  it('GET /api/health returns 200 with { ok, version, cwd }', async () => {
    handle = await startWebServer({
      cwd: '/tmp/yaao-test',
      port: 0,
      distDir: fixtureDist,
    });
    const r = await fetch(`http://${handle.host}:${handle.port}/api/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; version: string; cwd: string };
    expect(body.ok).toBe(true);
    expect(body.version).toBeTypeOf('string');
    expect(body.cwd).toBe('/tmp/yaao-test');
  });

  it("GET / serves the bundled index.html so the body contains 'yaao web'", async () => {
    handle = await startWebServer({
      cwd: process.cwd(),
      port: 0,
      distDir: fixtureDist,
    });
    const r = await fetch(`http://${handle.host}:${handle.port}/`);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain('yaao web');
  });

  it('serves bundled assets under /assets/*', async () => {
    handle = await startWebServer({
      cwd: process.cwd(),
      port: 0,
      distDir: fixtureDist,
    });
    const r = await fetch(`http://${handle.host}:${handle.port}/assets/index-abcd.js`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('yaao web fixture');
  });

  it('falls back to index.html for client-side router deep links', async () => {
    handle = await startWebServer({
      cwd: process.cwd(),
      port: 0,
      distDir: fixtureDist,
    });
    // F13.3 will mount routes like /runs/run-xyz. Even though no such asset
    // exists in the bundle, the server should fall back to index.html so
    // the React app sees the URL and the client router handles it.
    const r = await fetch(`http://${handle.host}:${handle.port}/runs/run-xyz`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('yaao web');
  });

  it('surfaces a useful error when the bundle directory is missing', async () => {
    handle = await startWebServer({
      cwd: process.cwd(),
      port: 0,
      distDir: join(here, 'does-not-exist'),
    });
    const r = await fetch(`http://${handle.host}:${handle.port}/`);
    expect(r.status).toBe(500);
    expect(await r.text()).toMatch(/bundle missing/);
  });
});
