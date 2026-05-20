/**
 * `yaao web` HTTP+SSE route module (F13.1).
 *
 * Mounts every `/api/*` endpoint the F13.2–F13.6 frontend features need.
 * Reuses the existing MCP tool handlers wherever the shape is identical —
 * `yaao_inspect`, `yaao_prune`, `yaao_resume`, `yaao_status` already
 * return the same envelope the browser wants, so the routes are thin
 * adapters over the tool functions.
 */

import type { Hono } from 'hono';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { YaaoConfig } from '../config/types.js';
import { loadConfig } from '../config/loader.js';
import { ConfigSchema } from '../config/schema.js';
import { loadPlan } from '../plan/yaml/loader.js';
import { validatePlan } from '../plan/validate/index.js';
import {
  yaaoInspectTool,
  yaaoPruneTool,
  yaaoStatusTool,
  yaaoAgentsTool,
  yaaoResumeTool,
  type ToolContext,
} from '../mcp/tools.js';
import { listRuns } from '../git/journal.js';
import { streamEvents, watchPathEvents } from './sse.js';
import { tailJournal } from './journal-tail.js';
import { VERSION } from '../version.js';

export interface RouteContext {
  /** Project root the server is bound to. */
  cwd: string;
  /** Mutable holder for the current config (hot-reloaded via the same
   * pattern as `serve()`'s config watcher). Routes read live values. */
  ctx: ToolContext;
  /** Bearer token required on non-loopback binds; undefined on loopback. */
  token?: string;
  /** True when the listener bound to a non-loopback interface; toggles auth. */
  requireToken: boolean;
}

export function mountRoutes(app: Hono, route: RouteContext): void {
  // ----- auth ----------------------------------------------------------
  // On non-loopback binds every request must carry the token. Loopback is
  // permissive — anything on 127.0.0.1 is already the user (same model as
  // F12.1's stdio server, which has no auth at all).
  if (route.requireToken) {
    app.use('/api/*', async (c, next) => {
      const presented =
        c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ??
        c.req.query('token');
      if (presented !== route.token) {
        return c.json({ ok: false, errors: [{ code: 'YAAO_WEB_UNAUTHORIZED', message: 'token required' }] }, 401);
      }
      await next();
      return undefined;
    });
  }

  // ----- /api/openapi.json --------------------------------------------
  // Minimal OpenAPI 3.1 surface — enough to validate routes are reachable
  // and to advertise the contract. A richer spec lands when F16.2 wires
  // up the docs site.
  app.get('/api/openapi.json', (c) => c.json(buildOpenApi()));

  // ----- workspace ----------------------------------------------------
  app.get('/api/inspect', async (c) => {
    const r = await yaaoInspectTool({}, route.ctx);
    return c.json(r.structuredContent);
  });

  app.get('/api/inspect/watch', (c) => {
    const yaaoDir = join(route.cwd, '.yaao');
    return streamEvents(c, (signal) =>
      watchPathEvents(yaaoDir, signal, { debounceMs: 250 }),
    );
  });

  app.post('/api/prune', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const r = await yaaoPruneTool(body, route.ctx);
    return c.json(r.structuredContent);
  });

  app.get('/api/agents', async (c) => {
    const r = await yaaoAgentsTool({}, route.ctx);
    return c.json(r.structuredContent);
  });

  // ----- plans --------------------------------------------------------
  app.get('/api/plans', (c) => {
    const execDir = join(route.cwd, '.yaao', 'exec');
    const plans: { slug: string; path: string; mtimeMs: number }[] = [];
    if (existsSync(execDir)) {
      for (const f of readdirSync(execDir)) {
        if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
        const slug = f.replace(/\.(ya?ml)$/, '');
        const path = join(execDir, f);
        plans.push({ slug, path, mtimeMs: safeMtime(path) });
      }
    }
    return c.json({ ok: true, plans });
  });

  app.get('/api/plans/:slug', async (c) => {
    const slug = c.req.param('slug');
    const path = resolveExecPath(route.cwd, slug);
    if (!path) return c.json(notFound(slug), 404);
    try {
      const loaded = await loadPlan(path, { cwd: route.cwd, config: route.ctx.config });
      return c.json({ ok: true, slug, path, plan: loaded.plan });
    } catch (err) {
      return c.json(
        {
          ok: false,
          errors: [{ code: 'YAAO_PLAN_INVALID', message: (err as Error).message }],
        },
        400,
      );
    }
  });

  app.get('/api/plans/:slug/raw', (c) => {
    const slug = c.req.param('slug');
    const path = resolveExecPath(route.cwd, slug);
    if (!path) return c.json(notFound(slug), 404);
    const body = readFileSync(path, 'utf8');
    return c.body(body, 200, { 'content-type': 'application/x-yaml; charset=utf-8' });
  });

  app.put('/api/plans/:slug/raw', async (c) => {
    const slug = c.req.param('slug');
    const path = resolveExecPath(route.cwd, slug) ?? defaultExecPath(route.cwd, slug);
    const body = await c.req.text();
    // Parse + validate before touching disk. Same pipeline `yaao validate`
    // uses, so schema violations and DAG checks both surface.
    const tmpPath = `${path}.tmp-${Date.now()}`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmpPath, body, 'utf8');
    try {
      const loaded = await loadPlan(tmpPath, { cwd: route.cwd, config: route.ctx.config });
      const issues = validatePlan(loaded.plan, loaded.source, {
        cwd: route.cwd,
        config: route.ctx.config,
      });
      const errs = issues.filter((i) => i.severity === 'error');
      if (errs.length > 0) {
        rmSync(tmpPath, { force: true });
        return c.json({ ok: false, errors: errs.map((e) => ({ code: e.code, message: e.message })) }, 400);
      }
    } catch (err) {
      rmSync(tmpPath, { force: true });
      return c.json(
        { ok: false, errors: [{ code: 'YAAO_PLAN_INVALID', message: (err as Error).message }] },
        400,
      );
    }
    // Atomic rename into place.
    try {
      rmSync(path, { force: true });
    } catch {
      // ignore
    }
    writeFileSync(path, body, 'utf8');
    rmSync(tmpPath, { force: true });
    return c.json({ ok: true, path });
  });

  app.get('/api/plans/:slug/watch', (c) => {
    const slug = c.req.param('slug');
    const path = resolveExecPath(route.cwd, slug);
    if (!path) return c.json(notFound(slug), 404);
    return streamEvents(c, (signal) => watchPathEvents(path, signal, { debounceMs: 250 }));
  });

  // ----- config --------------------------------------------------------
  // `/api/config` returns the resolved config WITH `${ENV_VAR}` placeholders
  // preserved (not the resolved literal values). The raw form is what the
  // F13.6 editor edits. The schema endpoint feeds the editor's autocomplete.
  app.get('/api/config', (c) => {
    // ctx.config is the env-resolved view; for the form editor we want the
    // raw on-disk view that still shows `${VAR}` placeholders. Read the
    // raw file when present; fall back to the resolved config for global-
    // only setups.
    const rawPath = configPath(route.cwd);
    if (rawPath && existsSync(rawPath)) {
      try {
        const raw = JSON.parse(readFileSync(rawPath, 'utf8')) as unknown;
        return c.json({ ok: true, config: raw, path: rawPath });
      } catch (err) {
        return c.json(
          { ok: false, errors: [{ code: 'YAAO_CONFIG_INVALID', message: (err as Error).message }] },
          400,
        );
      }
    }
    return c.json({ ok: true, config: route.ctx.config, path: null });
  });

  app.get('/api/config/raw', (c) => {
    const rawPath = configPath(route.cwd);
    if (!rawPath || !existsSync(rawPath)) {
      return c.body('{\n  "$schema": "../schema/config.schema.json",\n  "version": 1\n}\n', 200, {
        'content-type': 'application/json; charset=utf-8',
      });
    }
    return c.body(readFileSync(rawPath, 'utf8'), 200, {
      'content-type': 'application/json; charset=utf-8',
    });
  });

  app.put('/api/config/raw', async (c) => {
    const body = await c.req.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      return c.json(
        { ok: false, errors: [{ code: 'YAAO_CONFIG_INVALID', message: (err as Error).message }] },
        400,
      );
    }
    // Zod parse — same path loadConfig uses.
    const v = ConfigSchema.safeParse(parsed);
    if (!v.success) {
      return c.json(
        {
          ok: false,
          errors: v.error.issues.map((i) => ({
            code: 'YAAO_CONFIG_INVALID',
            message: `${i.path.join('.')}: ${i.message}`,
          })),
        },
        400,
      );
    }
    // Secrets-leakage scan: walk providers, reject any api-key that's not
    // a `${VAR}` placeholder. This is what makes the editor safe to use.
    const literalSecret = findLiteralSecret(v.data);
    if (literalSecret) {
      return c.json(
        {
          ok: false,
          errors: [
            {
              code: 'YAAO_LITERAL_SECRET',
              message: `${literalSecret.path}: literal secret detected — use \${ENV_VAR} placeholder instead`,
            },
          ],
        },
        400,
      );
    }
    const path = configPath(route.cwd) ?? defaultConfigPath(route.cwd);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, 'utf8');
    return c.json({ ok: true, path });
  });

  app.get('/api/config/schema', (c) => {
    const schemaPath = resolveSchemaPath('config.schema.json');
    if (!schemaPath || !existsSync(schemaPath)) {
      return c.json({ ok: false, errors: [{ code: 'YAAO_SCHEMA_MISSING', message: 'schema not built' }] }, 500);
    }
    return c.body(readFileSync(schemaPath, 'utf8'), 200, {
      'content-type': 'application/schema+json',
    });
  });

  app.get('/api/config/watch', (c) => {
    const path = configPath(route.cwd);
    if (!path) {
      // No config yet — watch the directory so the watcher picks up
      // the first write.
      const dir = join(route.cwd, '.yaao');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      return streamEvents(c, (signal) => watchPathEvents(dir, signal, { debounceMs: 250 }));
    }
    return streamEvents(c, (signal) => watchPathEvents(path, signal, { debounceMs: 250 }));
  });

  // ----- runs ----------------------------------------------------------
  app.get('/api/runs', async (c) => {
    const runsDir = join(route.cwd, '.yaao', 'runs');
    const runs = await listRuns(runsDir);
    return c.json({ ok: true, runs });
  });

  app.get('/api/runs/:runId', async (c) => {
    const runId = c.req.param('runId');
    const r = await yaaoStatusTool({ runId }, route.ctx);
    // yaaoStatusTool returns the summary on `structuredContent` directly.
    return c.json(r.structuredContent);
  });

  app.get('/api/runs/:runId/tasks/:taskId/log', (c) => {
    const runId = c.req.param('runId');
    const taskId = c.req.param('taskId');
    const fromStr = c.req.query('from');
    const from = fromStr ? Number(fromStr) : 0;
    const logPath = join(route.cwd, '.yaao', 'runs', runId, taskId, 'output.log');
    if (!existsSync(logPath)) return c.json({ ok: true, bytes: 0, content: '' });
    const st = statSync(logPath);
    if (from >= st.size) return c.json({ ok: true, bytes: st.size, content: '' });
    const fullBuf = readFileSync(logPath);
    const tail = fullBuf.subarray(from);
    return c.json({ ok: true, bytes: st.size, content: tail.toString('utf8') });
  });

  app.get('/api/runs/:runId/events', (c) => {
    const runId = c.req.param('runId');
    const lastEventIdHeader = c.req.header('last-event-id');
    const lastEventId = lastEventIdHeader ? Number(lastEventIdHeader) : 0;
    const journalPath = join(route.cwd, '.yaao', 'runs', runId, 'journal.jsonl');
    return streamEvents(c, async function* (signal) {
      for await (const rec of tailJournal({
        journalPath,
        lastEventId: Number.isFinite(lastEventId) ? lastEventId : 0,
        signal,
      })) {
        yield {
          id: String(rec.id),
          event: rec.event.t,
          data: rec.event,
        };
      }
    });
  });

  app.post('/api/runs/:runId/cancel', (c) => {
    const runId = c.req.param('runId');
    const runDir = join(route.cwd, '.yaao', 'runs', runId);
    if (!existsSync(runDir)) {
      return c.json(
        { ok: false, errors: [{ code: 'YAAO_RUN_NOT_FOUND', message: runId }] },
        404,
      );
    }
    // Cancellation across processes: write a marker the runner polls for.
    // F13.1 lays the marker; the polling/abort side ships when the cancel
    // pipeline catches up (Phase 15 distillation work touches the lifecycle
    // anyway). Until then this is a recorded intent that operators and
    // tooling can act on, and an idempotent 202 from this endpoint.
    try {
      writeFileSync(join(runDir, 'cancel'), `${new Date().toISOString()}\n`, 'utf8');
    } catch (err) {
      return c.json(
        { ok: false, errors: [{ code: 'YAAO_WEB_CANCEL', message: (err as Error).message }] },
        500,
      );
    }
    return c.json({ ok: true, runId }, 202);
  });

  app.post('/api/runs/:runId/resume', async (c) => {
    const runId = c.req.param('runId');
    const body = (await c.req.json().catch(() => ({}))) as {
      retryFailed?: boolean;
      reskip?: boolean;
    };
    const r = await yaaoResumeTool({ runId, ...body }, route.ctx);
    return c.json(r.structuredContent);
  });
}

// -------- helpers ------------------------------------------------------

function resolveExecPath(cwd: string, slug: string): string | undefined {
  const execDir = join(cwd, '.yaao', 'exec');
  for (const ext of ['yaml', 'yml']) {
    const p = join(execDir, `${slug}.${ext}`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

function defaultExecPath(cwd: string, slug: string): string {
  return join(cwd, '.yaao', 'exec', `${slug}.yaml`);
}

function configPath(cwd: string): string | undefined {
  const dotyaao = join(cwd, '.yaao', 'yaao.config.json');
  if (existsSync(dotyaao)) return dotyaao;
  const flat = join(cwd, 'yaao.config.json');
  if (existsSync(flat)) return flat;
  return undefined;
}

function defaultConfigPath(cwd: string): string {
  return join(cwd, '.yaao', 'yaao.config.json');
}

function safeMtime(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function notFound(slug: string): { ok: false; errors: { code: string; message: string }[] } {
  return { ok: false, errors: [{ code: 'YAAO_PLAN_NOT_FOUND', message: `plan slug '${slug}' not found in .yaao/exec/` }] };
}

function resolveSchemaPath(name: string): string | undefined {
  // The schema files live at `<package>/schema/<name>` in both the source
  // tree and the published package. Resolve relative to this module's own
  // location so the lookup works for `npm link`, `npm install -g`, and
  // `node dist/bin/yaao.js` alike.
  const here = dirname(fileURLToPath(import.meta.url));
  // In source: src/web/routes.ts → ../../schema/
  // In dist:   dist/web/routes.js → ../../schema/ (same)
  const candidate = resolve(here, '..', '..', 'schema', name);
  return existsSync(candidate) ? candidate : undefined;
}

/**
 * Walk the config object looking for `api-key` values that are bare
 * literals (not `${VAR}` placeholders). Mirrors the F1.3 secrets-leakage
 * rule that `loadConfig` enforces at startup; we run it here so the editor
 * can never accidentally persist a literal secret.
 */
function findLiteralSecret(cfg: YaaoConfig): { path: string; value: string } | undefined {
  const providers = cfg.agents?.api?.providers ?? {};
  for (const [name, entry] of Object.entries(providers)) {
    const key = (entry as { 'api-key'?: string })['api-key'];
    if (typeof key === 'string' && !/^\$\{[A-Z0-9_]+\}$/.test(key) && key.length > 0) {
      return { path: `agents.api.providers.${name}.api-key`, value: key };
    }
  }
  return undefined;
}

function buildOpenApi(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: { title: 'yaao web', version: VERSION },
    paths: {
      '/api/health': { get: { summary: 'health' } },
      '/api/inspect': { get: { summary: 'workspace snapshot' } },
      '/api/inspect/watch': { get: { summary: 'SSE: workspace changes' } },
      '/api/prune': { post: { summary: 'prune workspace artifacts' } },
      '/api/agents': { get: { summary: 'agent backends + availability' } },
      '/api/plans': { get: { summary: 'list execution plans' } },
      '/api/plans/{slug}': { get: { summary: 'resolved plan' } },
      '/api/plans/{slug}/raw': {
        get: { summary: 'raw YAML' },
        put: { summary: 'save validated YAML' },
      },
      '/api/plans/{slug}/watch': { get: { summary: 'SSE: file changes' } },
      '/api/config': { get: { summary: 'resolved config (placeholders preserved)' } },
      '/api/config/raw': { get: { summary: 'raw config' }, put: { summary: 'save validated config' } },
      '/api/config/schema': { get: { summary: 'JSON Schema for the config' } },
      '/api/config/watch': { get: { summary: 'SSE: config changes' } },
      '/api/runs': { get: { summary: 'list runs' } },
      '/api/runs/{runId}': { get: { summary: 'run summary' } },
      '/api/runs/{runId}/tasks/{taskId}/log': { get: { summary: 'task log tail' } },
      '/api/runs/{runId}/events': { get: { summary: 'SSE: live run events (replay via Last-Event-ID)' } },
      '/api/runs/{runId}/cancel': { post: { summary: 'write cancel marker' } },
      '/api/runs/{runId}/resume': { post: { summary: 'resume run' } },
    },
  };
}

/**
 * Helper exported for tests: loads a config from disk and returns the
 * up-to-date `ToolContext` shape `mountRoutes` expects.
 */
export async function buildRouteContextFromDisk(cwd: string, requireToken: boolean, token?: string): Promise<RouteContext> {
  const { config } = await loadConfig({ cwd, env: process.env });
  const ctx: ToolContext = { cwd, config };
  return {
    cwd,
    ctx,
    requireToken,
    ...(token !== undefined ? { token } : {}),
  };
}
