import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { WorktreeManager } from '../../../src/git/worktree-manager.js';
import { git } from '../../../src/git/git.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';

describe('WorktreeManager.remove', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('is idempotent', async () => {
    repo = createTestRepo();
    const mgr = new WorktreeManager({ git, rootDir: repo.path, worktreeRoot: '.yaao/worktrees' });
    const wt = await mgr.create({
      runId: 'r',
      taskId: 'a',
      branch: 'b/a',
      baseBranch: 'main',
      parentBranches: [],
      rootDir: repo.path,
      worktreeRoot: '.yaao/worktrees',
    });
    expect(existsSync(wt.path)).toBe(true);
    await mgr.remove('a', { force: true, deleteBranch: true });
    expect(existsSync(wt.path)).toBe(false);
    // second remove is a no-op (no throw)
    await expect(mgr.remove('a', { force: true })).resolves.toBeUndefined();
  });
});
