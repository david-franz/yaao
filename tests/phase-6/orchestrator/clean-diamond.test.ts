import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { runMerge } from '../../../src/merge/orchestrator.js';
import { planBranches } from '../../../src/git/branch-graph.js';
import { git } from '../../../src/git/git.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';

async function buildBranch(repo: TestRepo, branch: string, base: string, files: { name: string; contents: string }[]): Promise<void> {
  await git.createBranch(branch, base, repo.path);
  const { execa } = await import('execa');
  await execa('git', ['checkout', branch], { cwd: repo.path });
  for (const f of files) writeFileSync(`${repo.path}/${f.name}`, f.contents);
  repo.commit(`commit on ${branch}`);
  await execa('git', ['checkout', base], { cwd: repo.path });
}

describe('runMerge: clean diamond', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('produces three merge commits in topological order', async () => {
    repo = createTestRepo();
    const { plan } = fakeResolved({
      plan: { name: 'cd' },
      tasks: [
        { id: 'a', title: 'A', agent: 'claude-code', prompt: 'p' },
        { id: 'b', title: 'B', agent: 'claude-code', prompt: 'p', depends: ['a'] },
        { id: 'c', title: 'C', agent: 'claude-code', prompt: 'p', depends: ['a'] },
        { id: 'd', title: 'D', agent: 'claude-code', prompt: 'p', depends: ['b', 'c'] },
      ],
    });
    const bp = planBranches(plan);
    // Build branches that map to the resolved branch names.
    await buildBranch(repo, 'cd/a', 'main', [{ name: 'a.txt', contents: 'A' }]);
    await buildBranch(repo, 'cd/b', 'cd/a', [{ name: 'b.txt', contents: 'B' }]);
    await buildBranch(repo, 'cd/c', 'cd/a', [{ name: 'c.txt', contents: 'C' }]);
    await buildBranch(repo, 'cd/d', 'cd/b', [{ name: 'd.txt', contents: 'D' }]);

    const out = await runMerge({
      runId: 'r1',
      plan,
      branchPlan: bp,
      baseBranch: 'main',
      rootDir: repo.path,
      policy: { onConflict: 'manual' },
      completedTaskIds: ['a', 'b', 'c', 'd'],
    });
    expect(out.merged.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(out.conflicts).toEqual([]);
    expect(out.finalCommit.length).toBeGreaterThan(0);
  });
});
