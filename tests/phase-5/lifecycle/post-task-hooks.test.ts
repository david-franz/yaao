import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';

describe('plan.config.hooks.post-task', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('runs every post-task hook after the task validation; passes when all green', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: ph\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'ph' },
      config: {
        hooks: {
          'post-task': [
            { command: 'echo typecheck-ran > typecheck.txt' },
            { command: 'echo lint-ran > lint.txt' },
          ],
        },
      },
      tasks: [{ id: 'a', title: 'A', agent: 'claude-code', prompt: 'p' }],
    });

    const backend = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
    const wrap = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof target.spawn>[0]) => {
            // Touch a file so commitIfDirty has something to commit.
            writeFileSync(join(opts.cwd, 'a.txt'), 'hi');
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const result = await runPlan({
      requireTrackedPlan: 'off',
      runId: 'r1',
      plan,
      planFile,
      rootDir: repo.path,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => wrap,
    });
    expect(result.status).toBe('success');

    // Hooks ran inside the worktree (their output is on the task's branch).
    const { execaSync } = await import('execa');
    const log = execaSync('git', ['log', '-p', '-1', '--name-only', 'ph/a'], { cwd: repo.path }).stdout;
    expect(log).toContain('typecheck.txt');
    expect(log).toContain('lint.txt');
  });

  it('a failing must-pass hook fails the task with the hook output captured', async () => {
    repo = createTestRepo();
    const planFile = join(repo.path, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: phf\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'phf' },
      config: {
        hooks: {
          'post-task': [
            { command: 'sh -c "echo lint-broken >&2; exit 1"' },
          ],
        },
      },
      // retries: 0 so the test sees the failure rather than the retry pass.
      tasks: [{ id: 'a', title: 'A', agent: 'claude-code', prompt: 'p', retries: 0 }],
    });
    const backend = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
    const wrap = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof target.spawn>[0]) => {
            writeFileSync(join(opts.cwd, 'a.txt'), 'hi');
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const failures: { msg: string; stderrTail?: string }[] = [];
    const result = await runPlan({
      requireTrackedPlan: 'off',
      runId: 'r1',
      plan,
      planFile,
      rootDir: repo.path,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => wrap,
      onProgress: (ev) => {
        if (ev.type === 'task:failed') {
          const err = ev.error as unknown as { stderrTail?: string };
          failures.push({
            msg: ev.error.message,
            ...(err.stderrTail !== undefined ? { stderrTail: err.stderrTail } : {}),
          });
        }
      },
    });
    expect(result.status).toBe('failed');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.msg).toMatch(/post-task hook failed/);
    expect(failures[0]?.stderrTail ?? '').toMatch(/lint-broken/);
  });
});
