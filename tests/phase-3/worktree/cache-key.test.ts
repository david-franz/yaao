import { describe, it, expect, afterEach } from 'vitest';
import {
  WorktreeManager,
  hashKey,
  dependsHash,
  type WorktreeStampKey,
} from '../../../src/git/worktree-manager.js';
import { git } from '../../../src/git/git.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';

describe('WorktreeManager composite-key reuse', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('reuses a worktree when every key field matches', async () => {
    repo = createTestRepo();
    const mgr = new WorktreeManager({ git, rootDir: repo.path, worktreeRoot: '.yaao/worktrees' });
    const key: WorktreeStampKey = {
      planName: 'plan-a',
      taskId: 't',
      promptHash: hashKey('prompt body'),
      dependsHash: dependsHash([]),
    };
    const created = await mgr.create({
      runId: 'run-1',
      taskId: 't',
      branch: 'plan-a/t',
      baseBranch: 'main',
      parentBranches: [],
      rootDir: repo.path,
      worktreeRoot: '.yaao/worktrees',
      planName: key.planName,
      promptHash: key.promptHash,
      dependsHash: key.dependsHash,
    });
    // Fresh manager (no in-memory state) — must still find the stamp on disk.
    const fresh = new WorktreeManager({ git, rootDir: repo.path, worktreeRoot: '.yaao/worktrees' });
    const found = await fresh.get(key);
    expect(found?.path).toBe(created.path);
    expect(found?.sourceRunId).toBe('run-1');
  });

  it('refuses to reuse across plans when only the taskId matches', async () => {
    repo = createTestRepo();
    const mgr = new WorktreeManager({ git, rootDir: repo.path, worktreeRoot: '.yaao/worktrees' });
    // Plan A leaves a worktree stamped with planName='timer-pit'.
    await mgr.create({
      runId: 'run-prev',
      taskId: 'kernel-wireup',
      branch: 'timer-pit/kernel-wireup',
      baseBranch: 'main',
      parentBranches: [],
      rootDir: repo.path,
      worktreeRoot: '.yaao/worktrees',
      planName: 'timer-pit',
      promptHash: hashKey('wire timer_init'),
      dependsHash: dependsHash([]),
    });
    // Plan B looks up by its OWN key (same taskId, different plan + prompt).
    const fresh = new WorktreeManager({ git, rootDir: repo.path, worktreeRoot: '.yaao/worktrees' });
    const found = await fresh.get({
      planName: 'kheap',
      taskId: 'kernel-wireup',
      promptHash: hashKey('wire kheap_init'),
      dependsHash: dependsHash(['kheap-core']),
    });
    expect(found).toBeUndefined();
  });

  it('treats legacy stamps lacking key fields as no-match', async () => {
    repo = createTestRepo();
    const mgr = new WorktreeManager({ git, rootDir: repo.path, worktreeRoot: '.yaao/worktrees' });
    // Create a stamp with no key fields — what a worktree written by an older
    // build of yaao would look like on disk.
    await mgr.create({
      runId: 'run-legacy',
      taskId: 't',
      branch: 'plan-a/t',
      baseBranch: 'main',
      parentBranches: [],
      rootDir: repo.path,
      worktreeRoot: '.yaao/worktrees',
    });
    const fresh = new WorktreeManager({ git, rootDir: repo.path, worktreeRoot: '.yaao/worktrees' });
    const found = await fresh.get({
      planName: 'plan-a',
      taskId: 't',
      promptHash: hashKey('p'),
      dependsHash: dependsHash([]),
    });
    expect(found).toBeUndefined();
  });

  it('a prompt edit invalidates reuse (different promptHash → no match)', async () => {
    repo = createTestRepo();
    const mgr = new WorktreeManager({ git, rootDir: repo.path, worktreeRoot: '.yaao/worktrees' });
    await mgr.create({
      runId: 'run-1',
      taskId: 't',
      branch: 'plan-a/t',
      baseBranch: 'main',
      parentBranches: [],
      rootDir: repo.path,
      worktreeRoot: '.yaao/worktrees',
      planName: 'plan-a',
      promptHash: hashKey('original prompt'),
      dependsHash: dependsHash([]),
    });
    const fresh = new WorktreeManager({ git, rootDir: repo.path, worktreeRoot: '.yaao/worktrees' });
    const found = await fresh.get({
      planName: 'plan-a',
      taskId: 't',
      promptHash: hashKey('edited prompt'),
      dependsHash: dependsHash([]),
    });
    expect(found).toBeUndefined();
  });

  it('dependsHash is order-insensitive (canonicalised before hashing)', () => {
    expect(dependsHash(['a', 'b'])).toBe(dependsHash(['b', 'a']));
  });
});
