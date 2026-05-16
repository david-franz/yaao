import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';
import type { SpawnOptions } from '../../../src/agents/backend.js';

describe('lifecycle prepends conflict-resolution preamble', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('feeds the agent the list of conflicting files when on-conflict=agent', async () => {
    repo = createTestRepo();
    const cwd = repo.path;
    const planFile = join(cwd, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: cp\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'cp' },
      tasks: [
        { id: 'dep-a', title: 'A', agent: 'claude-code', prompt: 'write a' },
        { id: 'dep-b', title: 'B', agent: 'claude-code', prompt: 'write b' },
        {
          id: 'merger',
          title: 'Merge',
          agent: 'claude-code',
          prompt: 'do the task',
          depends: ['dep-a', 'dep-b'],
        },
      ],
    });

    // dep-a + dep-b independently write to the same file so the parent-merge
    // for `merger` produces conflicts.
    const prompts = new Map<string, string>();
    const backend = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
    const wrap = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: SpawnOptions) => {
            const taskId = opts.cwd.split('/').pop() ?? 'unknown';
            prompts.set(taskId, opts.prompt);
            if (taskId === 'dep-a') {
              writeFileSync(join(opts.cwd, 'shared.txt'), 'from-a\n');
            } else if (taskId === 'dep-b') {
              writeFileSync(join(opts.cwd, 'shared.txt'), 'from-b\n');
            }
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const config = (await import('../../../src/config/types.js')).DEFAULT_CONFIG;
    const result = await runPlan({
      runId: 'rcp',
      plan,
      planFile,
      rootDir: cwd,
      config,
      backendFor: () => wrap,
    });

    // dep-a + dep-b complete cleanly; merger's worktree setup hits the
    // conflict, leave-for-agent kicks in, and the preamble is prepended.
    expect(result.status).toBe('success');
    const mergerPrompt = prompts.get('merger') ?? '';
    expect(mergerPrompt).toMatch(/Merge conflicts to resolve before doing the task/);
    expect(mergerPrompt).toContain('shared.txt');
    expect(mergerPrompt).toContain('do the task');

    // And the worktree should actually be on disk with conflict markers.
    const mergerWorktree = join(cwd, '.yaao', 'worktrees', 'rcp', 'merger');
    expect(existsSync(mergerWorktree)).toBe(true);
    const fileContents = readFileSync(join(mergerWorktree, 'shared.txt'), 'utf8');
    expect(fileContents).toContain('<<<<<<<');
  });
});
