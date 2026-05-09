import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { runMerge } from '../../../src/merge/orchestrator.js';
import type { PrSubmitter } from '../../../src/merge/orchestrator.js';
import { planBranches } from '../../../src/git/branch-graph.js';
import { fakeResolved } from '../../helpers/plan.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';

describe('runMerge: pr policy with a fake submitter', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it("delegates `merge: pr` tasks to the submitter and doesn't merge them locally", async () => {
    repo = createTestRepo();
    const { plan } = fakeResolved({
      plan: { name: 'pp' },
      tasks: [
        { id: 'p1', title: 'P1', agent: 'claude-code', prompt: 'p', merge: 'pr' },
        { id: 'a1', title: 'A1', agent: 'claude-code', prompt: 'p' },
      ],
    });

    // Build empty branches at HEAD so merges that *do* happen work without conflicts.
    const { execa } = await import('execa');
    await execa('git', ['branch', 'pp/p1', 'main'], { cwd: repo.path });
    await execa('git', ['branch', 'pp/a1', 'main'], { cwd: repo.path });
    // Add a real change on a1 so something is mergeable.
    await execa('git', ['checkout', 'pp/a1'], { cwd: repo.path });
    writeFileSync(`${repo.path}/a1.txt`, 'a1\n');
    repo.commit('a1 commit');
    await execa('git', ['checkout', 'main'], { cwd: repo.path });

    const calls: { id: string; branch: string }[] = [];
    const fakeSubmitter: PrSubmitter = {
      async submit(task, branch) {
        calls.push({ id: task.id, branch });
        return { url: `https://example.test/pr/${task.id}` };
      },
    };

    const out = await runMerge({
      runId: 'r',
      plan,
      branchPlan: planBranches(plan),
      baseBranch: 'main',
      rootDir: repo.path,
      policy: { onConflict: 'manual' },
      completedTaskIds: ['p1', 'a1'],
      prSubmitter: fakeSubmitter,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe('p1');
    expect(out.pr.find((p) => p.taskId === 'p1')?.url).toBe('https://example.test/pr/p1');
    expect(out.merged).toContain('a1');
    expect(out.merged).not.toContain('p1');
  });
});
