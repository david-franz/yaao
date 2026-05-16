import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execaSync } from 'execa';
import { runPlan } from '../../../src/exec/runner.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import { FakeBackend } from '../../../src/agents/fake.js';

describe('merge.history: rebase', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('lands tasks on base-branch via rebase, producing a linear history with no merge commits', async () => {
    repo = createTestRepo();
    const cwd = repo.path;
    const planFile = join(cwd, 'plan.yaml');
    writeFileSync(planFile, 'plan:\n  name: rb\n  version: 1\ntasks: []\n');
    const { plan } = fakeResolved({
      plan: { name: 'rb' },
      config: { merge: { history: 'rebase' } },
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
      runId: 'rrb',
      plan,
      planFile,
      rootDir: cwd,
      config: (await import('../../../src/config/types.js')).DEFAULT_CONFIG,
      backendFor: () => wrap,
    });
    expect(result.status).toBe('success');

    // Both task files are on main.
    const filesOnMain = execaSync('git', ['ls-tree', '-r', '--name-only', 'main'], { cwd }).stdout;
    expect(filesOnMain).toContain('a.txt');
    expect(filesOnMain).toContain('b.txt');

    // No merge commits — every commit has exactly one parent.
    const parentCounts = execaSync('git', ['log', '--format=%P', 'main'], { cwd })
      .stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.trim().split(/\s+/).length);
    // Initial commit has 0 parents; everything else 1; nothing 2.
    expect(parentCounts.some((c) => c === 2)).toBe(false);

    // Task commit subjects should appear in main's history (replayed).
    const log = execaSync('git', ['log', '--format=%s', 'main'], { cwd }).stdout;
    expect(log).toMatch(/\[a\] A/);
    expect(log).toMatch(/\[b\] B/);
  });
});
