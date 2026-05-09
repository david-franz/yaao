import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { runMerge } from '../../../src/merge/orchestrator.js';
import { planBranches } from '../../../src/git/branch-graph.js';
import { git } from '../../../src/git/git.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';

describe('manual conflict mode', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('records the conflict and stops without leaving markers in the working tree', async () => {
    repo = createTestRepo();
    writeFileSync(`${repo.path}/x.txt`, 'main\n');
    repo.commit('add x');
    await git.createBranch('m/a', 'HEAD~1', repo.path);
    const { execa } = await import('execa');
    await execa('git', ['checkout', 'm/a'], { cwd: repo.path });
    writeFileSync(`${repo.path}/x.txt`, 'a\n');
    repo.commit('a writes x');
    await execa('git', ['checkout', 'main'], { cwd: repo.path });

    const { plan } = fakeResolved({
      plan: { name: 'm' },
      tasks: [{ id: 'a', title: 'A', agent: 'claude-code', prompt: 'p' }],
    });
    const out = await runMerge({
      runId: 'r',
      plan,
      branchPlan: planBranches(plan),
      baseBranch: 'main',
      rootDir: repo.path,
      policy: { onConflict: 'manual' },
      completedTaskIds: ['a'],
    });
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]?.mode).toBe('manual');
    // Ensure no merge in progress is left behind.
    const status = await git.status(repo.path);
    expect(status.files.length).toBe(0);
  });
});
