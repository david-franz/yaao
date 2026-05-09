import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { runMerge } from '../../../src/merge/orchestrator.js';
import { planBranches } from '../../../src/git/branch-graph.js';
import { git } from '../../../src/git/git.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';

async function checkout(repo: TestRepo, branch: string): Promise<void> {
  const { execa } = await import('execa');
  await execa('git', ['checkout', branch], { cwd: repo.path });
}

describe('runMerge: conflict blocks downstream', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it("a conflict on 'bad' blocks its downstream 'child' but lets independent 'indep' through", async () => {
    repo = createTestRepo();
    const { plan } = fakeResolved({
      plan: { name: 'cb' },
      tasks: [
        { id: 'bad', title: 'Bad', agent: 'claude-code', prompt: 'p' },
        { id: 'child', title: 'Child', agent: 'claude-code', prompt: 'p', depends: ['bad'] },
        { id: 'indep', title: 'Indep', agent: 'claude-code', prompt: 'p' },
      ],
    });
    const bp = planBranches(plan);

    // main establishes shared.txt with one version.
    writeFileSync(`${repo.path}/shared.txt`, 'main wins\n');
    repo.commit('main writes shared.txt');

    // cb/bad is branched from main BEFORE the conflicting commit, then changes shared.txt.
    await git.createBranch('cb/bad', 'HEAD~1', repo.path);
    await checkout(repo, 'cb/bad');
    writeFileSync(`${repo.path}/shared.txt`, 'bad wins\n');
    repo.commit('bad writes shared.txt');
    await checkout(repo, 'main');

    await git.createBranch('cb/child', 'cb/bad', repo.path);
    await checkout(repo, 'cb/child');
    writeFileSync(`${repo.path}/child.txt`, 'child\n');
    repo.commit('child');
    await checkout(repo, 'main');

    await git.createBranch('cb/indep', 'main', repo.path);
    await checkout(repo, 'cb/indep');
    writeFileSync(`${repo.path}/indep.txt`, 'indep\n');
    repo.commit('indep');
    await checkout(repo, 'main');

    const out = await runMerge({
      runId: 'r1',
      plan,
      branchPlan: bp,
      baseBranch: 'main',
      rootDir: repo.path,
      policy: { onConflict: 'manual' },
      completedTaskIds: ['bad', 'child', 'indep'],
    });
    expect(out.merged).toContain('indep');
    expect(out.conflicts.find((c) => c.taskId === 'bad')).toBeDefined();
    expect(out.skipped.find((s) => s.taskId === 'child')).toBeDefined();
  });
});
