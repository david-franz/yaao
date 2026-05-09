import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { runMerge } from '../../../src/merge/orchestrator.js';
import { planBranches } from '../../../src/git/branch-graph.js';
import { git } from '../../../src/git/git.js';
import { AgentConflictResolver } from '../../../src/merge/conflict.js';
import { FakeBackend } from '../../../src/agents/fake.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';
import type { AgentBackend } from '../../../src/agents/backend.js';

describe('agent conflict mode: success path', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('agent rewrites the conflicted file and the resolver commits the result', async () => {
    repo = createTestRepo();
    writeFileSync(`${repo.path}/x.txt`, 'main\n');
    repo.commit('add x');
    await git.createBranch('agg/a', 'HEAD~1', repo.path);
    const { execa } = await import('execa');
    await execa('git', ['checkout', 'agg/a'], { cwd: repo.path });
    writeFileSync(`${repo.path}/x.txt`, 'a\n');
    repo.commit('a writes x');
    await execa('git', ['checkout', 'main'], { cwd: repo.path });

    const inner = new FakeBackend({ events: [{ type: 'stdout', data: 'fixing\n' }] });
    // Wrap so the "agent" actually rewrites the conflicted file to a clean state.
    const agentBackend: AgentBackend = new Proxy(inner, {
      get(target, prop) {
        if (prop === 'spawn') {
          return async (opts: Parameters<typeof inner.spawn>[0]) => {
            writeFileSync(`${opts.cwd}/x.txt`, 'merged\n');
            return target.spawn(opts);
          };
        }
        return Reflect.get(target, prop) as unknown;
      },
    });

    const { plan } = fakeResolved({
      plan: { name: 'agg' },
      tasks: [{ id: 'a', title: 'A', agent: 'claude-code', prompt: 'p' }],
    });
    const out = await runMerge({
      runId: 'r',
      plan,
      branchPlan: planBranches(plan),
      baseBranch: 'main',
      rootDir: repo.path,
      policy: { onConflict: 'agent' },
      completedTaskIds: ['a'],
      resolver: new AgentConflictResolver({ backend: agentBackend, maxLines: 50 }),
    });
    expect(out.merged).toContain('a');
    expect(out.conflicts).toEqual([]);
  });
});
