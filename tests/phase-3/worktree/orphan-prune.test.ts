import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { WorktreeManager } from '../../../src/git/worktree-manager.js';
import { git } from '../../../src/git/git.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';

describe('WorktreeManager.pruneOrphans', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('removes worktrees whose runId is not in the active set', async () => {
    repo = createTestRepo();
    const mgr = new WorktreeManager({ git, rootDir: repo.path, worktreeRoot: '.yaao/worktrees' });
    const wtOld = await mgr.create({
      runId: 'old-run',
      taskId: 'a',
      branch: 'b/a',
      baseBranch: 'main',
      parentBranches: [],
      rootDir: repo.path,
      worktreeRoot: '.yaao/worktrees',
    });
    const wtNew = await mgr.create({
      runId: 'new-run',
      taskId: 'b',
      branch: 'b/b',
      baseBranch: 'main',
      parentBranches: [],
      rootDir: repo.path,
      worktreeRoot: '.yaao/worktrees',
    });
    const removed = await mgr.pruneOrphans(new Set(['new-run']));
    expect(removed).toContain(wtOld.path);
    expect(existsSync(wtOld.path)).toBe(false);
    expect(existsSync(wtNew.path)).toBe(true);
  });
});
