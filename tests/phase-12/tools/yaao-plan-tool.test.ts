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
  });
});
