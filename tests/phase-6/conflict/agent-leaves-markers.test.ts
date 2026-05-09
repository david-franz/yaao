import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { runMerge } from '../../../src/merge/orchestrator.js';
import { planBranches } from '../../../src/git/branch-graph.js';
import { git } from '../../../src/git/git.js';
import { AgentConflictResolver } from '../../../src/merge/conflict.js';
import { FakeBackend } from '../../../src/agents/fake.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';

describe('agent conflict mode: agent leaves markers', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('rejects the resolution when conflict markers remain', async () => {
    repo = createTestRepo();
    writeFileSync(`${repo.path}/x.txt`, 'main\n');
    repo.commit('add x');
    await git.createBranch('agm/a', 'HEAD~1', repo.path);
    const { execa } = await import('execa');
    await execa('git', ['checkout', 'agm/a'], { cwd: repo.path });
    writeFileSync(`${repo.path}/x.txt`, 'a\n');
    repo.commit('a writes x');
    await execa('git', ['checkout', 'main'], { cwd: repo.path });

    // Agent that does nothing — markers stay.
    const lazy = new FakeBackend({ events: [{ type: 'stdout', data: 'idle' }] });

    const { plan } = fakeResolved({
      plan: { name: 'agm' },
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
      resolver: new AgentConflictResolver({ backend: lazy }),
    });
    expect(out.conflicts).toHaveLength(1);
    expect(out.merged).toEqual([]);
  });
});
