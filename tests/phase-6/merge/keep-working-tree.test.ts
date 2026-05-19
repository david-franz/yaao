import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execaSync } from 'execa';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';

describe('auto-merge keeps the root working tree in sync', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  /**
   * Regression for the case where update-ref advanced main to a commit with
   * project files, but the user's working tree at the repo root stayed
   * empty — `git status` then reported every file as a staged deletion. The
   * fix routes the ref advance through `git reset --keep` when the target
   * is the cwd's current branch, so head + index + working tree move
   * together.
   */
  it('files committed via auto-merge appear in the root working tree, not as staged deletions', async () => {
    repo = createTestRepo();
    const cwd = repo.path;
    const planFile = join(cwd, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: kw\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'kw' },
      // Default merge.strategy is 'auto' — task's branch lands on main.
      tasks: [{ id: 'a', title: 'A', agent: 'claude-code', prompt: 'p' }],
    });

    const backend = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
    const wrap = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof target.spawn>[0]) => {
            writeFileSync(join(opts.cwd, 'made-by-agent.txt'), 'hi\n');
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const result = await runPlan({
      requireTrackedPlan: 'off',
      runId: 'rkw',
      plan,
      planFile,
      rootDir: cwd,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => wrap,
    });
    expect(result.status).toBe('success');

    // The file the agent created should be on disk at the repo root.
    expect(existsSync(join(cwd, 'made-by-agent.txt'))).toBe(true);

    // And `git status` should have no "staged deletion" smear — the original
    // bug shape. Untracked files (plan.yaml, .yaao/) are fine; we only care
    // that no tracked files are reported as deleted.
    const status = execaSync('git', ['status', '--short'], { cwd }).stdout;
    const deletions = status
      .split('\n')
      .filter((l) => /^[DA-Z][D ]\s/.test(l));
    expect(deletions).toEqual([]);
  });

  it('rebase mode also keeps the root working tree in sync', async () => {
    repo = createTestRepo();
    const cwd = repo.path;
    const planFile = join(cwd, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: kwr\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'kwr' },
      config: { merge: { history: 'rebase' } },
      tasks: [{ id: 'a', title: 'A', agent: 'claude-code', prompt: 'p' }],
    });
    const backend = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
    const wrap = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof target.spawn>[0]) => {
            writeFileSync(join(opts.cwd, 'rebased.txt'), 'hi\n');
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const result = await runPlan({
      requireTrackedPlan: 'off',
      runId: 'rkwr',
      plan,
      planFile,
      rootDir: cwd,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => wrap,
    });
    expect(result.status).toBe('success');
    expect(existsSync(join(cwd, 'rebased.txt'))).toBe(true);
    const status = execaSync('git', ['status', '--short'], { cwd }).stdout;
    const deletions = status.split('\n').filter((l) => /^[DA-Z][D ]\s/.test(l));
    expect(deletions).toEqual([]);
  });
});
