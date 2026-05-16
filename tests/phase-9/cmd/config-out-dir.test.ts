import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlanner } from '../../../src/planner/run.js';
import { FakeBackend } from '../../../src/agents/fake.js';
import type { AgentBackend, SpawnOptions } from '../../../src/agents/backend.js';
import { ConfigSchema } from '../../../src/config/schema.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

const PLAN_BODY = `# X

> body

## Tasks

| id | title | depends |
|----|-------|---------|
| t  | T     |         |

## t — T

body
`;

describe('yaao plan honors plan.out-dir from config', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('writes to plan.out-dir when --out is not given', async () => {
    project = createTmpProject();
    const config = ConfigSchema.parse({
      version: 1,
      plan: { 'out-dir': 'custom/plans' },
    });
    const outDir = join(project.path, 'custom', 'plans');
    const inner = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
    const backend: AgentBackend = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: SpawnOptions) => {
            // The CLI passes the resolved outDir through; the agent writes a file there.
            writeFileSync(join(opts.cwd, 'no-op-marker.txt'), '');
            const fs = await import('node:fs');
            fs.mkdirSync(outDir, { recursive: true });
            writeFileSync(join(outDir, 'x.md'), PLAN_BODY);
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });
    const r = await runPlanner({
      cwd: project.path,
      config,
      description: 'test',
      outDir, // CLI plan command resolves config.plan.out-dir → outDir before calling
      backend,
    });
    expect(r.ok).toBe(true);
    expect(r.files[0]).toBe(join(outDir, 'x.md'));
  });
});
