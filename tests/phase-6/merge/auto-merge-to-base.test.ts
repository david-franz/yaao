import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execaSync } from 'execa';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';

describe('merge.strategy: auto', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('lands each completed task on base-branch when strategy is auto', async () => {
    repo = createTestRepo();
    const cwd = repo.path;
    const planFile = join(cwd, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: am\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'am' },
      // DEFAULT_CONFIG already sets merge.strategy = 'auto'.
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'p' },
        { id: 'b', title: 'B', agent: 'claude-code', depends: ['a'], prompt: 'p' },
      ],
    });

    const backend = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
    const wrap = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof target.spawn>[0]) => {
            const name = opts.cwd.split('/').pop();
            writeFileSync(join(opts.cwd, `${name}.txt`), `${name}\n`);
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const result = await runPlan({
      runId: 'ram',
      plan,
      planFile,
      rootDir: cwd,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => wrap,
    });
    expect(result.status).toBe('success');

    // Both task files should be on main (auto-merged).
    const filesOnMain = execaSync('git', ['ls-tree', '-r', '--name-only', 'main'], { cwd }).stdout;
    expect(filesOnMain).toContain('a.txt');
    expect(filesOnMain).toContain('b.txt');
    // The merge commits should appear in main's log with a clear subject.
    const log = execaSync('git', ['log', '--format=%s', 'main'], { cwd }).stdout;
    expect(log).toMatch(/Merge am\/a into main/);
    expect(log).toMatch(/Merge am\/b into main/);
  });

  it('manual strategy leaves base-branch untouched', async () => {
    repo = createTestRepo();
    const cwd = repo.path;
    const planFile = join(cwd, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: am2\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'am2' },
      config: { merge: { strategy: 'manual' } },
      tasks: [{ id: 'a', title: 'A', agent: 'claude-code', prompt: 'p' }],
    });
    const backend = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
    const wrap = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof target.spawn>[0]) => {
            writeFileSync(join(opts.cwd, 'a.txt'), 'a\n');
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const result = await runPlan({
      runId: 'ram2',
      plan,
      planFile,
      rootDir: cwd,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => wrap,
    });
    expect(result.status).toBe('success');
    const filesOnMain = execaSync('git', ['ls-tree', '-r', '--name-only', 'main'], { cwd }).stdout;
    expect(filesOnMain).not.toContain('a.txt');
  });
});
