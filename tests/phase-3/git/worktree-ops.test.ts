import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../../../src/git/git.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';

describe('git worktree operations', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('adds and removes a worktree', async () => {
    repo = createTestRepo();
    await git.createBranch('wt/a', 'main', repo.path);
    const wtPath = join(repo.path, '.yaao', 'worktrees', 'a');
    await git.worktreeAdd(wtPath, 'wt/a', repo.path);
    expect(existsSync(wtPath)).toBe(true);
    const list = await git.worktreeList(repo.path);
    expect(list.find((w) => w.branch === 'wt/a')).toBeDefined();
    await git.worktreeRemove(wtPath, { force: true }, repo.path);
    expect(existsSync(wtPath)).toBe(false);
  });
});
