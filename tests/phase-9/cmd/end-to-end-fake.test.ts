import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runPlanner } from '../../../src/planner/run.js';
import { FakeBackend } from '../../../src/agents/fake.js';
import type { AgentBackend, SpawnOptions } from '../../../src/agents/backend.js';
import { DEFAULT_CONFIG } from '../../../src/config/types.js';
import { createTmpProject } from '../../helpers/tmp-dir.js';

const PLAN_BODY = `# Add OAuth

> Add Google and GitHub providers.

## Tasks

| id        | title          | depends   | agent (suggested) | model (suggested) |
|-----------|----------------|-----------|-------------------|-------------------|
| scaffold  | Scaffold       |           | claude-code       | opus              |
| api       | API            | scaffold  | claude-code       |                   |

## scaffold — Scaffold

Set up the auth module.

## api — API

Implement the callback endpoints.
`;

describe('runPlanner end-to-end with FakeBackend', () => {
  let project: ReturnType<typeof createTmpProject> | undefined;
  afterEach(() => project?.cleanup());

  it('produces a markdown plan file the parser accepts', async () => {
    project = createTmpProject();
    const outDir = join(project.path, '.yaao', 'plans');
    mkdirSync(outDir, { recursive: true });

    // Wrap a FakeBackend so it writes the plan file on spawn.
    const inner = new FakeBackend({ events: [{ type: 'stdout', data: 'wrote plan' }] });
    const backend: AgentBackend = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: SpawnOptions) => {
            writeFileSync(join(outDir, 'oauth.md'), PLAN_BODY);
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const r = await runPlanner({
      cwd: project.path,
      config: DEFAULT_CONFIG,
      description: 'Add OAuth2 login with Google and GitHub',
      backend,
    });
    expect(r.ok).toBe(true);
    expect(r.files).toHaveLength(1);
    expect(r.plan?.tasks.map((t) => t.id)).toEqual(['scaffold', 'api']);
  });

  it('--dry-run produces the resolved prompt without spawning', async () => {
    project = createTmpProject();
    const inner = new FakeBackend({ events: [] });
    const r = await runPlanner({
      cwd: project.path,
      config: DEFAULT_CONFIG,
      description: 'Add a login form',
      dryRun: true,
      backend: inner,
    });
    expect(r.ok).toBe(true);
    expect(r.prompt).toContain('Add a login form');
    expect(r.files).toEqual([]);
  });
});
