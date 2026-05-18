import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execaSync } from 'execa';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';
import { loadRun } from '../../../src/git/journal.js';

describe('task:merge-failed is journaled', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it("writes the merge-failed outcome to the journal so it shows up in `yaao status`", async () => {
    repo = createTestRepo();
    const cwd = repo.path;
    const planFile = join(cwd, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: mf\n  version: 1\ntasks: []\n');

    // Create two sibling task branches that both modify the same file —
    // forces a conflict when the second tries to auto-merge to main.
    writeFileSync(join(cwd, 'shared.txt'), 'base\n');
    execaSync('git', ['add', 'shared.txt'], { cwd });
    execaSync('git', ['commit', '-m', 'base'], { cwd });

    const { plan } = fakeResolved({
      plan: { name: 'mf' },
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'p' },
        { id: 'b', title: 'B', agent: 'claude-code', prompt: 'p' },
      ],
    });

    const backend = new FakeBackend({ events: [{ type: 'stdout', data: 'ok' }] });
    const wrap = new Proxy(backend, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof target.spawn>[0]) => {
            // Both tasks rewrite shared.txt differently — both end up
            // wanting to merge a divergent change to main.
            const name = opts.cwd.split('/').pop();
            writeFileSync(join(opts.cwd, 'shared.txt'), `from-${name}\n`);
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    await runPlan({
      runId: 'rmf',
      plan,
      planFile,
      rootDir: cwd,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => wrap,
    });

    // Second sibling's outgoing merge should have conflicted.
    const { summary } = await loadRun('rmf', join(cwd, '.yaao', 'runs'));
    const mergeFailed = Object.values(summary.tasks).filter(
      (t) => t.mergeStatus === 'merge-failed',
    );
    const merged = Object.values(summary.tasks).filter((t) => t.mergeStatus === 'merged');
    expect(merged.length).toBeGreaterThan(0);
    expect(mergeFailed.length).toBeGreaterThan(0);
    expect(mergeFailed[0]?.mergeInto).toBe('main');
    expect((mergeFailed[0]?.mergeConflicts ?? []).length).toBeGreaterThan(0);
  });
});
