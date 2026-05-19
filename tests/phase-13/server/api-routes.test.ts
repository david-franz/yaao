import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startWebServer, type WebServerHandle } from '../../../src/web/server.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import type { ToolContext } from '../../../src/mcp/tools.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDist = join(here, '..', 'scaffold', 'fixture-dist');

const SAMPLE_PLAN_YAML = `plan:
  name: oauth
  version: 1
config: {}
includes: []
tasks:
  - id: scaffold
    title: Scaffold
    prompt: scaffold the auth module
    depends: []
    agent: claude-code
    skills: []
    files: []
    env: {}
    retries: 1
    setup: []
`;

function ctxFor(repoPath: string): ToolContext {
  return { cwd: repoPath, config: DEFAULT_CONFIG };
}

async function start(repoPath: string): Promise<WebServerHandle> {
  return startWebServer({
    cwd: repoPath,
    port: 0,
    distDir: fixtureDist,
    ctxOverride: ctxFor(repoPath),
  });
}

describe('F13.1 web routes', () => {
  let handle: WebServerHandle | undefined;
  let repo: TestRepo | undefined;
  afterEach(async () => {
    if (handle) await handle.close();
    handle = undefined;
    repo?.cleanup();
    repo = undefined;
  });

  it('GET /api/inspect returns the same shape as the MCP tool', async () => {
    repo = createTestRepo();
    handle = await start(repo.path);
    const r = await fetch(`http://${handle.host}:${handle.port}/api/inspect`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; workspace: { cwd: string }; plans: unknown[]; runs: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.workspace.cwd).toBe(repo.path);
    expect(Array.isArray(body.plans)).toBe(true);
    expect(Array.isArray(body.runs)).toBe(true);
  });

  it('GET /api/plans lists exec yaml files; GET /api/plans/:slug returns the resolved plan', async () => {
    repo = createTestRepo();
    mkdirSync(join(repo.path, '.yaao', 'exec'), { recursive: true });
    writeFileSync(join(repo.path, '.yaao', 'exec', 'oauth.yaml'), SAMPLE_PLAN_YAML);
    handle = await start(repo.path);
    const list = (await (
      await fetch(`http://${handle.host}:${handle.port}/api/plans`)
    ).json()) as { plans: { slug: string }[] };
    expect(list.plans.map((p) => p.slug)).toContain('oauth');
    const detail = (await (
      await fetch(`http://${handle.host}:${handle.port}/api/plans/oauth`)
    ).json()) as { ok: boolean; plan: { plan: { name: string }; tasks: { id: string }[] } };
    expect(detail.ok).toBe(true);
    expect(detail.plan.plan.name).toBe('oauth');
    expect(detail.plan.tasks.map((t) => t.id)).toEqual(['scaffold']);
  });

  it('PUT /api/plans/:slug/raw rejects an invalid plan and never writes', async () => {
    repo = createTestRepo();
    mkdirSync(join(repo.path, '.yaao', 'exec'), { recursive: true });
    handle = await start(repo.path);
    const r = await fetch(`http://${handle.host}:${handle.port}/api/plans/bad/raw`, {
      method: 'PUT',
      headers: { 'content-type': 'application/x-yaml' },
      body: 'plan: { version: 1 }\n# missing name + tasks; will fail schema\n',
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { ok: boolean; errors: { code: string; message: string }[] };
    expect(body.ok).toBe(false);
    expect(body.errors[0]?.code).toMatch(/YAAO_PLAN/);
    // No file was written.
    expect(() => readFileSync(join(repo!.path, '.yaao', 'exec', 'bad.yaml'))).toThrow();
  });

  it('PUT /api/plans/:slug/raw accepts a valid plan and writes it atomically', async () => {
    repo = createTestRepo();
    mkdirSync(join(repo.path, '.yaao', 'exec'), { recursive: true });
    handle = await start(repo.path);
    const r = await fetch(`http://${handle.host}:${handle.port}/api/plans/oauth/raw`, {
      method: 'PUT',
      headers: { 'content-type': 'application/x-yaml' },
      body: SAMPLE_PLAN_YAML,
    });
    expect(r.status).toBe(200);
    const written = readFileSync(join(repo!.path, '.yaao', 'exec', 'oauth.yaml'), 'utf8');
    expect(written).toContain('oauth');
  });

  it('GET /api/config returns the project config with placeholders preserved', async () => {
    repo = createTestRepo();
    mkdirSync(join(repo.path, '.yaao'), { recursive: true });
    writeFileSync(
      join(repo.path, '.yaao', 'yaao.config.json'),
      JSON.stringify({
        version: 1,
        agents: { api: { providers: { anthropic: { 'api-key': '${ANTHROPIC_API_KEY}' } } } },
      }),
    );
    handle = await start(repo.path);
    const r = await (
      await fetch(`http://${handle.host}:${handle.port}/api/config`)
    ).json() as { ok: boolean; config: { agents: { api: { providers: { anthropic: { 'api-key': string } } } } } };
    expect(r.ok).toBe(true);
    expect(r.config.agents.api.providers.anthropic['api-key']).toBe('${ANTHROPIC_API_KEY}');
  });

  it('PUT /api/config/raw rejects a config that contains a literal API key', async () => {
    repo = createTestRepo();
    mkdirSync(join(repo.path, '.yaao'), { recursive: true });
    handle = await start(repo.path);
    const literal = {
      version: 1,
      agents: { api: { providers: { anthropic: { 'api-key': 'sk-literally-leaked-key' } } } },
    };
    const r = await fetch(`http://${handle.host}:${handle.port}/api/config/raw`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(literal),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { errors: { code: string; message: string }[] };
    expect(body.errors[0]?.code).toBe('YAAO_LITERAL_SECRET');
  });

  it('PUT /api/config/raw accepts a placeholder secret', async () => {
    repo = createTestRepo();
    mkdirSync(join(repo.path, '.yaao'), { recursive: true });
    handle = await start(repo.path);
    const ok = {
      version: 1,
      agents: { api: { providers: { anthropic: { 'api-key': '${ANTHROPIC_API_KEY}' } } } },
    };
    const r = await fetch(`http://${handle.host}:${handle.port}/api/config/raw`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ok),
    });
    expect(r.status).toBe(200);
  });

  it('GET /api/config/schema returns the JSON Schema', async () => {
    repo = createTestRepo();
    handle = await start(repo.path);
    const r = await fetch(`http://${handle.host}:${handle.port}/api/config/schema`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { $ref?: string; definitions?: Record<string, unknown> };
    // The generated schema wraps everything under $ref → #/definitions/YaaoConfig
    expect(body.$ref).toBe('#/definitions/YaaoConfig');
    expect(body.definitions?.['YaaoConfig']).toBeDefined();
  });

  it('POST /api/prune defaults to dry-run', async () => {
    repo = createTestRepo();
    handle = await start(repo.path);
    const r = await fetch(`http://${handle.host}:${handle.port}/api/prune`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'all-completed' }),
    });
    // No runs match → YAAO_PRUNE_NO_MATCH is the right shape, ok:false.
    const body = (await r.json()) as { ok: boolean; dryRun?: boolean; errors?: { code: string }[] };
    expect(body.ok).toBe(false);
    expect(body.errors?.[0]?.code).toBe('YAAO_PRUNE_NO_MATCH');
  });

  it('non-loopback bind without --token rejects at startup', async () => {
    repo = createTestRepo();
    await expect(
      startWebServer({
        cwd: repo.path,
        host: '0.0.0.0',
        port: 0,
        distDir: fixtureDist,
        ctxOverride: ctxFor(repo.path),
      }),
    ).rejects.toThrow(/requires --token/);
  });

  it('non-loopback bind WITH --token rejects /api/* requests that omit it', async () => {
    repo = createTestRepo();
    handle = await startWebServer({
      cwd: repo.path,
      host: '0.0.0.0',
      port: 0,
      distDir: fixtureDist,
      token: 'sec',
      ctxOverride: ctxFor(repo.path),
    });
    // No token: 401.
    const unauth = await fetch(`http://127.0.0.1:${handle.port}/api/inspect`);
    expect(unauth.status).toBe(401);
    // With token: 200.
    const ok = await fetch(`http://127.0.0.1:${handle.port}/api/inspect`, {
      headers: { authorization: 'Bearer sec' },
    });
    expect(ok.status).toBe(200);
  });

  it('GET /api/openapi.json returns an OpenAPI 3.1 document', async () => {
    repo = createTestRepo();
    handle = await start(repo.path);
    const r = await fetch(`http://${handle.host}:${handle.port}/api/openapi.json`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(body.openapi).toBe('3.1.0');
    expect(body.paths['/api/inspect']).toBeDefined();
    expect(body.paths['/api/runs/{runId}/events']).toBeDefined();
  });
});
