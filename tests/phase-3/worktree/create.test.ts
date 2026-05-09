import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorktreeManager } from '../../../src/git/worktree-manager.js';
import { git } from '../../../src/git/git.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';

describe('WorktreeManager.create', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('creates a worktree on a new branch from main', async () => {
    repo = createTestRepo();
    const mgr = new WorktreeManager({ git, rootDir: repo.path, worktreeRoot: '.yaao/worktrees' });
    const wt = await mgr.create({
      runId: 'run-1',
      taskId: 'scaffold',
      branch: 'oauth/scaffold',
      baseBranch: 'main',
      parentBranches: [],
      rootDir: repo.path,
      worktreeRoot: '.yaao/worktrees',
    });
    expect(existsSync(wt.path)).toBe(true);
    const stamp = JSON.parse(
      readFileSync(join(wt.path, '.yaao', '.task'), 'utf8'),
    ) as { runId: string; taskId: string; branch: string };
    expect(stamp.runId).toBe('run-1');
    expect(stamp.taskId).toBe('scaffold');
    expect(stamp.branch).toBe('oauth/scaffold');
    expect((await mgr.list()).length).toBe(1);
  });
});
