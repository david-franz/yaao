import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { WorktreeManager } from '../../../src/git/worktree-manager.js';
import { git } from '../../../src/git/git.js';
import { WorktreeMergeError } from '../../../src/log/errors.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';

describe('WorktreeManager: conflicting parents', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('raises WorktreeMergeError and tears down on conflict', async () => {
    repo = createTestRepo();
    repo.write('shared.txt', 'baseline\n');
    repo.commit('baseline');
    repo.run(['checkout', '-q', '-b', 'p/one']);
    repo.write('shared.txt', 'one\n');
    repo.commit('one');
    repo.run(['checkout', '-q', 'main']);
    repo.run(['checkout', '-q', '-b', 'p/two']);
    repo.write('shared.txt', 'two\n');
    repo.commit('two');
    repo.run(['checkout', '-q', 'main']);

    const mgr = new WorktreeManager({ git, rootDir: repo.path, worktreeRoot: '.yaao/worktrees' });
    let err: WorktreeMergeError | undefined;
    try {
      await mgr.create({
        runId: 'r',
        taskId: 'd',
        branch: 'p/d',
        baseBranch: 'p/one',
        parentBranches: ['p/two'],
        rootDir: repo.path,
        worktreeRoot: '.yaao/worktrees',
      });
    } catch (e) {
      err = e as WorktreeMergeError;
    }
    expect(err).toBeInstanceOf(WorktreeMergeError);
    expect(err?.conflicts).toContain('shared.txt');
    // The half-merged worktree should have been removed.
    expect(existsSync(err?.path ?? '')).toBe(false);
    // The branch should have been deleted too, so list shows nothing.
    expect((await mgr.list()).length).toBe(0);
  });
});
