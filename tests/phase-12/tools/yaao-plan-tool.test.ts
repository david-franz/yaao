import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { yaaoPlanTool, type ToolContext } from '../../../src/mcp/tools.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { FakeBackend } from '../../../src/agents/fake.js';
import type { AgentBackend, SpawnOptions } from '../../../src/agents/backend.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

const PLAN_BODY = `# Hello

> Demo plan

## Tasks

| id | title | depends |
|----|-------|---------|
| t  | T     |         |

## t — T

body
`;

describe('yaao_plan MCP tool', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('runs the planner skill via the injected backend and reports the result', async () => {
    project = createTmpProject();
    project.write('.yaao/plans/.keep', '');
    const inner = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
    const backend: AgentBackend = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: SpawnOptions) => {
            writeFileSync(join(project!.path, '.yaao', 'plans', 'hello.md'), PLAN_BODY);
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });
    const ctx: ToolContext = {
      cwd: project.path,
      config: DEFAULT_CONFIG,
      backendFor: () => backend,
    };
    const r = await yaaoPlanTool({ description: 'demo' }, ctx);
    expect(r.text).toMatch(/Wrote/);
    expect(r.structuredContent['ok']).toBe(true);
    expect(r.structuredContent['tasks']).toBe(1);
    const files = r.structuredContent['files'] as { path: string; action: string }[];
    expect(files[0]?.action).toBe('created');
    expect(r.structuredContent['errors']).toEqual([]);
    expect(r.structuredContent['warnings']).toEqual([]);
  });

  it('returns a structured error envelope when `out` is a file path', async () => {
    project = createTmpProject();
    // Pre-create the plans dir + an existing plan file we'll point `out` at.
    project.write('.yaao/plans/timer-pit.md', '# Timer Pit\n');
    const inner = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
    const ctx: ToolContext = {
      cwd: project.path,
      config: DEFAULT_CONFIG,
      backendFor: () => inner,
    };
    const r = await yaaoPlanTool({ description: 'demo', out: '.yaao/plans/timer-pit.md' }, ctx);
    expect(r.structuredContent['ok']).toBe(false);
    const errs = r.structuredContent['errors'] as { code: string; hint?: string }[];
    expect(errs[0]?.code).toBe('YAAO_PLAN_OUT_NOT_DIR');
    expect(errs[0]?.hint).toMatch(/directory/i);
  });

  it('reports existing plans as `unchanged` when the agent writes no new files', async () => {
    project = createTmpProject();
    project.write('.yaao/plans/existing.md', PLAN_BODY);
    // Backend "succeeds" but does not write anything to outDir.
    const backend = new FakeBackend({ events: [{ type: 'stdout', data: 'noop' }] });
    const ctx: ToolContext = {
      cwd: project.path,
      config: DEFAULT_CONFIG,
      backendFor: () => backend,
    };
    const r = await yaaoPlanTool({ description: 'demo' }, ctx);
    expect(r.structuredContent['ok']).toBe(true);
    const files = r.structuredContent['files'] as { path: string; action: string }[];
    expect(files).toHaveLength(1);
    expect(files[0]?.action).toBe('unchanged');
    expect((r.structuredContent['warnings'] as string[]).join(' ')).toMatch(/already exists|no new files/i);
    // Parsed tasks from the existing file still flow through.
    expect(r.structuredContent['tasks']).toBe(1);
  });
});
