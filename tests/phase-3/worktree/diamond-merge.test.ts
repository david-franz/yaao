import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorktreeManager } from '../../../src/git/worktree-manager.js';
import { git } from '../../../src/git/git.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';

describe('WorktreeManager: diamond merges', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('merges multiple parents cleanly', async () => {
    repo = createTestRepo();
    // Build two non-conflicting branches
    repo.run(['checkout', '-q', '-b', 'p/one']);
    repo.write('one.txt', 'one\n');
    repo.commit('add one');
    repo.run(['checkout', '-q', 'main']);
    repo.run(['checkout', '-q', '-b', 'p/two']);
    repo.write('two.txt', 'two\n');
    repo.commit('add two');
    repo.run(['checkout', '-q', 'main']);

    const mgr = new WorktreeManager({ git, rootDir: repo.path, worktreeRoot: '.yaao/worktrees' });
    const wt = await mgr.create({
      runId: 'r',
      taskId: 'd',
      branch: 'p/d',
      baseBranch: 'p/one',
      parentBranches: ['p/two'],
      rootDir: repo.path,
      worktreeRoot: '.yaao/worktrees',
    });
    expect(existsSync(join(wt.path, 'one.txt'))).toBe(true);
    expect(existsSync(join(wt.path, 'two.txt'))).toBe(true);
    expect(readFileSync(join(wt.path, 'two.txt'), 'utf8')).toBe('two\n');
  });
});
