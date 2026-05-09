import { describe, it, expect, afterEach } from 'vitest';
import { git } from '../../../src/git/git.js';
import { createTestRepo, type TestRepo } from '../../helpers/repo.js';

describe('git branch operations (integration)', () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it('creates and detects a branch', async () => {
    repo = createTestRepo();
    await git.createBranch('feature/x', 'main', repo.path);
    expect(await git.branchExists('feature/x', repo.path)).toBe(true);
    expect(await git.branchExists('not-here', repo.path)).toBe(false);
  });

  it('deletes a branch', async () => {
    repo = createTestRepo();
    await git.createBranch('feature/y', 'main', repo.path);
    await git.deleteBranch('feature/y', { force: true }, repo.path);
    expect(await git.branchExists('feature/y', repo.path)).toBe(false);
  });

  it('reports rootDir and isRepo', async () => {
    repo = createTestRepo();
    expect(await git.isRepo(repo.path)).toBe(true);
    const root = await git.rootDir(repo.path);
    // macOS prefixes /private to tmpdir paths; either form is acceptable.
    expect(root === repo.path || root === `/private${repo.path}`).toBe(true);
  });

  it('reports the current branch', async () => {
    repo = createTestRepo();
    expect(await git.currentBranch(repo.path)).toBe('main');
  });
});
