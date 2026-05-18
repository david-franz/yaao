import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execaSync } from 'execa';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';

describe('auto-merge triggers when the agent self-commits', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  /**
   * Regression for the case where the agent runs `git commit` itself inside
   * the worktree. The lifecycle's commitIfDirty then finds nothing dirty
   * (the agent already committed everything), so commitOutcome.commit is
   * undefined — and the previous auto-merge condition skipped the merge
   * entirely. Branch had the work; main never got it.
   *
   * The fix triggers auto-merge whenever HEAD on the task branch advanced
   * since the agent spawned, regardless of who made the commit.
   */
  it('lands agent-committed work on base-branch via auto-merge', async () => {
    repo = createTestRepo();
    const cwd = repo.path;
    const planFile = join(cwd, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: ac\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'ac' },
      tasks: [{ id: 'a', title: 'A', agent: 'claude-code', prompt: 'p' }],
    });

    const backend = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
    const wrap = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof target.spawn>[0]) => {
            // Agent writes a file AND commits it themselves — leaves the
            // worktree clean. yaao's commitIfDirty would otherwise see
            // nothing to do and skip auto-merge.
            writeFileSync(join(opts.cwd, 'agent-made.txt'), 'hi\n');
            execaSync('git', ['add', 'agent-made.txt'], { cwd: opts.cwd });
            execaSync('git', ['commit', '-m', 'agent commit'], { cwd: opts.cwd });
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const result = await runPlan({
      runId: 'rac',
      plan,
      planFile,
      rootDir: cwd,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => wrap,
    });
    expect(result.status).toBe('success');

    // The agent's file should be on main, brought there by auto-merge.
    expect(existsSync(join(cwd, 'agent-made.txt'))).toBe(true);
    const log = execaSync('git', ['log', '--format=%s', 'main'], { cwd }).stdout;
    expect(log).toMatch(/agent commit/);
  });
});
