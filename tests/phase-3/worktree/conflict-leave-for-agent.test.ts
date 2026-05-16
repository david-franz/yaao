import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execaSync } from 'execa';
import { WorktreeManager } from '../../../src/git/worktree-manager.js';
import { git } from '../../../src/git/git.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';

describe('WorktreeManager onConflict: leave-for-agent', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('leaves conflict markers in place and reports the conflicting files', async () => {
    repo = createTestRepo();
    const cwd = repo.path;

    // Create two divergent branches both touching the same file, mergeable
    // together only with conflicts.
    writeFileSync(join(cwd, 'shared.txt'), 'base\n');
    execaSync('git', ['add', 'shared.txt'], { cwd });
    execaSync('git', ['commit', '-m', 'base'], { cwd });

    execaSync('git', ['checkout', '-b', 'parent-a'], { cwd });
    writeFileSync(join(cwd, 'shared.txt'), 'branch-a\n');
    execaSync('git', ['commit', '-am', 'edit a'], { cwd });

    execaSync('git', ['checkout', 'main'], { cwd });
    execaSync('git', ['checkout', '-b', 'parent-b'], { cwd });
    writeFileSync(join(cwd, 'shared.txt'), 'branch-b\n');
    execaSync('git', ['commit', '-am', 'edit b'], { cwd });
    execaSync('git', ['checkout', 'main'], { cwd });

    const manager = new WorktreeManager({ git, rootDir: cwd, worktreeRoot: '.yaao/worktrees' });
    const wt = await manager.create({
      runId: 'rconf',
      taskId: 'merger',
      branch: 'plan/merger',
      baseBranch: 'parent-a',
      parentBranches: ['parent-b'],
      rootDir: cwd,
      worktreeRoot: '.yaao/worktrees',
      onConflict: 'leave-for-agent',
    });

    // Worktree should still exist (not torn down) and report conflicts.
    expect(existsSync(wt.path)).toBe(true);
    expect(wt.unresolvedConflicts).toEqual(['shared.txt']);
    expect(wt.conflictingParent).toBe('parent-b');
    // The conflict markers should be in the file so an agent can resolve.
    const conflicted = readFileSync(join(wt.path, 'shared.txt'), 'utf8');
    expect(conflicted).toContain('<<<<<<<');
    expect(conflicted).toContain('=======');
    expect(conflicted).toContain('>>>>>>>');
  });
});
